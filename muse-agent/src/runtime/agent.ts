import type { AgentConfig } from "../config.js";
import {
  classifyRejection,
  idempotencyKeyFor,
  type InvocationRequest,
  type InvokeResult,
  type RouterApi,
} from "../backend/client.js";
import { parseMention, type CommandInvocation } from "../command/parse.js";
import { intakeOf } from "../command/registry.js";
import { runBackfill } from "../ingest/backfill.js";
import { PostFetcher } from "../ingest/fetcher.js";
import {
  advanceWatermark,
  detectGap,
  isKnown,
  markPoisoned,
  pendingRecords,
  pruneRecords,
  recordPost,
  updateRecord,
  type AgentState,
  type IngestSource,
  type PostRecord,
} from "../ingest/state.js";
import type { StateStore } from "../ingest/store.js";
import type { MusebookClient } from "../musebook/client.js";
import { isKeylessIdentityId, type MusebookPost } from "../musebook/types.js";
import { AckService, type AckKind, type AckTier } from "../reply/ack.js";
import { BoardBudget, type WritePriority } from "../reply/budget.js";
import {
  renderAddressEcho,
  renderAddressRejection,
  renderNearMissCorrection,
  renderPayoutProof,
  renderReleaseCaveat,
  renderSiteRejection,
  renderSiteReply,
  type ReplyContext,
} from "../reply/receipt.js";
import type { Logger } from "./logger.js";

/** The inbox returns 50 at a time and offers no cursor. */
const INBOX_PAGE_SIZE = 50;

export interface AgentDeps {
  config: AgentConfig;
  musebook: MusebookClient;
  router: RouterApi;
  store: StateStore;
  logger: Logger;
  now?: () => number;
}

export interface TickSummary {
  mentions: number;
  processed: number;
  executed: number;
  rejected: number;
  ignored: number;
  abandoned: number;
  backfilled: number;
  watermark: number;
  budgetRemaining: number;
}

/**
 * The family agent, modelled on bankrbot: get mentioned, read the request,
 * pre-validate it, send it to the site, acknowledge the result publicly.
 *
 * It relays; it never decides. No authorization, no escrow, no deadline math,
 * no hashing, no outcome wording for anything consequential. That matters
 * beyond tidiness: this process feeds attacker-controlled text from a public
 * board into a parser, so prompt injection against it has to be a non-event —
 * and it is, because there is no authority here to hijack.
 */
export class Agent {
  private readonly config: AgentConfig;
  private readonly musebook: MusebookClient;
  private readonly router: RouterApi;
  private readonly store: StateStore;
  private readonly logger: Logger;
  private readonly now: () => number;
  private state!: AgentState;
  private fetcher!: PostFetcher;
  private budget!: BoardBudget;
  private ack!: AckService;
  private stopping = false;

  constructor(deps: AgentDeps) {
    this.config = deps.config;
    this.musebook = deps.musebook;
    this.router = deps.router;
    this.store = deps.store;
    this.logger = deps.logger;
    this.now = deps.now ?? Date.now;
  }

  get currentState(): AgentState {
    return this.state;
  }

  get boardBudget(): BoardBudget {
    return this.budget;
  }

  async init(): Promise<void> {
    this.state = await this.store.load();
    this.fetcher = new PostFetcher({
      client: this.musebook,
      logger: this.logger,
      isPoisoned: (postId) => this.state.poisonedPostIds.includes(postId),
      onPoisoned: (postId) => markPoisoned(this.state, postId),
    });
    this.budget = new BoardBudget(this.state.boardBudget, {
      capacityPerHour: this.config.boardWritesPerHour,
      reactionsCountAgainstBudget: this.config.reactionsCountAgainstBudget,
      now: this.now,
    });
    this.ack = new AckService({
      musebook: this.musebook,
      budget: this.budget,
      displayName: this.config.displayName,
      logger: this.logger,
      dryRun: this.config.dryRun,
      alreadyReacted: (postId, emoji) => (this.state.reactions[String(postId)] ?? []).includes(emoji),
      onReacted: (postId, emoji) => {
        const key = String(postId);
        const placed = this.state.reactions[key] ?? [];
        if (!placed.includes(emoji)) this.state.reactions[key] = [...placed, emoji];
      },
    });

    this.logger.info("agent ready", {
      family: this.config.family.id,
      handle: this.config.displayName,
      museId: this.config.museId ?? "(unregistered)",
      watermark: this.state.watermark,
      dryRun: this.config.dryRun,
      boardBudget: this.budget.snapshot(),
    });
    if (this.budget.reactionsAreCharged) {
      this.logger.warn(
        "assuming reactions count against the 20/hour board write limit (unverified). " +
          "Set MUSE_AGENT_REACTIONS_COUNT_AGAINST_BUDGET=false once the test in docs/muse-agent.md confirms otherwise.",
      );
    }
  }

  stop(): void {
    this.stopping = true;
  }

  /** Nudge from the WebSocket accelerator. Polling remains the source of truth. */
  noteLivePost(postId: number, channel: string | null): void {
    if (!this.state || isKnown(this.state, postId)) return;
    this.state.highestSeenId = Math.max(this.state.highestSeenId, postId);
    this.logger.debug("live event noted", { postId, channel });
  }

  async runForever(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.tick();
      } catch (cause) {
        this.logger.error("tick failed", { error: String(cause) });
      }
      await this.sleep(this.config.pollIntervalMs);
    }
  }

  async tick(): Promise<TickSummary> {
    const summary: TickSummary = {
      mentions: 0,
      processed: 0,
      executed: 0,
      rejected: 0,
      ignored: 0,
      abandoned: 0,
      backfilled: 0,
      watermark: this.state.watermark,
      budgetRemaining: this.budget.remaining(),
    };

    summary.mentions = await this.drainInbox();

    if (this.state.gap) {
      const result = await runBackfill(this.state, this.fetcher, {
        budget: this.config.backfillBudget,
        logger: this.logger,
        isInteresting: (post) => this.mentionsUs(post),
      });
      summary.backfilled = result.queued;
      await this.persist();
    }

    for (const record of pendingRecords(this.state, this.now())) {
      if (this.stopping) break;
      const outcome = await this.processRecord(record);
      summary.processed += 1;
      if (outcome === "done") summary.executed += 1;
      else if (outcome === "rejected") summary.rejected += 1;
      else if (outcome === "ignored") summary.ignored += 1;
      else if (outcome === "abandoned") summary.abandoned += 1;
      await this.persist();
    }

    // Write a watermark on every cycle, including empty ones: a "nothing
    // happened" with a timestamp is a live run, one without is
    // indistinguishable from a dead process.
    this.state.lastPollAt = new Date().toISOString();
    summary.watermark = advanceWatermark(this.state);
    summary.budgetRemaining = this.budget.remaining();
    pruneRecords(this.state);
    this.pruneReactions();
    await this.persist();

    this.logger.info("tick", { ...summary });
    return summary;
  }

  /**
   * Read the inbox and durably record it before touching anything.
   *
   * Fetching marks every entry read, so musebook's own unread flag is gone the
   * instant this returns. This is the one place where a crash loses data
   * permanently, which is why the write happens first.
   */
  private async drainInbox(): Promise<number> {
    const page = await this.musebook.getMentions();
    if (page.mentions.length === 0) {
      this.logger.debug("inbox empty", { unread: page.unread });
      return 0;
    }

    const ids = page.mentions.map((entry) => entry.postId);
    const oldest = Math.min(...ids);
    const newest = Math.max(...ids);

    for (const entry of page.mentions) {
      recordPost(this.state, {
        postId: entry.postId,
        source: "mentions",
        channel: entry.channel,
        fromMuseId: entry.fromMuseId,
      });
    }
    await this.persist();

    if (this.state.watermark === 0) {
      // Cold start: begin at the current edge rather than probing thousands of
      // ids backwards. `backfill --from` reaches further back deliberately.
      this.state.watermark = Math.max(0, oldest - 1);
      this.logger.info("cold start; resuming from the current inbox edge", {
        watermark: this.state.watermark,
        newest,
      });
    } else if (page.mentions.length >= INBOX_PAGE_SIZE && oldest > this.state.watermark + 1) {
      // A full page whose oldest entry sits above the watermark means the
      // inbox held more than one page. There is no second page to ask for, so
      // the missing ids have to be probed.
      const detection = detectGap(this.state, oldest, { maxGapSize: this.config.maxGapSize });
      if (detection.opened) {
        this.logger.warn("inbox page was full; opening a gap to recover missed mentions", {
          from: this.state.watermark + 1,
          to: oldest - 1,
          truncated: detection.truncated,
        });
      }
    }

    await this.persist();
    this.logger.info("inbox drained", { count: page.mentions.length, unread: page.unread, oldest, newest });
    return page.mentions.length;
  }

  private async processRecord(
    record: PostRecord,
  ): Promise<"done" | "rejected" | "ignored" | "abandoned" | "retry"> {
    const log = this.logger.child({ postId: record.id });

    // The inbox excerpt is 200 chars and the socket excerpt 140. Always
    // resolve the real body first: a command parsed from an excerpt is
    // silently truncated garbage.
    let post: MusebookPost;
    try {
      const outcome = await this.fetcher.getPost(record.id, record.channel);
      if (!outcome.ok) {
        log.warn("cannot resolve post body; dropping", { reason: outcome.reason });
        updateRecord(this.state, record.id, { status: "unavailable", lastError: outcome.reason });
        return "ignored";
      }
      post = outcome.post;
    } catch (cause) {
      return this.backoff(record, `fetch failed: ${String(cause)}`);
    }

    if (post.muse_id && this.config.museId && post.muse_id === this.config.museId) {
      updateRecord(this.state, record.id, { status: "ignored", lastError: "self-mention" });
      return "ignored";
    }

    const context: ReplyContext = {
      family: this.config.family,
      requesterName: post.name || null,
      postId: post.id,
      familyMuseId: this.config.museId,
    };

    // Async work in flight: follow the job rather than starting again.
    if (record.jobId) {
      return this.resumeJob(record, post, context);
    }

    const invocation = parseMention(post.text, {
      handles: this.config.handles,
      family: this.config.family,
    });

    // The silence rule, drawn at command-shape rather than verb recognition:
    // a family with a default verb recognizes every verb by construction, so
    // recognition alone would make nothing silent. Conversational mentions are
    // the expected majority of early traffic, and replying "unknown command"
    // to a greeting is rude, wastes the scarcest resource the agent has, and
    // makes the family look broken.
    if (invocation.kind === "not_addressed" || invocation.kind === "silent") {
      log.info("not command-shaped; staying silent", {
        kind: invocation.kind,
        reason: invocation.kind === "silent" ? invocation.reason : "no mention",
      });
      updateRecord(this.state, record.id, {
        status: "ignored",
        lastError: invocation.kind === "silent" ? invocation.reason : "not_addressed",
      });
      return "ignored";
    }

    // One narrow exception to forwarding: a malformed wallet address. Its
    // syntax is context-free, so nothing the platform knows would change the
    // verdict, and forwarding it risks recording an address that permanently
    // loses money. Everything else — including commands the agent believes are
    // malformed — goes over the wire for the platform to adjudicate.
    const fatal = invocation.argErrors.filter((error) => error.fatal);
    if (fatal.length > 0) {
      log.info("refusing a malformed wallet address without forwarding it", {
        args: fatal.map((error) => error.arg),
      });
      const outcome = await this.ack.acknowledge({
        postId: post.id,
        channel: post.channel,
        kind: "rejected",
        requestedTier: "reply",
        priority: "domain_transition",
        // A typo'd verb shifts every field by one, so the address slot ends up
        // holding a deadline and the real fault is the verb. Blaming only the
        // wallet would send the author hunting for a bug that is not there.
        text: renderAddressRejection(
          fatal,
          context,
          collectAdditions(invocation, this.config.family, undefined),
        ),
      });
      updateRecord(this.state, record.id, {
        status: "rejected",
        lastError: "arg_address_invalid",
        ackTier: outcome.tier,
      });
      return "rejected";
    }

    return this.execute(record, post, invocation, context);
  }

  private async execute(
    record: PostRecord,
    post: MusebookPost,
    invocation: CommandInvocation,
    context: ReplyContext,
  ): Promise<"done" | "rejected" | "abandoned" | "retry"> {
    const log = this.logger.child({ postId: record.id, verb: invocation.verbName });

    // Tier 1 first, before the work completes. A muse must never wait forty
    // seconds wondering whether it was heard.
    if (!record.ackTier) {
      await this.ack.acknowledge({
        postId: post.id,
        channel: post.channel,
        kind: "received",
        requestedTier: "reaction",
        priority: "informational",
      });
      updateRecord(this.state, record.id, { ackTier: "reaction" });
      await this.persist();
    }

    // Derived from the immutable post id, so a retry after a crash at any
    // point below reaches the same server-side invocation rather than opening
    // a second one. Resending is therefore safe and sometimes necessary: it is
    // how a restart recovers the acknowledgement the site authored, and the
    // site answers with `deduped` rather than acting twice.
    const idempotencyKey = record.idempotencyKey ?? idempotencyKeyFor(post.id);
    updateRecord(this.state, record.id, { idempotencyKey });
    await this.persist();

    const request: InvocationRequest = {
      family: this.config.family.id,
      verb: invocation.verbName,
      verb_resolution: invocation.resolution,
      ...(invocation.nearMiss
        ? {
            near_miss: {
              token: invocation.nearMiss.token,
              suspected_verb: invocation.nearMiss.suspectedVerb,
              distance: invocation.nearMiss.distance,
            },
          }
        : {}),
      intake: intakeOf(this.config.family),
      args: invocation.args,
      raw_args: invocation.rawArgs,
      raw_fields: invocation.rawFields,
      ...(invocation.argErrors.length > 0
        ? {
            parse_hints: invocation.argErrors.map((error) => ({
              arg: error.arg,
              code: error.code,
              reason: error.reason,
            })),
          }
        : {}),
      raw_text: post.text,
      actor: {
        muse_id: post.muse_id,
        name: post.name || null,
        // A keyless `anon:` identity can never be challenged, so the site can
        // never raise it above `unverified`. We report; it decides.
        public_key_present: Boolean(post.muse_id) && !isKeylessIdentityId(post.muse_id),
        id_verified: post.id_verified,
      },
      origin: {
        ingest: ingestOf(record.source),
        musebook_post_id: post.id,
        musebook_parent_post_id: post.parent_post_id,
        channel: post.channel,
        posted_at: post.created_at || null,
        observed_at: record.firstSeenAt,
        permalink: `${this.config.musebookBaseUrl}/p/${post.id}`,
      },
      idempotency_key: idempotencyKey,
    };

    let result: InvokeResult;
    try {
      result = await this.router.invoke(request);
    } catch (cause) {
      return this.backoff(record, `router threw: ${String(cause)}`);
    }

    return this.settle(record, post, context, result, invocation, log);
  }

  /** Follow async work the site already accepted. Never re-invokes. */
  private async resumeJob(
    record: PostRecord,
    post: MusebookPost,
    context: ReplyContext,
  ): Promise<"done" | "rejected" | "abandoned" | "retry"> {
    let result: InvokeResult;
    try {
      result = await this.router.getJob(record.jobId!);
    } catch (cause) {
      return this.backoff(record, `job poll threw: ${String(cause)}`);
    }
    return this.settle(record, post, context, result, null, this.logger.child({ postId: record.id }));
  }

  private async settle(
    record: PostRecord,
    post: MusebookPost,
    context: ReplyContext,
    result: InvokeResult,
    invocation: CommandInvocation | null,
    log: Logger,
  ): Promise<"done" | "rejected" | "abandoned" | "retry"> {
    const consequential = invocation?.verb?.consequential === true;
    if (result.kind === "error") {
      if (result.retryable) return this.backoff(record, `${result.code}: ${result.detail ?? ""}`);
      // The author's problem, reported in the site's words plus the remedy
      // that actually applies. It will never succeed on retry, so stop here.
      const rejectionClass = classifyRejection(result.code);
      log.info("router refused the invocation", { code: result.code, class: rejectionClass });
      const outcome = await this.ack.acknowledge({
        postId: post.id,
        channel: post.channel,
        kind: rejectionClass === "confirmation" ? "needs_confirmation" : "rejected",
        // An authorization refusal is worth a reply: the author did nothing
        // wrong and cannot discover the enrollment step from an emoji.
        requestedTier: "reply",
        priority: rejectionClass === "authorization" ? "domain_transition" : "informational",
        text: renderSiteRejection(result.userMessage, rejectionClass, context, {
          enrollUrl: this.config.enrollUrl,
          additions: collectAdditions(invocation, this.config.family, result.userMessage),
        }),
      });
      updateRecord(this.state, record.id, {
        status: "rejected",
        lastError: result.code,
        settled: true,
        ackTier: outcome.tier,
      });
      return "rejected";
    }

    if (result.kind === "pending") {
      updateRecord(this.state, record.id, {
        status: "retry",
        settled: true,
        jobId: result.job.jobId,
        nextAttemptAt: this.now() + Math.max(1000, result.job.pollAfterMs),
      });
      log.info("router is still working; will poll the job", {
        jobId: result.job.jobId,
        pollAfterMs: result.job.pollAfterMs,
      });
      return "retry";
    }

    updateRecord(this.state, record.id, { settled: true, jobId: undefined });
    await this.persist();

    for (const warning of result.warnings) log.warn("router warning", { warning });

    // The site chooses the tier and, for anything consequential, the words.
    const kind: AckKind = result.ack.kind;
    let requestedTier: AckTier = result.ack.tier;
    let priority = priorityFor(kind, consequential);

    // Two cases override the site's tier upward, because a reaction cannot
    // carry the information the author needs.
    if (result.payout && !result.payout.proven) {
      // An emoji cannot say "recorded, but not payable until you prove the
      // address" — and that is precisely what the builder must not miss.
      requestedTier = "reply";
      priority = "value_receipt";
    } else if (invocation?.nearMiss) {
      // A 🚀 cannot tell a muse it just opened a bounty titled "cancl".
      requestedTier = "reply";
      priority = "domain_transition";
    } else if (renderAddressEcho(invocation?.verb ?? null, invocation?.args ?? {}).length > 0) {
      // An emoji cannot show an address, and echoing it back is the muse's
      // last chance to catch a wrong one before money moves.
      requestedTier = "reply";
      priority = "domain_transition";
    } else if (invocation?.reserved) {
      requestedTier = "reply";
      priority = "help";
    }

    const additions = collectAdditions(invocation, this.config.family, result.ack.text, result);
    const text = result.ack.text
      ? renderSiteReply(result.ack.text, context, additions)
      : additions.length > 0
        ? renderSiteReply(additions.join("\n"), context)
        : undefined;

    const outcome = await this.ack.acknowledge({
      postId: post.id,
      channel: post.channel,
      kind,
      requestedTier,
      priority,
      text,
    });

    // A failed acknowledgement is not a failed command, but it does leave the
    // author with no signal at all — which is the one thing the protocol says
    // must not happen. Retry it; `settled` keeps this from re-invoking.
    if (outcome.tier === "none" && outcome.warning === "ack_failed") {
      log.warn("invocation settled but the acknowledgement failed; will retry the ack", {
        postId: post.id,
      });
      return this.backoff(record, "acknowledgement failed");
    }
    if (outcome.tier === "none") {
      // Budget exhaustion is deliberate degradation, not a retryable fault.
      log.error("no acknowledgement was affordable; the author gets no signal", {
        postId: post.id,
        warning: outcome.warning,
      });
    }

    updateRecord(this.state, record.id, {
      status: kind === "rejected" ? "rejected" : "done",
      ackTier: outcome.tier,
      replyPostId: outcome.replyPostId,
      lastError: outcome.warning,
    });
    log.info("invocation settled", {
      status: result.status,
      deduped: result.deduped,
      tier: outcome.tier,
      degraded: outcome.degraded,
    });
    return kind === "rejected" ? "rejected" : "done";
  }

  /**
   * Transient failure. Retry with backoff, then stop.
   *
   * Going quiet after repeated internal failure is deliberate: a public thread
   * is the wrong place to narrate our own outage, and a retry loop that posts
   * each time is indistinguishable from spam.
   */
  private backoff(record: PostRecord, reason: string): "retry" | "abandoned" {
    const attempts = record.attempts + 1;
    if (attempts >= this.config.maxAttempts) {
      this.logger.error("giving up on post after repeated failures; staying silent", {
        postId: record.id,
        attempts,
        reason,
      });
      updateRecord(this.state, record.id, { status: "abandoned", attempts, lastError: reason });
      return "abandoned";
    }
    const delay = Math.min(30_000 * 2 ** (attempts - 1), 15 * 60_000);
    this.logger.warn("transient failure; will retry", { postId: record.id, attempts, reason, delay });
    updateRecord(this.state, record.id, {
      status: "retry",
      attempts,
      lastError: reason,
      nextAttemptAt: this.now() + delay,
    });
    return "retry";
  }

  /** musebook's own mention rule: our single-word name, case-insensitive, not self. */
  private mentionsUs(post: MusebookPost): boolean {
    if (this.config.museId && post.muse_id === this.config.museId) return false;
    return this.config.handles.some((handle) =>
      new RegExp(`@${escapeRegExp(handle)}(?![\\w-])`, "i").test(post.text),
    );
  }

  private pruneReactions(): void {
    const cutoff = this.state.watermark - 2000;
    if (cutoff <= 0) return;
    for (const key of Object.keys(this.state.reactions)) {
      if (Number(key) <= cutoff) delete this.state.reactions[key];
    }
  }

  private async persist(): Promise<void> {
    await this.store.save(this.state);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

function ingestOf(source: IngestSource): InvocationRequest["origin"]["ingest"] {
  switch (source) {
    case "mentions":
      return "mention_inbox";
    case "live":
      return "websocket";
    case "backfill":
      return "backfill";
    default:
      return "poll";
  }
}

/**
 * Append the near-miss correction to whatever the site said. When the site
 * returned nothing, the correction stands alone rather than being dropped: a
 * silent misfire is the one outcome the near-miss rule exists to prevent.
 */
/**
 * Lines the agent appends to whatever the site said. Neither is an outcome:
 * one echoes back what was recorded, the other is grammar guidance.
 */
export function collectAdditions(
  invocation: CommandInvocation | null,
  family: AgentConfig["family"],
  siteText: string | undefined,
  result?: Extract<InvokeResult, { kind: "settled" }>,
): string[] {
  const additions: string[] = [];

  if (invocation) {
    // Echo any wallet address exactly as accepted, unless the site already did.
    for (const line of renderAddressEcho(invocation.verb, invocation.args)) {
      const value = line.slice(line.indexOf(": ") + 2);
      if (!siteText || !siteText.includes(value)) additions.push(line);
    }
  }

  // Payability is never left implicit: a submission that looks accepted but
  // can never be paid is the worst message this agent can send.
  if (result?.payout) additions.push(...renderPayoutProof(result.payout));

  if (result?.releaseRequiresEvmSignature) additions.push(renderReleaseCaveat());

  if (invocation?.nearMiss) additions.push(renderNearMissCorrection(family, invocation.nearMiss));
  return additions;
}

function priorityFor(kind: AckKind, consequential: boolean): WritePriority {
  if (kind === "rejected") return "informational";
  if (consequential) return "value_receipt";
  return "domain_transition";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

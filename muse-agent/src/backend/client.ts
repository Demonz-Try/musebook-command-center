import type { AckKind, AckTier } from "../reply/ack.js";
import type { Logger } from "../runtime/logger.js";

/**
 * Client for the command center's router API.
 *
 * Everything that constitutes a decision lives on the other side of this call:
 * authorization, assurance, escrow, deadline resolution, hashing, outcomes,
 * ids, and the wording of any consequential reply. The agent relays and
 * reports; it never decides.
 */

export interface InvocationRequest {
  family: string;
  /**
   * The verb to run. For a token the agent could not resolve this is the token
   * itself: resolution is the platform's job, so the agent reports rather than
   * refusing.
   */
  verb: string;
  /** How the verb was resolved. The site uses this to require confirmation. */
  verb_resolution: "explicit" | "reserved" | "ambiguous" | "default" | "unresolved";
  /**
   * A leading token close enough to a real verb to be a typo. Advisory: the
   * platform recomputes it and may ignore this. It does not change resolution,
   * but it does mean the misfire must never be acknowledged silently.
   */
  near_miss?: { token: string; suspected_verb: string; distance: number };
  /** Intake mode the agent applied, so the site can detect manifest drift. */
  intake: "explicit" | "strict" | "open";
  /** Normalized argument values keyed by the spec's arg names. */
  args: Record<string, unknown>;
  /** Exactly what the author typed, per argument. Audit trail, not input. */
  raw_args: Record<string, string>;
  /** Every field as split, in order. The site's input when `args` is empty. */
  raw_fields: string[];
  /**
   * Fields the agent could not coerce. Advisory only — the command is
   * forwarded regardless, and the platform's validation is authoritative.
   */
  parse_hints?: { arg: string; code: string; reason: string }[];
  raw_text: string;
  actor: {
    /** Asserted by musebook over a channel authenticated to us. Not proof. */
    muse_id: string | null;
    name: string | null;
    /** False for every keyless `anon:` identity; they can never be challenged. */
    public_key_present: boolean;
    id_verified: boolean;
  };
  origin: {
    ingest: "mention_inbox" | "poll" | "websocket" | "backfill";
    musebook_post_id: number;
    musebook_parent_post_id: number | null;
    channel: string;
    /** musebook's naive, timezone-less string, passed through unaltered. */
    posted_at: string | null;
    observed_at: string;
    permalink: string;
  };
  idempotency_key: string;
}

/** What the site tells the agent to do on the board. The agent obeys. */
export interface AckDirective {
  tier: AckTier;
  kind: AckKind;
  /** Reply body, authored by the site so a reply can never contradict a receipt. */
  text?: string;
}

/**
 * Payout proof state for a submission.
 *
 * A declared-but-unproven payout address still reaches `IN_REVIEW` with its
 * evidence trail intact, but is **not payable**. An acknowledgement that looks
 * like acceptance while the submission can never be paid is the worst message
 * the agent can send, so this travels as structured data rather than prose.
 */
export interface PayoutProof {
  address?: string;
  proven: boolean;
  /** How it was proved, when it was. */
  method?: "onchain" | "eip191" | string;
  /** Site-authored instructions for proving it. Preferred over our default. */
  instructions?: string;
}

export type InvokeResult =
  | {
      kind: "settled";
      status: "succeeded" | "failed" | "rejected" | "pending_confirmation";
      invocationId?: string;
      deduped: boolean;
      ack: AckDirective;
      payout?: PayoutProof;
      /**
       * True when the domain state the site just reached is payable but not
       * paid. A musebook keypair reaches `key_bound`, which can dispute but
       * cannot release: release needs an EVM signature. The receipt must not
       * imply that agreeing on the board moved any money.
       */
      releaseRequiresEvmSignature?: boolean;
      /** Non-fatal notices, e.g. board_budget_exhausted. */
      warnings: string[];
    }
  | {
      kind: "pending";
      invocationId?: string;
      job: { jobId: string; pollAfterMs: number };
    }
  | { kind: "error"; retryable: boolean; code: string; userMessage: string; detail?: string };

/**
 * Board-derived ingest always keys on the immutable post id, so the socket,
 * the inbox, a poll and a defensive retry all collapse to one invocation.
 */
export function idempotencyKeyFor(postId: number): string {
  return `mb_post:${postId}`;
}

/**
 * Why a command was refused, which decides what the author is told to do.
 *
 * The distinction matters because the remedies have nothing in common: a
 * malformed command is fixed by retyping it, while an authorization failure is
 * fixed by proving key custody — the author's command was perfectly good and
 * telling them to check their syntax would send them in circles.
 */
export type RejectionClass = "authorization" | "confirmation" | "malformed" | "state" | "other";

const AUTHORIZATION_CODES = new Set([
  "actor_not_authenticatable",
  "assurance_insufficient",
  "permission_denied",
  "not_enrolled",
  "key_revoked",
  "capability_denied",
]);

const MALFORMED_CODES = new Set([
  "arg_missing",
  "arg_unknown",
  "arg_count_mismatch",
  "arg_type_invalid",
  "arg_too_long",
  "verb_unknown",
  "family_unknown",
  "muse_ref_ambiguous",
]);

const STATE_CODES = new Set([
  "subject_not_found",
  "transition_invalid",
  "transition_guard_failed",
  "value_rules_violation",
  "stale_post",
]);

export function classifyRejection(code: string): RejectionClass {
  if (AUTHORIZATION_CODES.has(code)) return "authorization";
  if (code === "confirmation_required") return "confirmation";
  if (MALFORMED_CODES.has(code)) return "malformed";
  if (STATE_CODES.has(code)) return "state";
  return "other";
}

export interface RouterClientOptions {
  baseUrl: string;
  token: string;
  requestTimeoutMs?: number;
  logger?: Logger;
  fetchImpl?: typeof fetch;
}

export interface RouterApi {
  invoke(request: InvocationRequest): Promise<InvokeResult>;
  getJob(jobId: string): Promise<InvokeResult>;
}

export class RouterHttpClient implements RouterApi {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly requestTimeoutMs: number;
  private readonly logger?: Logger;
  private readonly fetchImpl: typeof fetch;

  constructor(options: RouterClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 20_000;
    this.logger = options.logger;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async invoke(request: InvocationRequest): Promise<InvokeResult> {
    return this.call("POST", "/invoke", request.idempotency_key, request);
  }

  async getJob(jobId: string): Promise<InvokeResult> {
    return this.call("GET", `/jobs/${encodeURIComponent(jobId)}`);
  }

  private async call(
    method: "GET" | "POST",
    path: string,
    idempotencyKey?: string,
    body?: unknown,
  ): Promise<InvokeResult> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.token}`,
          ...(body ? { "content-type": "application/json" } : {}),
          // Header is the convention; the body field survives proxies that
          // strip unknown headers. The router requires it on every mutation.
          ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (cause) {
      // Safe to retry only because the idempotency key is stable.
      return {
        kind: "error",
        retryable: true,
        code: "upstream_unavailable",
        userMessage: "the desk is unreachable right now",
        detail: String(cause),
      };
    }

    const text = await response.text();
    let parsed: Record<string, unknown>;
    try {
      parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      return {
        kind: "error",
        retryable: response.status >= 500,
        code: "bad_response",
        userMessage: "the desk returned something unreadable",
        detail: text.slice(0, 300),
      };
    }

    if (!response.ok) return toError(parsed, response.status, text);
    return toResult(parsed, this.logger);
  }
}

function toError(parsed: Record<string, unknown>, status: number, text: string): InvokeResult {
  const error = (parsed.error ?? {}) as Record<string, unknown>;
  const code = str(error.code) ?? `http_${status}`;
  return {
    kind: "error",
    // Agents branch on `code`; unknown codes are treated as non-retryable.
    retryable:
      typeof error.retryable === "boolean"
        ? error.retryable
        : status === 429 || status >= 500,
    code,
    userMessage: str(error.message) ?? `the desk refused that (${code})`,
    detail: text.slice(0, 300),
  };
}

export function toResult(parsed: Record<string, unknown>, logger?: Logger): InvokeResult {
  const status = str(parsed.status) ?? "succeeded";
  const invocationId = str(parsed.invocation_id);

  if (status === "queued" || status === "running") {
    const job = (parsed.job ?? {}) as Record<string, unknown>;
    const jobId = str(job.job_id);
    if (!jobId) {
      return {
        kind: "error",
        retryable: false,
        code: "bad_response",
        userMessage: "the desk said it was still working but gave no job to follow",
      };
    }
    return {
      kind: "pending",
      invocationId,
      job: { jobId, pollAfterMs: num(job.poll_after_ms) ?? 5000 },
    };
  }

  const ack = parseAck(parsed.acknowledgement, status);
  const warnings = Array.isArray(parsed.warnings)
    ? parsed.warnings.filter((warning): warning is string => typeof warning === "string")
    : [];
  logger?.debug("router settled", { status, invocationId, tier: ack.tier });

  return {
    kind: "settled",
    status: status === "failed" || status === "rejected" || status === "pending_confirmation"
      ? (status as "failed" | "rejected" | "pending_confirmation")
      : "succeeded",
    invocationId,
    deduped: parsed.deduped === true,
    ack,
    ...(parsePayout(parsed.payout) ? { payout: parsePayout(parsed.payout)! } : {}),
    ...(parsed.release_requires_evm_signature === true
      ? { releaseRequiresEvmSignature: true }
      : {}),
    warnings,
  };
}

export function parsePayout(raw: unknown): PayoutProof | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.proven !== "boolean") return null;
  return {
    proven: record.proven,
    address: str(record.address),
    method: str(record.method),
    instructions: str(record.instructions),
  };
}

function parseAck(raw: unknown, status: string): AckDirective {
  const fallbackKind: AckKind =
    status === "pending_confirmation"
      ? "needs_confirmation"
      : status === "failed" || status === "rejected"
        ? "rejected"
        : "succeeded";
  if (typeof raw !== "object" || raw === null) return { tier: "reaction", kind: fallbackKind };
  const record = raw as Record<string, unknown>;
  const tier = str(record.tier);
  return {
    tier: tier === "reply" || tier === "batched" || tier === "none" ? tier : "reaction",
    kind: (str(record.kind) as AckKind | undefined) ?? fallbackKind,
    text: str(record.text) ?? str(record.reply),
  };
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Dry-run stand-in. Records what would have been sent and synthesizes a
 * settled response, so an operator can read the exact board action the agent
 * would take without anything being created anywhere.
 */
export class DryRunRouter implements RouterApi {
  readonly calls: InvocationRequest[] = [];

  constructor(private readonly logger?: Logger) {}

  async invoke(request: InvocationRequest): Promise<InvokeResult> {
    this.calls.push(request);
    this.logger?.info("DRY RUN would invoke the router", {
      verb: request.verb,
      resolution: request.verb_resolution,
      nearMiss: request.near_miss?.suspected_verb,
      key: request.idempotency_key,
      args: request.args,
      hints: request.parse_hints?.length ?? 0,
    });
    return {
      kind: "settled",
      status: "succeeded",
      deduped: false,
      warnings: [],
      ack: {
        tier: "reaction",
        kind: "succeeded",
        text: `[dry run] ${request.verb} accepted — the live site composes this text, not the agent.`,
      },
    };
  }

  async getJob(): Promise<InvokeResult> {
    return { kind: "settled", status: "succeeded", deduped: false, warnings: [], ack: { tier: "reaction", kind: "succeeded" } };
  }
}

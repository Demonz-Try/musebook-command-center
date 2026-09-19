#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { DryRunRouter, RouterHttpClient, idempotencyKeyFor, type RouterApi } from "./backend/client.js";
import { parseMention } from "./command/parse.js";
import { loadConfig, liveRunProblems, type AgentConfig, type ConfigOverrides } from "./config.js";
import { runBackfill } from "./ingest/backfill.js";
import { PostFetcher } from "./ingest/fetcher.js";
import { detectGap, type AgentState } from "./ingest/state.js";
import { FileStateStore } from "./ingest/store.js";
import { MusebookClient } from "./musebook/client.js";
import { LiveClient } from "./musebook/live.js";
import { generateIdentity, privateKeyFromSecret, publicKeyFromPrivate } from "./musebook/signing.js";
import { renderSiteReply, type ReplyContext } from "./reply/receipt.js";
import { intakeOf, RESERVED_VERBS } from "./command/registry.js";
import { Agent, collectAdditions } from "./runtime/agent.js";
import { createLogger, type Logger } from "./runtime/logger.js";

interface Flags {
  [key: string]: string | boolean;
}

function parseArgv(argv: string[]): { command: string; positional: string[]; flags: Flags } {
  const [command = "help", ...rest] = argv;
  const positional: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]!;
    if (token.startsWith("--")) {
      const [name, inline] = token.slice(2).split("=", 2);
      if (!name) continue;
      if (inline !== undefined) {
        flags[name] = inline;
      } else if (rest[i + 1] && !rest[i + 1]!.startsWith("--")) {
        flags[name] = rest[i + 1]!;
        i += 1;
      } else {
        flags[name] = true;
      }
    } else {
      positional.push(token);
    }
  }
  return { command, positional, flags };
}

function overridesFrom(flags: Flags): ConfigOverrides {
  const overrides: ConfigOverrides = {};
  if (typeof flags.family === "string") overrides.family = flags.family;
  if (typeof flags.state === "string") overrides.statePath = flags.state;
  if (flags.live === true) overrides.dryRun = false;
  if (flags["dry-run"] === true) overrides.dryRun = true;
  if (typeof flags.interval === "string") overrides.pollIntervalMs = Number(flags.interval);
  if (flags.websocket === true) overrides.enableWebSocket = true;
  if (typeof flags["log-level"] === "string") overrides.logLevel = flags["log-level"] as never;
  if (typeof flags["log-format"] === "string") overrides.logFormat = flags["log-format"] as never;
  return overrides;
}

function buildLogger(config: AgentConfig): Logger {
  return createLogger({
    level: config.logLevel,
    format: config.logFormat,
    base: { family: config.family.id },
  });
}

function buildMusebookClient(config: AgentConfig, logger: Logger): MusebookClient {
  return new MusebookClient({
    baseUrl: config.musebookBaseUrl,
    museId: config.museId ?? undefined,
    privateKey: config.secret ? privateKeyFromSecret(config.secret) : undefined,
    logger,
  });
}

function buildRouter(config: AgentConfig, logger: Logger): RouterApi {
  if (config.dryRun || !config.site) return new DryRunRouter(logger);
  return new RouterHttpClient({ baseUrl: config.site.baseUrl, token: config.site.token, logger });
}

const HELP = `muse-agent — musebook mention-command runtime

usage: muse-agent <command> [options]

commands:
  run                      drain mentions, execute commands, post receipts
  parse "<post text>"      parse one post body and print what would be posted
                           --post <id>  --from <name>  --simulate-reply "<text>"
  keygen                   generate an ed25519 identity (prints the secret once)
  register                 register the family's muse on musebook (PUBLIC POST)
  whoami                   show the configured identity as musebook sees it
  backfill --from --to     recover a specific id range through thread.json
  state                    print the current watermark and outstanding work
  doctor                   check configuration without touching the network

options:
  --family <id|file.json>  command family to run (default: bounty)
  --live                   actually post and call the site API (default: dry run)
  --dry-run                force dry run
  --websocket              enable the live-stream accelerator
  --interval <ms>          poll interval (default: 60000)
  --state <path>           state file path
  --log-level <level>      debug | info | warn | error
  --log-format <format>    pretty | json

Dry run is the default everywhere. Nothing is posted to musebook and no site
API call is made until --live is passed.`;

async function main(): Promise<number> {
  const { command, positional, flags } = parseArgv(process.argv.slice(2));

  if (command === "help" || flags.help === true) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }

  const config = await loadConfig(overridesFrom(flags));
  const logger = buildLogger(config);

  switch (command) {
    case "run":
      return runAgent(config, logger, flags);
    case "parse":
      return parseOne(config, positional.join(" "), flags);
    case "keygen":
      return keygen();
    case "register":
      return register(config, logger, flags);
    case "whoami":
      return whoami(config, logger);
    case "backfill":
      return backfill(config, logger, flags);
    case "state":
      return showState(config);
    case "doctor":
      return doctor(config);
    default:
      process.stderr.write(`unknown command "${command}"\n\n${HELP}\n`);
      return 1;
  }
}

async function runAgent(config: AgentConfig, logger: Logger, flags: Flags): Promise<number> {
  const problems = liveRunProblems(config);
  if (!config.dryRun && problems.length > 0) {
    logger.error("cannot run live", { problems });
    return 1;
  }
  if (config.dryRun) {
    logger.warn("DRY RUN — nothing will be posted and no site API call will be made. Pass --live to act.");
  }
  if (!config.museId || !config.secret) {
    logger.error(
      "the mention inbox needs a registered identity: GET /api/mentions.json is 401 without a keypair. " +
        "Run `muse-agent register` once the handle and intro post are approved.",
    );
    return 1;
  }

  const musebook = buildMusebookClient(config, logger);
  const store = new FileStateStore(config.statePath, config.family.id, config.museId);
  const agent = new Agent({
    config,
    musebook,
    router: buildRouter(config, logger),
    store,
    logger,
  });
  await agent.init();

  let live: LiveClient | undefined;
  if (config.enableWebSocket) {
    live = new LiveClient({
      logger,
      handlers: {
        onPost: ({ postId, channel }) => agent.noteLivePost(postId, channel),
        onDegraded: (reason) => logger.warn("live stream degraded; polling continues", { reason }),
      },
    });
    live.start();
  }

  const shutdown = () => {
    logger.info("shutting down");
    agent.stop();
    live?.stop();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  if (flags.once === true) {
    await agent.tick();
    live?.stop();
    return 0;
  }

  await agent.runForever();
  live?.stop();
  return 0;
}

/**
 * Offline parse. The whole point of dry run: see the exact post the agent would
 * make, for a given body, without any network access at all.
 */
async function parseOne(config: AgentConfig, text: string, flags: Flags): Promise<number> {
  if (!text.trim()) {
    process.stderr.write('usage: muse-agent parse "@handle verb | arg | arg"\n');
    return 1;
  }
  const invocation = parseMention(text, { handles: config.handles, family: config.family });
  const postId = Number(flags.post ?? 20000);
  const context: ReplyContext = {
    family: config.family,
    requesterName: typeof flags.from === "string" ? flags.from : "Requester",
    postId,
    familyMuseId: config.museId ?? "muse_(unregistered)",
  };

  process.stdout.write(`classification: ${invocation.kind}\n`);

  switch (invocation.kind) {
    case "command": {
      process.stdout.write(`verb: ${invocation.verbName} (resolved: ${invocation.resolution})\n`);
      if (invocation.nearMiss) {
        process.stdout.write(
          `near miss: "${invocation.nearMiss.token}" is distance ${invocation.nearMiss.distance} ` +
            `from "${invocation.nearMiss.suspectedVerb}" — forces a threaded reply\n`,
        );
      }
      if (invocation.argErrors.length > 0) {
        process.stdout.write(
          `parse hints (advisory; forwarded anyway, the site validates):\n${invocation.argErrors
            .map((error) => `  - ${error.arg}: ${error.reason}`)
            .join("\n")}\n`,
        );
      }
      process.stdout.write(`arguments:\n${JSON.stringify(invocation.args, null, 2)}\n`);
      const router = new DryRunRouter();
      const result = await router.invoke({
        family: config.family.id,
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
        intake: intakeOf(config.family),
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
        raw_text: text,
        actor: {
          muse_id: "muse_example00",
          name: context.requesterName,
          public_key_present: true,
          id_verified: true,
        },
        origin: {
          ingest: "mention_inbox",
          musebook_post_id: postId,
          musebook_parent_post_id: null,
          channel: "lobby",
          posted_at: null,
          observed_at: new Date().toISOString(),
          permalink: `${config.musebookBaseUrl}/p/${postId}`,
        },
        idempotency_key: idempotencyKeyFor(postId),
      });
      process.stdout.write(
        `\nwould POST ${config.site?.baseUrl ?? "<site>"}/invoke:\n${JSON.stringify(router.calls[0], null, 2)}\n`,
      );
      if (result.kind === "settled") {
        // The agent never composes outcome language, so previewing a real
        // receipt means supplying the text the site would have returned.
        const siteText = typeof flags["simulate-reply"] === "string"
          ? flags["simulate-reply"]
          : result.ack.text;
        // A near-miss or a reserved verb overrides the site's tier upward: a
        // reaction cannot carry what the author needs to know.
        const tier = invocation.nearMiss || invocation.reserved ? "reply" : result.ack.tier;
        process.stdout.write(
          `\nacknowledgement tier: ${tier} (${result.ack.kind})` +
            `${invocation.nearMiss ? " — forced to tier 2 by the near miss" : ""}` +
            `${invocation.reserved ? " — forced to tier 2 by the reserved verb" : ""}\n` +
            `${
              typeof flags["simulate-reply"] === "string"
                ? "reply text: simulated site response (--simulate-reply)\n"
                : "note: on a live run the SITE authors this text, not the agent.\n"
            }`,
        );
        // Reuse the runtime's own composition so the preview is exact rather
        // than merely similar.
        const additions = collectAdditions(
          invocation,
          config.family,
          siteText,
          result.kind === "settled" ? result : undefined,
        );
        const full = siteText
          ? renderSiteReply(siteText, context, additions)
          : additions.length > 0
            ? renderSiteReply(additions.join("\n"), context)
            : undefined;
        if (full) {
          process.stdout.write(`\nwould reply in-thread:\n---\n${full}\n---\n`);
        }
      }
      return 0;
    }
    case "silent":
      process.stdout.write(
        `no ack (silence rule): ${
          invocation.reason === "not_candidate"
            ? "mentioned, but not addressed — mid-prose, quoted, or fenced"
            : "addressed, but not command-shaped"
        }\n`,
      );
      return 0;
    case "not_addressed":
    default:
      process.stdout.write("no ack: this post does not address the agent.\n");
      return 0;
  }
}

function keygen(): number {
  const identity = generateIdentity();
  process.stdout.write(
    [
      "ed25519 identity generated.",
      "",
      `public_key (send this to musebook): ${identity.publicKey}`,
      `secret     (KEEP THIS, never share): ${identity.secret}`,
      "",
      "Store the secret as MUSE_AGENT_<FAMILY>_SECRET. Lose it and the muse's",
      "name cannot be recovered — musebook has no other proof it is yours.",
      "",
    ].join("\n"),
  );
  return 0;
}

/**
 * Registration.
 *
 * `POST /api/intro` requires `text`, and that text is published as a real post
 * in #lobby. Registering is therefore a public act, not a silent one, which is
 * why this refuses to run without an explicit acknowledgement.
 */
async function register(config: AgentConfig, logger: Logger, flags: Flags): Promise<number> {
  const text = typeof flags.intro === "string" ? flags.intro : "";
  const approved = flags["approved-by-human"] === true;

  if (!approved) {
    process.stderr.write(
      [
        "register posts publicly.",
        "",
        "POST /api/intro requires an intro message, and musebook publishes it as a",
        "real post in #lobby to 900+ live participants. Get the handle and the intro",
        "text signed off first, then re-run with:",
        "",
        `  muse-agent register --family ${config.family.id} \\`,
        '    --intro "<the approved intro post>" \\',
        "    --approved-by-human",
        "",
        `proposed handle:       ${config.displayName}`,
        `proposed family:       ${config.family.id} (${config.family.label})`,
        "",
      ].join("\n"),
    );
    return 1;
  }

  if (!text.trim()) {
    process.stderr.write("--intro is required: it is the public post musebook will publish.\n");
    return 1;
  }

  const secret = config.secret ?? generateIdentity().secret;
  const privateKey = privateKeyFromSecret(secret);
  const publicKey = publicKeyFromPrivate(privateKey);

  // One key per signup, saved before the request: if this times out, re-running
  // with the same key returns the original muse instead of creating a second.
  const idempotencyKey = typeof flags["idempotency-key"] === "string"
    ? flags["idempotency-key"]
    : randomUUID();

  process.stdout.write(`idempotency_key: ${idempotencyKey}  (save this before continuing)\n`);
  if (!config.secret) process.stdout.write(`secret: ${secret}  (SAVE THIS)\n`);

  if (config.dryRun) {
    process.stdout.write(
      [
        "",
        "DRY RUN — nothing was sent. Would POST /api/intro with:",
        JSON.stringify(
          { name: config.displayName, public_key: publicKey, visibility: "anonymous", text },
          null,
          2,
        ),
        "",
        "Re-run with --live to register.",
        "",
      ].join("\n"),
    );
    return 0;
  }

  const client = new MusebookClient({ baseUrl: config.musebookBaseUrl, logger });
  const result = await client.intro({
    name: config.displayName,
    publicKey,
    text,
    bio: config.family.description,
    visibility: "anonymous",
    idempotencyKey,
    museId: config.museId ?? undefined,
  });
  process.stdout.write(
    `\nregistered: ${result.museId}${result.deduped ? " (deduped, existing muse returned)" : ""}\n` +
      `set MUSE_AGENT_${config.family.id.toUpperCase()}_MUSE_ID=${result.museId}\n`,
  );
  return 0;
}

async function whoami(config: AgentConfig, logger: Logger): Promise<number> {
  if (!config.museId) {
    process.stderr.write("no muse id configured; nothing to look up.\n");
    return 1;
  }
  const client = buildMusebookClient(config, logger);
  const identity = await client.getIdentity(config.museId);
  if (!identity) {
    process.stderr.write(`musebook does not know ${config.museId}\n`);
    return 1;
  }
  process.stdout.write(`${JSON.stringify(identity, null, 2)}\n`);

  if (config.secret) {
    const derived = publicKeyFromPrivate(privateKeyFromSecret(config.secret));
    const matches = derived === identity.public_key;
    process.stdout.write(
      matches
        ? "\nlocal secret matches the published public key.\n"
        : `\nWARNING: local secret derives ${derived}, musebook published ${identity.public_key}. Signing will fail.\n`,
    );
  }

  // Name squatting is unrecoverable, so surface it rather than discovering it later.
  const roster = await client.getRoster();
  const sameName = roster.filter(
    (muse) => muse.name.toLowerCase() === identity.name.toLowerCase() && muse.muse_id !== identity.muse_id,
  );
  if (sameName.length > 0) {
    process.stdout.write(
      `\nWARNING: ${sameName.length} other muse(s) use the name "${identity.name}": ` +
        `${sameName.map((muse) => muse.muse_id).join(", ")}.\n` +
        "musebook does not enforce unique names. Mentions of this name may not all reach us.\n",
    );
  }
  return 0;
}

async function backfill(config: AgentConfig, logger: Logger, flags: Flags): Promise<number> {
  const from = Number(flags.from);
  const to = Number(flags.to);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from > to) {
    process.stderr.write("usage: muse-agent backfill --from <id> --to <id>\n");
    return 1;
  }
  const musebook = buildMusebookClient(config, logger);
  const store = new FileStateStore(config.statePath, config.family.id, config.museId);
  const state = await store.load();
  state.watermark = Math.min(state.watermark || from - 1, from - 1);
  detectGap(state, to + 1, { maxGapSize: Math.max(config.maxGapSize, to - from + 1) });

  const fetcher = new PostFetcher({
    client: musebook,
    logger,
    isPoisoned: (postId) => state.poisonedPostIds.includes(postId),
  });
  const handles = config.handles;
  const result = await runBackfill(state, fetcher, {
    budget: Number(flags.budget ?? 200),
    logger,
    isInteresting: (post) =>
      handles.some((handle) => new RegExp(`@${handle}(?![\\w-])`, "i").test(post.text)),
  });
  await store.save(state);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

async function showState(config: AgentConfig): Promise<number> {
  const store = new FileStateStore(config.statePath, config.family.id, config.museId);
  const state: AgentState = await store.load();
  const outstanding = Object.values(state.posts).filter(
    (record) => record.status === "seen" || record.status === "retry",
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        statePath: config.statePath,
        watermark: state.watermark,
        highestSeenId: state.highestSeenId,
        lastPollAt: state.lastPollAt,
        outstanding: outstanding.map((record) => ({ id: record.id, status: record.status, attempts: record.attempts })),
        gap: state.gap ? { from: state.gap.from, to: state.gap.to, remaining: state.gap.remaining.length } : null,
        poisonedPostIds: state.poisonedPostIds,
      },
      null,
      2,
    )}\n`,
  );
  return 0;
}

function doctor(config: AgentConfig): number {
  const problems = liveRunProblems(config);
  process.stdout.write(
    [
      `family:        ${config.family.id} (${config.family.label})`,
      `handle:        ${config.displayName}`,
      `answers to:    ${config.handles.join(", ")}`,
      `muse id:       ${config.museId ?? "(not registered)"}`,
      `secret:        ${config.secret ? "present" : "(missing)"}`,
      `site api:      ${config.site ? config.site.baseUrl : "(not configured)"}`,
      `state file:    ${config.statePath}`,
      `mode:          ${config.dryRun ? "DRY RUN" : "LIVE"}`,
      `poll interval: ${config.pollIntervalMs}ms`,
      `websocket:     ${config.enableWebSocket ? "enabled" : "disabled"}`,
      `intake:        ${intakeOf(config.family)}`,
      `default verb:  ${config.family.defaultVerb ?? "(none)"}`,
      `verbs:         ${config.family.verbs.map((verb) => verb.name).join(", ")}`,
      `reserved:      ${RESERVED_VERBS.join(", ")} (resolve ahead of the default, always)`,
      "",
      `board budget:  ${config.boardWritesPerHour}/hour (musebook allows ~20/hour PER IP, shared by every family)`,
      `reactions:     ${
        config.reactionsCountAgainstBudget
          ? "charged against the budget (conservative; UNVERIFIED)"
          : "assumed free (verified — see docs/muse-agent.md)"
      }`,
      `enroll url:    ${config.enrollUrl ?? "(not set; authorization refusals will omit the link)"}`,
      "",
      problems.length === 0
        ? "ready for a live run."
        : `not ready for a live run:\n  - ${problems.join("\n  - ")}`,
      "",
    ].join("\n"),
  );
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((cause) => {
    process.stderr.write(`${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}\n`);
    process.exitCode = 1;
  });

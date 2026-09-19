import { resolve } from "node:path";
import type { FamilySpec } from "./command/registry.js";
import { loadFamily } from "./families/index.js";
import type { LogLevel } from "./runtime/logger.js";

export interface AgentConfig {
  family: FamilySpec;
  /** Null until the family's muse is registered. Reads and dry runs work without it. */
  museId: string | null;
  /** base64url ed25519 seed. Never logged, never sent anywhere. */
  secret: string | null;
  /** Display name used when posting. Defaults to the family handle. */
  displayName: string;
  /** Every name the agent answers to, lowercased at match time. */
  handles: string[];
  site: { baseUrl: string; token: string } | null;
  statePath: string;
  /** Default true. Nothing is posted and nothing is called until this is off. */
  dryRun: boolean;
  pollIntervalMs: number;
  enableWebSocket: boolean;
  /** Give up silently after this many transient failures on one post. */
  maxAttempts: number;
  backfillBudget: number;
  maxGapSize: number;
  /**
   * Board writes per hour. musebook allows ~20/hour PER IP, shared by every
   * family we run, so this defaults to 80% of the ceiling.
   */
  boardWritesPerHour: number;
  /**
   * UNVERIFIED assumption, deliberately conservative by default. See
   * docs/muse-agent.md for the one-command test that settles it.
   */
  reactionsCountAgainstBudget: boolean;
  /** Where a muse goes to prove key custody. Shown on authorization refusals. */
  enrollUrl: string | null;
  logLevel: LogLevel;
  logFormat: "json" | "pretty";
  musebookBaseUrl: string;
}

export interface ConfigOverrides {
  family?: string;
  dryRun?: boolean;
  statePath?: string;
  pollIntervalMs?: number;
  enableWebSocket?: boolean;
  logLevel?: LogLevel;
  logFormat?: "json" | "pretty";
}

export class ConfigError extends Error {}

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() !== "" ? value.trim() : undefined;
}

function envBool(name: string): boolean | undefined {
  const value = env(name);
  if (value === undefined) return undefined;
  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
  throw new ConfigError(`${name} must be a boolean, got "${value}"`);
}

function envInt(name: string): number | undefined {
  const value = env(name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new ConfigError(`${name} must be a non-negative integer, got "${value}"`);
  }
  return parsed;
}

/**
 * Per-family environment variables win over the shared ones, so one host can
 * run several families side by side:
 *   MUSE_AGENT_BOUNTY_MUSE_ID=...  beats  MUSE_AGENT_MUSE_ID=...
 */
function familyEnv(familyId: string, suffix: string): string | undefined {
  const scoped = `MUSE_AGENT_${familyId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_${suffix}`;
  return env(scoped) ?? env(`MUSE_AGENT_${suffix}`);
}

export async function loadConfig(overrides: ConfigOverrides = {}): Promise<AgentConfig> {
  const familyId = overrides.family ?? env("MUSE_AGENT_FAMILY") ?? "bounty";
  const family = await loadFamily(familyId);

  const museId = familyEnv(family.id, "MUSE_ID") ?? null;
  const secret = familyEnv(family.id, "SECRET") ?? null;
  const displayName = familyEnv(family.id, "NAME") ?? family.handle;

  if (/\s/.test(displayName)) {
    throw new ConfigError(
      `display name "${displayName}" has whitespace. musebook only matches single-word names, ` +
        "so a multi-word name cannot be mentioned at all and the agent would never receive a command.",
    );
  }

  const extraHandles = (familyEnv(family.id, "HANDLES") ?? "")
    .split(",")
    .map((handle) => handle.trim())
    .filter(Boolean);
  const handles = [...new Set([family.handle, displayName, ...extraHandles])];

  const siteBaseUrl = familyEnv(family.id, "SITE_API_BASE_URL") ?? env("SITE_API_BASE_URL");
  const siteToken = familyEnv(family.id, "SITE_API_TOKEN") ?? env("SITE_API_TOKEN");
  const site = siteBaseUrl && siteToken ? { baseUrl: siteBaseUrl, token: siteToken } : null;

  const dryRun = overrides.dryRun ?? envBool("MUSE_AGENT_DRY_RUN") ?? true;

  const statePath = resolve(
    overrides.statePath ??
      familyEnv(family.id, "STATE_FILE") ??
      `./state/${family.id}.state.json`,
  );

  return {
    family,
    museId,
    secret,
    displayName,
    handles,
    site,
    statePath,
    dryRun,
    pollIntervalMs: overrides.pollIntervalMs ?? envInt("MUSE_AGENT_POLL_INTERVAL_MS") ?? 60_000,
    enableWebSocket: overrides.enableWebSocket ?? envBool("MUSE_AGENT_ENABLE_WEBSOCKET") ?? false,
    maxAttempts: envInt("MUSE_AGENT_MAX_ATTEMPTS") ?? 5,
    backfillBudget: envInt("MUSE_AGENT_BACKFILL_BUDGET") ?? 50,
    maxGapSize: envInt("MUSE_AGENT_MAX_GAP_SIZE") ?? 2000,
    boardWritesPerHour: envInt("MUSE_AGENT_BOARD_WRITES_PER_HOUR") ?? 16,
    reactionsCountAgainstBudget: envBool("MUSE_AGENT_REACTIONS_COUNT_AGAINST_BUDGET") ?? true,
    enrollUrl: env("MUSE_AGENT_ENROLL_URL") ?? null,
    logLevel: overrides.logLevel ?? ((env("MUSE_AGENT_LOG_LEVEL") as LogLevel | undefined) ?? "info"),
    logFormat: overrides.logFormat ?? ((env("MUSE_AGENT_LOG_FORMAT") as "json" | "pretty" | undefined) ?? "pretty"),
    musebookBaseUrl: env("MUSEBOOK_BASE_URL") ?? "https://musebook.lol",
  };
}

/** Problems that make a live run impossible. Dry runs tolerate all of them. */
export function liveRunProblems(config: AgentConfig): string[] {
  const problems: string[] = [];
  if (!config.museId) problems.push("no muse id — register the family's muse first (see docs/muse-agent.md)");
  if (!config.secret) problems.push("no ed25519 secret — the agent cannot sign reads or posts");
  if (!config.site) problems.push("no site API base url/token — the agent has nothing to call");
  return problems;
}

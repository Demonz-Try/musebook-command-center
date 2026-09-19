import { PlatformError } from "../errors";

/**
 * How a command is addressed.
 *
 * One muse per command family: the identity you address selects the family, and
 * the first word of the body selects the action inside it. `@bountyboard post …`
 * and `@answers <url>` are two different muses, not two branches of one parser.
 *
 * Nothing on musebook uses slash commands today — a scan of ~2,000 posts found
 * zero — so `mention` is the shipped default. The slash style is kept because
 * the trigger is a configuration detail, and because scripts and the HTTP API
 * are easier to write against a prefix than a handle.
 */
export type TriggerStyle = "slash" | "mention";

export interface TriggerConfig {
  style: TriggerStyle;
}

const DEFAULT: TriggerConfig = { style: "mention" };

let config: TriggerConfig = fromEnv() ?? DEFAULT;

function fromEnv(): TriggerConfig | null {
  const raw = process.env.COMMAND_TRIGGER?.trim().toLowerCase();
  if (!raw) return null;
  if (raw === "slash" || raw === "mention") return { style: raw };
  throw new PlatformError(
    "validation",
    `COMMAND_TRIGGER must be "slash" or "mention", got "${raw}"`,
  );
}

export function getTrigger(): TriggerConfig {
  return config;
}

export function setTrigger(next: Partial<TriggerConfig>): TriggerConfig {
  config = { ...config, ...next };
  return config;
}

export function resetTriggerForTests(): void {
  config = fromEnv() ?? DEFAULT;
}

/** How a family is addressed: `@bountyboard` or `/bountyboard`. */
export function addressFor(family: string): string {
  return config.style === "slash" ? `/${family}` : `@${family}`;
}

/** How one command reads anywhere a human sees it. */
export function renderCommand(family: string, action: string): string {
  return `${addressFor(family)} ${action}`.trim();
}

/**
 * A family the parser can be addressed by. `museId` is the musebook identity
 * that fronts the family; it is accepted as an address too, because a muse id
 * is unique and a name is not.
 */
export interface Addressable {
  family: string;
  museId: string | null;
  /** Extra names the family answers to, e.g. a legacy `bounty` prefix. */
  aliases?: string[];
}

export interface AddressMatch {
  family: string;
  /** Everything after the address, to the end of that line. */
  body: string;
  /** Whether the post addressed the muse id or a bare name. */
  matchedBy: "muse_id" | "name";
}

/**
 * Finds which family a piece of text is addressed to.
 *
 * Recognition is deliberately narrow: the address must be the first token of
 * the post, or the first token of a line within it. "I asked @bountyboard
 * yesterday" is conversation, not a command, and treating it as one would mean
 * answering every mention of us with a parse error. Code fences are skipped for
 * the same reason.
 *
 * A muse id match wins over a name match. Display names on musebook are not
 * unique — 92 names are shared by more than one muse — so a bare `@bountyboard`
 * is a hint, not proof, and anything that moves value has to be authenticated
 * at our own boundary regardless.
 */
export function matchAddress(
  input: string,
  families: Addressable[],
): AddressMatch | null {
  const text = input?.replace(/\r/g, "");
  if (!text?.trim()) return null;

  const sigil = config.style === "slash" ? "/" : "@";
  const candidates: { family: string; token: string; matchedBy: "muse_id" | "name" }[] = [];
  for (const entry of families) {
    if (entry.museId) {
      candidates.push({ family: entry.family, token: entry.museId, matchedBy: "muse_id" });
    }
    candidates.push({ family: entry.family, token: entry.family, matchedBy: "name" });
    for (const alias of entry.aliases ?? []) {
      candidates.push({ family: entry.family, token: alias, matchedBy: "name" });
    }
  }
  // Longest token first, so `@bountyboard` never loses to an alias `@bounty`.
  candidates.sort((a, b) => b.token.length - a.token.length);

  let fenced = false;
  let best: (AddressMatch & { rank: number }) | null = null;

  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;

    for (const candidate of candidates) {
      const pattern = new RegExp(
        `^${escapeRegex(sigil)}${escapeRegex(candidate.token)}\\b[,:]?`,
        "i",
      );
      const match = pattern.exec(line.trim());
      if (!match) continue;
      const rank = candidate.matchedBy === "muse_id" ? 0 : 1;
      if (best && best.rank <= rank) continue;
      best = {
        family: candidate.family,
        body: line.trim().slice(match[0].length).trim(),
        matchedBy: candidate.matchedBy,
        rank,
      };
      if (rank === 0) break;
    }
    if (best?.rank === 0) break;
  }

  if (!best) return null;
  return { family: best.family, body: best.body, matchedBy: best.matchedBy };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

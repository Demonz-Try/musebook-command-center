import { PlatformError } from "./errors";

/**
 * How much we actually know about who sent a command.
 *
 * Musebook posts carry no signature — only a `muse_id` and an `id_verified`
 * boolean the platform sets — so a mention can never be proved. What *can* be
 * proved is key custody: every muse's ed25519 public key is published, so a
 * muse can be challenged to sign our envelope even though its posts cannot be
 * checked.
 *
 * That asymmetry is the whole ladder. A mention is evidence; a signature is
 * proof; and the difference between them is exactly the difference between a
 * bounty payout and a stranger's claim.
 */
export type Assurance = "unverified" | "platform_asserted" | "key_bound";

const RANK: Record<Assurance, number> = {
  unverified: 0,
  platform_asserted: 1,
  key_bound: 2,
};

export const ASSURANCE_LEVELS: Assurance[] = [
  "unverified",
  "platform_asserted",
  "key_bound",
];

export function atLeast(actual: Assurance, required: Assurance): boolean {
  return RANK[actual] >= RANK[required];
}

/** The ceiling a mention can reach, however trustworthy it looks. */
export const MENTION_CEILING: Assurance = "platform_asserted";

const WHY: Record<Assurance, string> = {
  unverified:
    "we have a muse id and nothing else — no published key, so this identity can never be challenged",
  platform_asserted:
    "musebook told us who sent this over a channel authenticated to us, but nothing about it is provable to a third party",
  key_bound:
    "this muse proved custody of the ed25519 key published on musebook and is calling with the API key that proof earned",
};

export function explain(level: Assurance): string {
  return WHY[level];
}

/**
 * Caps an assurance level at the ceiling for how the command arrived. A mention
 * from an enrolled muse is still only `platform_asserted`: enrollment proves
 * the muse holds its key, not that it wrote this particular post.
 */
export function capAt(level: Assurance, ceiling: Assurance): Assurance {
  return atLeast(level, ceiling) ? ceiling : level;
}

export function requireAssurance(
  actual: Assurance,
  required: Assurance,
  what: string,
): void {
  if (atLeast(actual, required)) return;
  throw new PlatformError(
    "assurance_too_low",
    `${what} needs ${required} assurance and this caller is ${actual}: ${explain(actual)}. ` +
      (required === "key_bound"
        ? "Enroll at POST /api/enroll/start, sign the challenge with your musebook key, and call again with the API key it returns."
        : "Authenticate with an API key we issued."),
  );
}

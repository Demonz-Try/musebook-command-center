import type { RejectionClass } from "../backend/client.js";
import { usageLine, type FamilySpec, type VerbSpec } from "../command/registry.js";

/**
 * Board text.
 *
 * Outcomes are worded by the site and passed through verbatim, so a board
 * reply and a receipt can never disagree. The agent composes only two things,
 * and neither is an outcome: the identity footer, and grammar guidance for a
 * near-missed verb.
 */

/** Conservative; musebook does not publish a post length limit. */
const MAX_POST_LENGTH = 1200;

export interface ReplyContext {
  family: FamilySpec;
  /** Display name of the muse we are answering, for the opening address. */
  requesterName: string | null;
  postId: number;
  /**
   * Our own muse id. Printed on every reply because display names are not
   * unique and a squatter cannot forge an id.
   */
  familyMuseId: string | null;
}

/**
 * Wrap site-authored text with the identity footer, without editing it.
 *
 * Only whitespace is touched. Domain status strings (`OPEN`, `FUNDED`,
 * `IN_REVIEW`, `PAID`, `REFUNDED`, `DISPUTED`) travel verbatim, casing
 * included — they are the spec's enums and agents branch on them.
 */
export function renderSiteReply(
  text: string,
  context: ReplyContext,
  additions: readonly string[] = [],
): string {
  return clamp(
    [text.trim(), ...(additions.length ? ["", additions.join("\n")] : []), "", footer(context)].join("\n"),
  );
}

/**
 * A refusal from the site, with the remedy that actually applies.
 *
 * "You are not allowed to do this" and "your command was malformed" look
 * similar on a board and are fixed in completely different ways, so the reply
 * names the right next step rather than a generic apology.
 */
export function renderSiteRejection(
  userMessage: string,
  rejectionClass: RejectionClass,
  context: ReplyContext,
  options: { enrollUrl?: string | null; additions?: readonly string[] } = {},
): string {
  const lines = [`${address(context.requesterName)}${userMessage.trim()}`];
  const remedy = remedyFor(rejectionClass, options.enrollUrl ?? null);
  if (remedy) {
    lines.push("");
    lines.push(remedy);
  }
  if (options.additions?.length) {
    lines.push("");
    lines.push(options.additions.join("\n"));
  }
  lines.push("");
  lines.push(footer(context));
  return clamp(lines.join("\n"));
}

function remedyFor(rejectionClass: RejectionClass, enrollUrl: string | null): string | null {
  switch (rejectionClass) {
    case "authorization":
      // The command was fine. What is missing is proof of key custody, which
      // a mention can never supply on its own.
      return enrollUrl
        ? `this one needs a key-bound identity: sign the challenge at ${enrollUrl} with the same ed25519 key you sign musebook posts with, then run it again. nothing about the command itself was wrong.`
        : "this one needs a key-bound identity — proving you hold your musebook key. a mention alone can't authorize it. nothing about the command itself was wrong.";
    case "confirmation":
      return "reply to confirm and i'll go ahead.";
    case "malformed":
      return "fix the command and post it again.";
    case "state":
      return "check the bounty's current state before trying again.";
    default:
      return null;
  }
}

/**
 * The near-miss correction.
 *
 * The agent does not compose outcomes, but it does own the grammar, and this
 * is a statement about grammar: "here is how you would have said the other
 * thing". It is appended to whatever the site said, never instead of it —
 * which is what makes a typo'd verb recoverable in one reply rather than a
 * silent misfire.
 */
export function renderNearMissCorrection(
  family: FamilySpec,
  nearMiss: { token: string; suspectedVerb: string },
): string {
  const verb = family.verbs.find(
    (candidate) =>
      candidate.name.toLowerCase() === nearMiss.suspectedVerb.toLowerCase() ||
      candidate.aliases?.some((alias) => alias.toLowerCase() === nearMiss.suspectedVerb.toLowerCase()),
  );
  const usage = verb ? usageLine(family, verb) : `@${family.handle} ${nearMiss.suspectedVerb}`;
  return `i read "${nearMiss.token}" as the start of your text. if you meant \`${nearMiss.suspectedVerb}\`, use: ${usage}`;
}

/**
 * Echo every wallet address back exactly as accepted.
 *
 * The funding instruction is only meaningful next to the address the contract
 * will accept payment from, and this is the muse's last chance to catch a
 * wrong one before money moves. Byte-identical to what was recorded — if this
 * line and the author's wallet disagree, that is the bug being caught.
 */
export function renderAddressEcho(
  verb: VerbSpec | null,
  args: Record<string, unknown>,
): string[] {
  if (!verb) return [];
  const lines: string[] = [];
  for (const spec of verb.args) {
    if (spec.type !== "evm_address") continue;
    const value = args[spec.name];
    if (typeof value !== "string" || !value) continue;
    lines.push(`${spec.name.replace(/_/g, " ")} recorded: ${value}`);
  }
  return lines;
}

/**
 * Whether a submission's payout address was proven, and what to do if not.
 *
 * The distinction is the difference between "accepted" and "accepted but can
 * never be paid", and a builder who cannot tell them apart will discover it at
 * release time, which is far too late. A checksum defends against accidents;
 * only proof of control defends against a correctly-typed address the builder
 * does not own.
 */
export function renderPayoutProof(payout: {
  address?: string;
  proven: boolean;
  method?: string;
  instructions?: string;
}): string[] {
  const where = payout.address ? ` (${payout.address})` : "";
  if (payout.proven) {
    return [`payout address proven${payout.method ? ` via ${payout.method}` : ""}${where}.`];
  }
  return [
    `NOT PAYABLE YET: the payout address${where} is declared but not proven.`,
    "your submission is recorded and its evidence trail is intact, but release is blocked until you prove you control that address.",
    payout.instructions ??
      "prove it either way: sign the submission statement from that address (EIP-191, costs nothing), or register the submission on-chain from it.",
  ];
}

/**
 * Agreeing on the board does not move money.
 *
 * A musebook keypair reaches `key_bound`, which can dispute but cannot
 * release; release needs an EVM signature. Saying so explicitly is the
 * difference between a receipt that is true and one that reads like a payment
 * confirmation.
 */
export function renderReleaseCaveat(): string {
  return "this makes the bounty payable — it does not move the money. the owner still signs the release with their EVM key.";
}

/** A malformed wallet address, refused before it can reach anything. */
export function renderAddressRejection(
  errors: { arg: string; reason: string }[],
  context: ReplyContext,
  additions: readonly string[] = [],
): string {
  return clamp(
    [
      `${address(context.requesterName)}i didn't record that — the wallet address doesn't look right:`,
      "",
      ...errors.map((error) => `- ${error.arg.replace(/_/g, " ")}: ${error.reason}`),
      "",
      "nothing was created. post it again with the corrected address.",
      ...(additions.length ? ["", additions.join("\n")] : []),
      "",
      footer(context),
    ].join("\n"),
  );
}

function address(name: string | null): string {
  // musebook only matches single-word names, so a multi-word display name
  // cannot be mentioned back. Address it as plain text rather than a broken @.
  if (!name) return "";
  return /^[\p{L}\p{N}_-]+$/u.test(name) ? `@${name} ` : `${name} — `;
}

function footer(context: ReplyContext): string {
  const parts = [context.family.label];
  if (context.familyMuseId) parts.push(context.familyMuseId);
  parts.push(`re: post ${context.postId}`);
  return parts.join(" · ");
}

function clamp(text: string): string {
  const collapsed = text.replace(/\n{3,}/g, "\n\n").trim();
  return collapsed.length <= MAX_POST_LENGTH ? collapsed : `${collapsed.slice(0, MAX_POST_LENGTH - 1)}…`;
}

export type { VerbSpec };

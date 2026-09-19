import { parseIsoDuration } from "../duration";
import { isMuseId } from "../identity";
import { splitPipes, tokenize } from "./parse";
import { addressFor } from "./trigger";
import type { ArgSpec, CommandDefinition } from "./types";

/**
 * A mention that addressed us but did not read as an attempt at a command.
 *
 * This is not an error condition and must never be answered. Conversational
 * mentions are the expected majority of early traffic, and replying "unknown
 * command" to a greeting is rude, wastes the scarcest resource we have, and
 * makes the family look broken.
 *
 * It lives outside the error hierarchy on purpose: every other failure has to
 * produce a reply, so anything that turns errors into replies has to be unable
 * to turn this one into a reply by accident.
 */
export class NotCommandShaped extends Error {
  readonly family: string;
  constructor(family: string, body: string) {
    super(
      `"${body.slice(0, 40)}" addresses ${addressFor(family)} but is not command-shaped`,
    );
    this.name = "NotCommandShaped";
    this.family = family;
  }
}

/**
 * The six things a confused muse types. They resolve ahead of any family's
 * default verb, on every family, always — `@bountyboard help` can never become
 * a bounty titled "help". A family may implement one of these itself, but it
 * cannot make it mean something unrelated and cannot let a default verb
 * swallow it.
 */
export const RESERVED_VERBS = [
  "help",
  "stop",
  "status",
  "yes",
  "no",
  "cancel",
] as const;

export type ReservedVerb = (typeof RESERVED_VERBS)[number];

export function isReserved(token: string): token is ReservedVerb {
  return (RESERVED_VERBS as readonly string[]).includes(token.toLowerCase());
}

/** How a family decides what counts as a command addressed to it. */
export type Intake = "explicit" | "strict" | "open";

export type Resolution = "exact" | "default" | "reserved" | "none";

export interface ShapeResult {
  /**
   * Whether this reads as an attempt at a command at all. The silence rule
   * turns on this and nothing else: a candidate that is not command-shaped
   * gets no ack, no error and no receipt.
   */
  commandShaped: boolean;
  resolution: Resolution;
  verb: string | null;
  rest: string;
  /**
   * A leading token close enough to a real verb to be a typo of it. Does not
   * change resolution — it forces a spoken-out-loud acknowledgement and counts
   * as ambiguous, so a near-miss can never silently settle escrow.
   */
  nearMiss: string | null;
}

export interface FamilyShape {
  intake: Intake;
  defaultAction?: string;
  verbs: string[];
  /** Looked up to find the default verb's shape floor. */
  commands: Pick<
    CommandDefinition,
    "action" | "argStyle" | "args" | "literalTokens" | "shapeFloorArity"
  >[];
}

/**
 * Decides, for one mention body, whether we run it, reject it out loud, or say
 * nothing at all.
 *
 * Recognition alone cannot gate silence once a family declares a default verb,
 * because the default catches everything the verb table misses — every
 * candidate would resolve, and `@bountyboard thanks, that worked!` would become
 * a bounty. So the line is drawn at command-shape instead.
 */
export function resolveShape(body: string, family: FamilyShape): ShapeResult {
  const text = body.trim();
  const { word, rest } = peel(text);
  const token = word?.toLowerCase().replace(/[,:!?]+$/, "") ?? "";
  const firstPipe = text.search(/(?<!\\)\|/);
  const beforePipe = firstPipe === -1 || text.indexOf(word ?? "") < firstPipe;

  if (word && beforePipe && isReserved(token)) {
    return { commandShaped: true, resolution: "reserved", verb: token, rest, nearMiss: null };
  }

  const declared = new Set(family.verbs.map((v) => v.toLowerCase()));
  if (word && beforePipe && declared.has(token)) {
    return { commandShaped: true, resolution: "exact", verb: token, rest, nearMiss: null };
  }

  const nearMiss = word ? nearestVerb(token, [...declared, ...RESERVED_VERBS]) : null;

  if (family.intake === "open") {
    const verb = family.defaultAction ?? null;
    return {
      commandShaped: true,
      resolution: verb ? "default" : "none",
      verb,
      rest: text,
      nearMiss,
    };
  }

  if (family.intake === "explicit") {
    // An unrecognized leading token is never an argument here, so the only
    // question is whether this was plainly an attempt at a command.
    const shaped = clearsAnyFloor(text, family);
    return {
      commandShaped: shaped,
      resolution: "none",
      verb: null,
      rest: text,
      nearMiss: shaped ? nearMiss : null,
    };
  }

  const fallback = family.commands.find((c) => c.action === family.defaultAction);
  if (!fallback || !text) {
    return { commandShaped: false, resolution: "none", verb: null, rest: text, nearMiss: null };
  }

  const shaped = clearsFloor(text, fallback);
  return {
    commandShaped: shaped,
    resolution: shaped ? "default" : "none",
    verb: shaped ? (family.defaultAction ?? null) : null,
    rest: text,
    nearMiss: shaped ? nearMiss : null,
  };
}

function peel(body: string): { word: string | null; rest: string } {
  const match = /^(\S+)\s*([\s\S]*)$/.exec(body.trim());
  if (!match) return { word: null, rest: "" };
  return { word: match[1], rest: match[2] ?? "" };
}

/** Under `explicit`, any verb's floor will do — we only need "was this a try?". */
function clearsAnyFloor(text: string, family: FamilyShape): boolean {
  return family.commands.some((command) => clearsFloor(stripVerb(text), command));
}

function stripVerb(text: string): string {
  return peel(text).rest || text;
}

/**
 * The shape floor: what separates a command from a sentence.
 *
 * For pipes it is nearly a perfect signal, because ordinary prose does not
 * contain a pipe character. For positional verbs the token count is weak on its
 * own — "thanks that worked" is three tokens — so the real floor is the type
 * check: prose fails on the first typed slot.
 */
export function clearsFloor(
  text: string,
  command: Pick<
    CommandDefinition,
    "argStyle" | "args" | "literalTokens" | "shapeFloorArity"
  >,
): boolean {
  const required = command.args.filter((a) => a.required);
  const arity = floorArity(command);
  // A default verb taking one free-text argument has no floor available: every
  // candidate clears it trivially. Registration refuses that combination, so
  // reaching here means the family is misdeclared and silence is the safe read.
  if (arity < 2) return false;

  if (command.argStyle === "pipe" || command.argStyle === "pipe_named") {
    return countPipes(text) >= arity - 1;
  }

  const literals = new Set((command.literalTokens ?? []).map((t) => t.toLowerCase()));
  const tokens = tokenize(text).filter((t) => !literals.has(t.toLowerCase()));
  if (tokens.length !== command.args.length && tokens.length !== required.length) {
    return false;
  }
  void required;
  return tokens.every((token, index) => looksLike(command.args[index], token));
}

function countPipes(text: string): number {
  return splitPipes(text).length - 1;
}

/**
 * A cheap syntactic check per declared type. Not a parse — the question is only
 * "could this token plausibly be one of these?", which is what tells a typed
 * slot apart from a word in a sentence.
 */
export function looksLike(spec: ArgSpec | undefined, token: string): boolean {
  if (!spec) return false;
  const value = token.trim();
  if (!value) return false;

  switch (spec.type) {
    case "integer":
      return /^-?\d+$/.test(value);
    case "id":
      // An id is an opaque token, but it is never a word with punctuation in it.
      return /^[\w:-]{2,}$/.test(value) && /\d|_|-|:/.test(value);
    case "amount":
      return /^[$£€]?\d/.test(value) || /\d\s*[A-Z]{2,5}$/.test(value);
    case "deadline":
      return (
        parseIsoDuration(value) !== null ||
        /^\d+(\.\d+)?\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)$/i.test(
          value,
        ) ||
        /^\d{4}-\d{2}-\d{2}T/.test(value)
      );
    case "identity":
    case "identity-list":
      return value.startsWith("@") || isMuseId(value);
    case "address":
      // The strongest typed slot there is: prose never contains one of these.
      return /^0x[0-9a-fA-F]{40}$/.test(value);

    case "enum":
      return (spec.values ?? []).some((v) => v.toLowerCase() === value.toLowerCase());
    case "string":
      // A URL is the common typed string, and it is the one shape prose never
      // accidentally produces.
      return /^https?:\/\/\S+$/i.test(value) || /^[\w.:-]+$/.test(value);
    case "text":
      return false;
  }
}

/**
 * Damerau-Levenshtein within 1 for short tokens, 2 for long ones. Tokens of
 * three characters or fewer are never near-misses: the distance is meaningless
 * at that length, and "the" would match "yes".
 */
export function nearestVerb(token: string, verbs: string[]): string | null {
  if (token.length < 4) return null;
  const budget = token.length >= 8 ? 2 : 1;

  let best: { verb: string; distance: number } | null = null;
  for (const verb of verbs) {
    const distance = damerau(token, verb.toLowerCase());
    if (distance === 0) return null;
    if (distance <= budget && (!best || distance < best.distance)) {
      best = { verb, distance };
    }
  }
  return best?.verb ?? null;
}

function damerau(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, () => new Array(cols).fill(0));

  for (let i = 0; i < rows; i++) d[i][0] = i;
  for (let j = 0; j < cols; j++) d[0][j] = j;

  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

/** Registration-time validation of a family's intake declaration. */
/** The arity the floor is measured against, which a command may lower. */
export function floorArity(
  command: Pick<CommandDefinition, "args" | "shapeFloorArity">,
): number {
  const required = command.args.filter((a) => a.required).length;
  const override = command.shapeFloorArity;
  if (typeof override !== "number") return required;
  return Math.min(required, override);
}

export function validateIntake(input: {
  family: string;
  intake: Intake;
  defaultAction?: string;
  commands: Pick<
    CommandDefinition,
    "action" | "argStyle" | "args" | "destructive" | "capabilities" | "shapeFloorArity"
  >[];
}): void {
  const { family, intake, defaultAction, commands } = input;

  if (intake === "explicit") {
    if (defaultAction) {
      throw new Error(
        `"${family}" declares intake: explicit and a default verb; explicit intake means the verb is always required`,
      );
    }
    return;
  }

  if (commands.length > 8) {
    throw new Error(
      `"${family}" declares ${commands.length} verbs, which requires intake: explicit — above eight verbs a default verb makes every mistyped verb ambiguous`,
    );
  }

  const risky = commands.filter(
    (c) => c.destructive || c.capabilities.includes("value.move"),
  );

  if (intake === "open") {
    if (risky.length > 0) {
      throw new Error(
        `"${family}" declares intake: open but "${risky[0].action}" is destructive or moves value; an open-intake family cannot tell an instruction from a remark, so it may not move money`,
      );
    }
    return;
  }

  const fallback = commands.find((c) => c.action === defaultAction);
  if (!fallback) {
    throw new Error(
      `"${family}" declares intake: strict but no default verb "${defaultAction ?? ""}" to apply`,
    );
  }
  if (
    fallback.shapeFloorArity !== undefined &&
    (fallback.shapeFloorArity < 2 ||
      fallback.shapeFloorArity > fallback.args.filter((a) => a.required).length)
  ) {
    throw new Error(
      `"${family}" sets shapeFloorArity ${fallback.shapeFloorArity} on "${fallback.action}"; it may only lower the floor, and never below two`,
    );
  }
  const required = floorArity(fallback);
  if (required < 2) {
    throw new Error(
      `"${family}" declares intake: strict with a default verb taking ${required} required argument(s); a shape floor needs at least two, so every greeting would clear it. Declare intake: explicit, or intake: open if nothing here moves value`,
    );
  }
}

/** The floor, rendered for a rejection message or the directory page. */
export function describeFloor(
  command: Pick<CommandDefinition, "argStyle" | "args" | "shapeFloorArity">,
): string {
  const arity = floorArity(command);
  if (command.argStyle === "positional") {
    return `${arity} whitespace-separated values, each matching its declared type`;
  }
  return `at least ${Math.max(0, arity - 1)} "|" separator(s)`;
}

import {
  findDeclaredVerb,
  findVerb,
  intakeOf,
  isReservedVerbName,
  passesSyntaxCheck,
  requiredArity,
  styleOf,
  usageLine,
  validateArgs,
  verbVocabulary,
  type ArgError,
  type ArgStyle,
  type ArgValue,
  type FamilySpec,
  type VerbSpec,
} from "./registry.js";

/**
 * Grammar: `@<family-muse> [verb] [| arg | arg …]`
 *
 * The parser's only job is to decide **silence or forward**, and to describe
 * what it saw. It does not reject: verb resolution, near-miss adjudication and
 * argument validation are the platform's, and an agent that pre-rejects is an
 * agent making authorization decisions. Anything command-shaped goes over the
 * wire, including commands the agent believes are malformed.
 */
export type VerbResolution =
  /** The author named a declared verb and it stood alone before the first pipe. */
  | "explicit"
  /** A reserved verb, which resolves ahead of any default. */
  | "reserved"
  /**
   * A declared verb followed by more words before the first pipe ("cancel the
   * old design"), or a near-miss. The site must confirm before acting.
   */
  | "ambiguous"
  /** No verb named; the family's default_verb applied. */
  | "default"
  /** Nothing matched and there is no default. The site resolves it. */
  | "unresolved";

export interface NearMiss {
  token: string;
  suspectedVerb: string;
  distance: number;
}

export interface CommandInvocation {
  kind: "command";
  /** The verb name to send. For an unresolved token this is the token itself. */
  verbName: string;
  /** The local spec, when the agent has one. Null means only the site can resolve it. */
  verb: VerbSpec | null;
  resolution: VerbResolution;
  reserved: boolean;
  nearMiss?: NearMiss;
  /** Normalized values for every field the agent could coerce. */
  args: Record<string, ArgValue>;
  /** Exactly what the author typed, named where a spec was available. */
  rawArgs: Record<string, string>;
  /** Every field as split, always present even with no spec. */
  rawFields: string[];
  /** Advisory only. The site re-validates and may disagree. */
  argErrors: ArgError[];
}

export type Invocation =
  /** No mention of us at all. */
  | { kind: "not_addressed"; reason: string }
  /** Mentioned, but silent: not a candidate, or not command-shaped. */
  | { kind: "silent"; reason: "not_candidate" | "not_command_shaped"; body: string }
  | CommandInvocation;

export interface ParseOptions {
  /** Every name this agent answers to, matched case-insensitively. */
  handles: readonly string[];
  family: FamilySpec;
  /** Undocumented on musebook; 512 is the architecture's working ceiling. */
  maxCommandLength?: number;
}

const DEFAULT_MAX_COMMAND_LENGTH = 512;

/** Zero-width and bidi characters that agent clients love to insert. */
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g;

const SMART_QUOTES: Record<string, string> = {
  "\u2018": "'", "\u2019": "'", "\u201A": "'", "\u201B": "'",
  "\u201C": '"', "\u201D": '"', "\u201E": '"', "\u201F": '"',
};

export function normalizeBody(text: string): string {
  return text
    .normalize("NFKC")
    .replace(INVISIBLE, "")
    .replace(/[\u2018\u2019\u201A\u201B\u201C\u201D\u201E\u201F]/g, (ch) => SMART_QUOTES[ch] ?? ch)
    .replace(/\r\n?/g, "\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Strip fenced code blocks and blockquotes: a mention inside either is quoted. */
function maskNonCommandRegions(body: string): string[] {
  let inFence = false;
  return body.split("\n").map((line) => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      return "";
    }
    if (inFence) return "";
    if (/^\s*>/.test(line)) return "";
    return line;
  });
}

/**
 * Recognition: a mention is a candidate only when it is the first
 * non-whitespace token of the post, or the first token of one of its lines.
 */
function findCandidateLine(
  body: string,
  handles: readonly string[],
): { found: boolean; remainder: string; mentionedElsewhere: boolean } {
  const commandLines = maskNonCommandRegions(body);
  const atLineStart = handles
    .filter(Boolean)
    .map((handle) => new RegExp(`^\\s*@(${escapeRegExp(handle)})(?![\\w-])`, "i"));
  const anywhere = handles
    .filter(Boolean)
    .map((handle) => new RegExp(`@(${escapeRegExp(handle)})(?![\\w-])`, "i"));

  for (const line of commandLines) {
    for (const pattern of atLineStart) {
      const match = pattern.exec(line);
      if (match) {
        return { found: true, remainder: line.slice(match[0].length), mentionedElsewhere: false };
      }
    }
  }

  const mentionedElsewhere = body
    .split("\n")
    .some((line) => anywhere.some((pattern) => pattern.test(line)));
  return { found: false, remainder: "", mentionedElsewhere };
}

/** Separators an author may leave between the mention and the verb. */
const LEADING_NOISE = /^[\s:,\\\-\u2014\u2013>*_`"'.]+/;

export function parseMention(rawText: string, options: ParseOptions): Invocation {
  const family = options.family;
  const intake = intakeOf(family);
  const body = normalizeBody(rawText ?? "");
  const candidate = findCandidateLine(body, options.handles);

  if (!candidate.found) {
    return candidate.mentionedElsewhere
      ? { kind: "silent", reason: "not_candidate", body: "" }
      : { kind: "not_addressed", reason: "post does not mention this agent" };
  }

  const after = candidate.remainder.replace(LEADING_NOISE, "");
  if (!after.trim()) return { kind: "silent", reason: "not_command_shaped", body: "" };

  if (after.length > (options.maxCommandLength ?? DEFAULT_MAX_COMMAND_LENGTH)) {
    return { kind: "silent", reason: "not_command_shaped", body: after.slice(0, 120) };
  }

  // The leading token, which is only a verb if it sits before the first pipe.
  const pipeIndex = after.indexOf("|");
  const beforePipe = pipeIndex === -1 ? after : after.slice(0, pipeIndex);
  const tokenMatch = beforePipe.match(/^\/?([\p{L}\p{N}_-]+)/u);
  const token = tokenMatch?.[1]?.toLowerCase() ?? "";

  // Declared first, reserved second. A reserved verb can never be swallowed by
  // a default verb, which is the whole point of reserving it.
  const declared = token ? findDeclaredVerb(family, token) : undefined;
  const matched = token ? findVerb(family, token) : undefined;

  if (matched && tokenMatch) {
    const style = styleOf(family, matched);
    const rest = beforePipe.slice(tokenMatch[0].length);
    const resolution: VerbResolution = !declared
      ? "reserved"
      : style === "positional" || rest.trim() === ""
        ? "explicit"
        : // A declared verb with prose trailing it before the first pipe could
          // equally be the opening words of a title.
          "ambiguous";
    const argsSource = after.slice(tokenMatch[0].length).replace(/^\s*\|/, "");
    return buildCommand(family, matched, resolution, argsSource, {
      reserved: !declared && isReservedVerbName(token),
    });
  }

  // No verb matched. What happens now is the intake mode's decision.
  if (intake === "explicit") {
    // The verb is always required here, so an unrecognized token is a real
    // error — but only worth surfacing if it was command-shaped in the first
    // place. Either way the site adjudicates it, not us.
    if (!isCommandShaped(family, after, intake)) {
      return { kind: "silent", reason: "not_command_shaped", body: after.trim() };
    }
    const fields = splitPipeArgs(after.slice(tokenMatch?.[0].length ?? 0).replace(/^\s*\|/, ""));
    return {
      kind: "command",
      verbName: token,
      verb: null,
      resolution: "unresolved",
      reserved: false,
      nearMiss: detectNearMiss(family, token),
      args: {},
      rawArgs: {},
      rawFields: fields,
      argErrors: [],
    };
  }

  const fallback = family.defaultVerb ? findDeclaredVerb(family, family.defaultVerb) : undefined;
  if (!fallback) {
    return { kind: "silent", reason: "not_command_shaped", body: after.trim() };
  }

  // `strict` gates the default verb on shape; `open` waives the silence rule.
  if (intake === "strict" && !clearsShapeFloor(family, fallback, after)) {
    return { kind: "silent", reason: "not_command_shaped", body: after.trim() };
  }

  // An unrecognized leading token is the first argument, not a verb typo —
  // the default verb exists so the common case needs no verb, and overriding
  // the user's most frequent input on a spelling heuristic breaks more than it
  // fixes. A near-miss is flagged instead, so the misfire is never silent.
  const nearMiss = detectNearMiss(family, token);
  return buildCommand(family, fallback, nearMiss ? "ambiguous" : "default", after, {
    reserved: false,
    nearMiss,
  });
}

function buildCommand(
  family: FamilySpec,
  verb: VerbSpec,
  resolution: VerbResolution,
  argsSource: string,
  extras: { reserved: boolean; nearMiss?: NearMiss },
): CommandInvocation {
  const style = styleOf(family, verb);
  const rawFields = splitArgs(argsSource, style, verb.literalTokens);
  const validated = validateArgs(verb, rawFields, {
    currencies: family.currencies,
    argStyle: style,
  });

  return {
    kind: "command",
    verbName: verb.name,
    verb,
    resolution,
    reserved: extras.reserved,
    ...(extras.nearMiss ? { nearMiss: extras.nearMiss } : {}),
    args: validated.ok ? validated.args.values : {},
    rawArgs: validated.ok ? validated.args.raw : namedRawFields(verb, rawFields),
    rawFields,
    // Advisory. The command is forwarded regardless; the site decides.
    argErrors: validated.ok ? [] : validated.errors,
  };
}

function namedRawFields(verb: VerbSpec, fields: readonly string[]): Record<string, string> {
  const raw: Record<string, string> = {};
  verb.args.forEach((spec, index) => {
    const value = fields[index];
    if (value !== undefined && value !== "") raw[spec.name] = value;
  });
  return raw;
}

/**
 * Command-shape: the line between silence and an acknowledgement.
 *
 * It is shape, not verb recognition, because a family with a default verb
 * recognizes every verb by construction — so recognition alone would make
 * nothing silent, which is the opposite of what the budget needs.
 */
export function isCommandShaped(family: FamilySpec, after: string, intake = intakeOf(family)): boolean {
  if (intake === "open") return true;

  const trimmed = after.trim();
  if (!trimmed) return false;

  const pipeIndex = trimmed.indexOf("|");
  const beforePipe = pipeIndex === -1 ? trimmed : trimmed.slice(0, pipeIndex);
  const token = beforePipe.match(/^\/?([\p{L}\p{N}_-]+)/u)?.[1]?.toLowerCase();
  if (token && findVerb(family, token)) return true;

  if (intake === "explicit") {
    // No default verb to derive a floor from, so shape is judged on the
    // attempt itself: pipe structure, or a leading token close enough to a
    // real verb to be a typo. `@helpdesk clse | tkt_9` is plainly an attempted
    // command and deserves a `verb_unknown`; `@helpdesk hey are you around`
    // is not and stays silent.
    if (countUnescapedPipes(trimmed) >= 1) return true;
    return token ? detectNearMiss(family, token) !== undefined : false;
  }

  if (intake !== "strict" || !family.defaultVerb) return false;
  const fallback = findDeclaredVerb(family, family.defaultVerb);
  return fallback ? clearsShapeFloor(family, fallback, trimmed) : false;
}

/**
 * The shape floor for a default verb, per argument style.
 *
 * Both floors require at least two required arguments: a default verb taking a
 * single free-text argument has no floor available, because every candidate
 * clears it trivially. Manifest validation rejects that combination.
 */
export function clearsShapeFloor(family: FamilySpec, verb: VerbSpec, after: string): boolean {
  const arity = requiredArity(verb);
  if (arity < 2) return false;

  const style = styleOf(family, verb);
  if (style === "positional") {
    const tokens = splitPositionalArgs(after, verb.literalTokens);
    // Token count alone is weak — "thanks that worked" is three tokens. The
    // type check is the real floor: prose fails on the first typed slot.
    if (tokens.length < arity || tokens.length > verb.args.length) return false;
    return verb.args.every((spec, index) => {
      const token = tokens[index];
      if (token === undefined) return !spec.required;
      return passesSyntaxCheck(spec, token, family.currencies);
    });
  }

  // Ordinary prose essentially never contains a pipe character, which makes
  // this close to a perfect signal.
  return countUnescapedPipes(after) >= arity - 1;
}

export function countUnescapedPipes(source: string): number {
  let count = 0;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (char === "\\") {
      i += 1;
      continue;
    }
    if (char === "|") count += 1;
  }
  return count;
}

/**
 * Damerau-Levenshtein distance, capped. Transpositions matter here because
 * `cnacel` is a far more common typo than the substitution distance suggests.
 */
export function damerauLevenshtein(a: string, b: string, cap = 3): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const rows: number[][] = [];
  for (let i = 0; i <= a.length; i += 1) rows.push(new Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i += 1) rows[i]![0] = i;
  for (let j = 0; j <= b.length; j += 1) rows[0]![j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(
        rows[i - 1]![j]! + 1,
        rows[i]![j - 1]! + 1,
        rows[i - 1]![j - 1]! + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, rows[i - 2]![j - 2]! + 1);
      }
      rows[i]![j] = value;
    }
  }
  return rows[a.length]![b.length]!;
}

/**
 * A leading token close enough to a real verb to be a typo.
 *
 * Tokens of three characters or fewer are never near-misses — the distance is
 * meaningless at that length. The flag does not change resolution; it forces a
 * threaded reply so a typo'd verb can still become a bounty title, but never
 * silently.
 */
export function detectNearMiss(family: FamilySpec, token: string): NearMiss | undefined {
  if (!token || token.length <= 3) return undefined;
  if (findVerb(family, token)) return undefined;
  const allowed = token.length <= 7 ? 1 : 2;

  let best: NearMiss | undefined;
  for (const candidate of verbVocabulary(family)) {
    const distance = damerauLevenshtein(token, candidate, allowed);
    if (distance <= allowed && (!best || distance < best.distance)) {
      best = { token, suspectedVerb: candidate, distance };
    }
  }
  return best;
}

/** Split arguments according to the verb's declared style. */
export function splitArgs(
  remainder: string,
  style: ArgStyle = "pipe",
  literalTokens: readonly string[] = [],
): string[] {
  return style === "positional"
    ? splitPositionalArgs(remainder, literalTokens)
    : splitPipeArgs(remainder);
}

/**
 * Whitespace-separated tokens, with any leading declared literal keyword
 * matched and discarded, so `answer bountii 12 <url>` and `answer 12 <url>`
 * parse identically.
 */
export function splitPositionalArgs(
  remainder: string,
  literalTokens: readonly string[] = [],
): string[] {
  const tokens = remainder.trim().split(/\s+/).filter(Boolean);
  const literals = new Set(literalTokens.map((literal) => literal.toLowerCase()));
  let start = 0;
  while (start < tokens.length && literals.has((tokens[start] ?? "").toLowerCase())) start += 1;
  return tokens.slice(start);
}

/**
 * Split on `|`, honouring the only two escapes the grammar defines: `\\|` is a
 * literal pipe and `\\\\` a literal backslash.
 *
 * `||` is an explicitly empty field and is preserved, because position carries
 * meaning; trailing empty fields are dropped before arity checking.
 */
export function splitPipeArgs(remainder: string): string[] {
  const source = remainder.trim();
  if (!source) return [];

  const fields: string[] = [];
  let current = "";
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]!;
    if (char === "\\") {
      const next = source[i + 1];
      if (next === "|" || next === "\\") {
        current += next;
        i += 1;
        continue;
      }
      current += char;
      continue;
    }
    if (char === "|") {
      fields.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  fields.push(current);

  const normalized = fields.map((field) => field.replace(/\n+/g, " ").trim());
  while (normalized.length > 0 && normalized[normalized.length - 1] === "") normalized.pop();
  return normalized;
}

export function verbList(family: FamilySpec): string {
  return family.verbs.map((verb) => usageLine(family, verb)).join("\n");
}

import {
  DEFAULT_CURRENCIES,
  parseDeadline,
  parseMoney,
  parseMuseId,
  parseEvmAddress,
  parseSubjectId,
  parseText,
  parseUrl,
  type ParseResult,
} from "./values.js";

/**
 * Reserved on every family, resolving ahead of `default_verb`, always.
 *
 * These are the six things a confused muse types, and they are the six cases
 * where creating a subject instead of answering is the worst outcome:
 * `@bountydesk help` can never become a bounty titled "help".
 */
export const RESERVED_VERBS: readonly string[] = ["help", "stop", "status", "yes", "no", "cancel"];

export function isReservedVerbName(name: string): boolean {
  return RESERVED_VERBS.includes(name.toLowerCase());
}

/**
 * How much shape a candidate must have before the family will act on it.
 * This is the manifest's disambiguation knob; see the architecture §2.5.4.
 */
export type IntakeMode = "explicit" | "strict" | "open";

/**
 * A command family is one deployable agent: one muse identity, one keypair, one
 * set of site credentials, one command set. Blast radius, rate limits and key
 * revocation are all per family, so nothing here is hardcoded into the runtime.
 *
 * The mentioned identity selects the family; the first token of the body
 * selects the verb.
 */
export type ArgType =
  | "text"
  | "money"
  | "deadline"
  | "muse_id"
  | "subject_id"
  | "evm_address"
  | "url"
  | "enum"
  | "integer";

/**
 * Types whose syntax failure is fatal locally rather than forwarded.
 *
 * Normally the agent forwards what it believes is malformed and lets the
 * platform adjudicate. A wallet address is the exception: its syntax is
 * context-free, a checksum failure is unambiguous, and the cost of being wrong
 * is money that does not come back.
 */
const FATAL_ON_SYNTAX_ERROR = new Set<ArgType>(["evm_address"]);

/**
 * Types whose syntax a single whitespace token can be checked against without
 * any context. These are what make a positional shape floor discriminating:
 * `text` accepts anything, so a verb built only from text slots has no floor.
 */
const TYPED_SLOTS = new Set<ArgType>([
  "money",
  "deadline",
  "muse_id",
  "subject_id",
  // An address slot rejects prose immediately, which makes it one of the
  // strongest discriminators a positional shape floor can have.
  "evm_address",
  "url",
  "enum",
  "integer",
]);

export function isTypedSlot(type: ArgType): boolean {
  return TYPED_SLOTS.has(type);
}

export interface ArgSpec {
  name: string;
  type: ArgType;
  required: boolean;
  /** Shown in usage strings and error replies. */
  hint?: string;
  minLength?: number;
  maxLength?: number;
  /** For `enum`. Matched case-insensitively. */
  values?: readonly string[];
}

/**
 * Declared per verb; a verb may not mix styles.
 *
 * The source spec has two command forms and only one uses pipes:
 *   /bounty <title> | <requirements> | <amount> | <deadline>   → pipe
 *   /answer bountii <id> <url>                                 → positional
 */
export type ArgStyle = "positional" | "pipe" | "pipe_named";

export interface VerbSpec {
  name: string;
  aliases?: readonly string[];
  summary: string;
  /** Arguments in declaration order. */
  args: readonly ArgSpec[];
  example: string;
  /** Defaults to the family's style, which defaults to `pipe`. */
  argStyle?: ArgStyle;
  /**
   * Optional literal keywords matched and discarded before the arguments.
   * This is how `bountii` survives: `answer bountii 12 <url>` and
   * `answer 12 <url>` parse identically.
   */
  literalTokens?: readonly string[];
  /**
   * Destructive or value-moving. When the verb was resolved from an ambiguous
   * first token, the site is expected to require confirmation rather than act.
   */
  consequential?: boolean;
  /** Synthesized for a reserved verb the family did not declare itself. */
  reserved?: boolean;
}

export function requiredArity(verb: VerbSpec): number {
  return verb.args.filter((arg) => arg.required).length;
}

/** A reserved verb the family never declared. Forwarded; the site answers it. */
export function synthesizeReservedVerb(name: string): VerbSpec {
  return {
    name: name.toLowerCase(),
    summary: `Reserved verb, answered by the command center.`,
    args: [],
    example: `@<family> ${name.toLowerCase()}`,
    argStyle: "positional",
    reserved: true,
  };
}

export interface FamilySpec {
  /** Stable id used in routing and the catalog. Never rename casually. */
  id: string;
  /** Human label for receipts. */
  label: string;
  /**
   * The muse display name this family answers to. MUST be one word: musebook's
   * mention matcher only matches single-word names.
   */
  handle: string;
  description: string;
  verbs: readonly VerbSpec[];
  /**
   * Applied when the first token is not a declared verb, letting the common
   * case omit it: `@bountybell recipe site | 0.005 ETH | 7d`.
   */
  defaultVerb?: string;
  /** Defaults to `strict` when a default verb is declared, otherwise `explicit`. */
  intake?: IntakeMode;
  argStyle?: ArgStyle;
  currencies?: readonly string[];
  /** Channels the agent will reply in. Empty means "wherever it was mentioned". */
  allowedChannels?: readonly string[];
}

export function intakeOf(family: FamilySpec): IntakeMode {
  return family.intake ?? (family.defaultVerb ? "strict" : "explicit");
}

/** Verbs the family declared itself. Family implementations win over reserved. */
export function findDeclaredVerb(family: FamilySpec, token: string): VerbSpec | undefined {
  const needle = token.toLowerCase();
  return family.verbs.find(
    (verb) =>
      verb.name.toLowerCase() === needle ||
      verb.aliases?.some((alias) => alias.toLowerCase() === needle),
  );
}

/**
 * Resolve a leading token to a verb, declared first and reserved second.
 * Returns undefined only when the token is neither, in which case the family's
 * intake mode decides what happens next.
 */
export function findVerb(family: FamilySpec, token: string): VerbSpec | undefined {
  return findDeclaredVerb(family, token) ?? (isReservedVerbName(token) ? synthesizeReservedVerb(token) : undefined);
}

/** Every name the family answers to as a verb, for near-miss comparison. */
export function verbVocabulary(family: FamilySpec): string[] {
  const names = new Set<string>(RESERVED_VERBS);
  for (const verb of family.verbs) {
    names.add(verb.name.toLowerCase());
    for (const alias of verb.aliases ?? []) names.add(alias.toLowerCase());
  }
  return [...names];
}

export function styleOf(family: FamilySpec, verb: VerbSpec): ArgStyle {
  return verb.argStyle ?? family.argStyle ?? "pipe";
}

export function usageLine(family: FamilySpec, verb: VerbSpec): string {
  const prefix = `@${family.handle} ${verb.name}`;
  if (verb.args.length === 0) return prefix;
  const style = styleOf(family, verb);
  if (style === "positional") {
    const literal = verb.literalTokens?.length ? ` [${verb.literalTokens[0]}]` : "";
    const args = verb.args.map((arg) => (arg.required ? `<${arg.name}>` : `[${arg.name}]`)).join(" ");
    return `${prefix}${literal} ${args}`;
  }
  if (style === "pipe_named") {
    const args = verb.args.map((arg) => `${arg.name}=<${arg.type}>`).join(" | ");
    return `${prefix} | ${args}`;
  }
  const args = verb.args.map((arg) => (arg.required ? `<${arg.name}>` : `[${arg.name}]`)).join(" | ");
  return `${prefix} | ${args}`;
}

/** Stable error codes, matching the router contract so replies and API agree. */
export type ArgErrorCode =
  | "arg_missing"
  | "arg_type_invalid"
  | "arg_too_long"
  | "arg_count_mismatch"
  | "arg_unknown";

export interface ArgError {
  arg: string;
  code: ArgErrorCode;
  reason: string;
  /**
   * The agent must reject rather than forward. Reserved for context-free
   * syntax failures with irreversible consequences — currently only a
   * malformed wallet address.
   */
  fatal?: boolean;
}

export type ArgValue = string | number | boolean | Record<string, unknown>;

export interface ValidatedArgs {
  /** Normalized, ready to send to the site. */
  values: Record<string, ArgValue>;
  /** Exactly what the author typed, per argument. Audit trail, not input. */
  raw: Record<string, string>;
}

export interface ValidateOptions {
  currencies?: readonly string[];
  argStyle?: ArgStyle;
  /** Defaults to true: a single-case address carries no typo protection. */
  requireChecksummedAddress?: boolean;
}

/**
 * Validate pipe-delimited arguments against a verb.
 *
 * Collects every error rather than failing on the first, so one acknowledgement
 * can tell the author everything that is wrong — board writes are scarce enough
 * that a second corrective reply is a real cost.
 */
export function validateArgs(
  verb: VerbSpec,
  rawArgs: readonly string[],
  options: ValidateOptions = {},
): { ok: true; args: ValidatedArgs } | { ok: false; errors: ArgError[] } {
  const context: ValueContext = {
    currencies: options.currencies ?? DEFAULT_CURRENCIES,
    requireChecksummedAddress: options.requireChecksummedAddress ?? true,
  };
  if ((options.argStyle ?? "pipe") === "pipe_named") {
    return validateNamed(verb, rawArgs, context);
  }
  return validateOrdered(verb, rawArgs, context, options.argStyle ?? "pipe");
}

function validateOrdered(
  verb: VerbSpec,
  rawArgs: readonly string[],
  context: ValueContext,
  style: ArgStyle,
): { ok: true; args: ValidatedArgs } | { ok: false; errors: ArgError[] } {
  const errors: ArgError[] = [];
  const values: Record<string, ArgValue> = {};
  const raw: Record<string, string> = {};

  if (rawArgs.length > verb.args.length) {
    // Never silently join the overflow: a stray pipe in a title, or a
    // positional argument that turned out to contain a space, must be an error
    // rather than a quietly mangled command.
    const separator = style === "positional" ? "spaces" : 'a "|"';
    errors.push({
      arg: "(extra)",
      code: "arg_count_mismatch",
      reason: `expected ${verb.args.length} value${verb.args.length === 1 ? "" : "s"} separated by ${separator}, got ${rawArgs.length}`,
    });
  }

  verb.args.forEach((spec, index) => {
    const supplied = rawArgs[index];
    if (supplied === undefined || supplied.trim() === "") {
      if (spec.required) {
        errors.push({
          arg: spec.name,
          code: "arg_missing",
          reason: `missing${spec.hint ? ` — ${spec.hint}` : ""}`,
        });
      }
      return;
    }
    raw[spec.name] = supplied;
    const parsed = parseArg(spec, supplied, context);
    if (parsed.ok) values[spec.name] = parsed.value;
    else errors.push(argError(spec, parsed.reason));
  });

  return errors.length > 0 ? { ok: false, errors } : { ok: true, args: { values, raw } };
}

function validateNamed(
  verb: VerbSpec,
  rawArgs: readonly string[],
  context: ValueContext,
): { ok: true; args: ValidatedArgs } | { ok: false; errors: ArgError[] } {
  const errors: ArgError[] = [];
  const values: Record<string, ArgValue> = {};
  const raw: Record<string, string> = {};
  const supplied = new Map<string, string>();

  for (const field of rawArgs) {
    if (field.trim() === "") continue;
    const separator = field.indexOf("=");
    if (separator === -1) {
      errors.push({
        arg: field.slice(0, 40),
        code: "arg_unknown",
        reason: 'this family takes named fields, e.g. "title=recipe site"',
      });
      continue;
    }
    const key = field.slice(0, separator).trim().toLowerCase();
    const value = field.slice(separator + 1).trim();
    const spec = verb.args.find((arg) => arg.name.toLowerCase() === key);
    if (!spec) {
      // Dropping `titel=` and creating an untitled bounty is worse than an error.
      errors.push({
        arg: key,
        code: "arg_unknown",
        reason: `unknown field — this verb takes: ${verb.args.map((arg) => arg.name).join(", ")}`,
      });
      continue;
    }
    supplied.set(spec.name, value);
  }

  for (const spec of verb.args) {
    const value = supplied.get(spec.name);
    if (value === undefined || value === "") {
      if (spec.required) {
        errors.push({
          arg: spec.name,
          code: "arg_missing",
          reason: `missing${spec.hint ? ` — ${spec.hint}` : ""}`,
        });
      }
      continue;
    }
    raw[spec.name] = value;
    const parsed = parseArg(spec, value, context);
    if (parsed.ok) values[spec.name] = parsed.value;
    else errors.push(argError(spec, parsed.reason));
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, args: { values, raw } };
}

/**
 * Syntax-only check for one token, used by the positional shape floor.
 *
 * Deliberately cheaper and narrower than validation: it answers "could this
 * token possibly be a value of this type", not "is this a good value". `text`
 * always passes, which is exactly why a floor built only from text slots does
 * not discriminate.
 */
export function passesSyntaxCheck(
  spec: ArgSpec,
  token: string,
  currencies: readonly string[] = DEFAULT_CURRENCIES,
): boolean {
  if (!isTypedSlot(spec.type)) return true;
  return parseArg(spec, token, { currencies, requireChecksummedAddress: true }).ok;
}

function argError(spec: ArgSpec, reason: string): ArgError {
  const code: ArgErrorCode =
    reason.includes("at most") && reason.includes("characters") ? "arg_too_long" : "arg_type_invalid";
  return FATAL_ON_SYNTAX_ERROR.has(spec.type)
    ? { arg: spec.name, code, reason, fatal: true }
    : { arg: spec.name, code, reason };
}

interface ValueContext {
  currencies: readonly string[];
  requireChecksummedAddress: boolean;
}

function parseArg(
  spec: ArgSpec,
  supplied: string,
  context: ValueContext,
): ParseResult<ArgValue> {
  switch (spec.type) {
    case "money": {
      const result = parseMoney(supplied, context.currencies);
      return result.ok ? { ok: true, value: { ...result.value } } : result;
    }
    case "deadline": {
      const result = parseDeadline(supplied);
      return result.ok ? { ok: true, value: { ...result.value } } : result;
    }
    case "muse_id":
      return parseMuseId(supplied);
    case "subject_id":
      return parseSubjectId(supplied);
    case "evm_address":
      return parseEvmAddress(supplied, { requireChecksum: context.requireChecksummedAddress });
    case "url":
      return parseUrl(supplied);
    case "integer": {
      const trimmed = supplied.trim();
      if (!/^\d+$/.test(trimmed)) return { ok: false, reason: `"${trimmed}" is not a whole number` };
      return { ok: true, value: Number(trimmed) };
    }
    case "enum": {
      const allowed = spec.values ?? [];
      const match = allowed.find((value) => value.toLowerCase() === supplied.trim().toLowerCase());
      return match
        ? { ok: true, value: match }
        : { ok: false, reason: `must be one of: ${allowed.join(", ")}` };
    }
    case "text":
    default:
      return parseText(supplied, { min: spec.minLength ?? 1, max: spec.maxLength ?? 280 });
  }
}

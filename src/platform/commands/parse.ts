import { PlatformError } from "../errors";

/** Splits on whitespace, honouring single and double quotes. */
export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;

  for (const char of input.trim()) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started || current) tokens.push(current);
      current = "";
      started = false;
      continue;
    }
    current += char;
  }

  if (quote) {
    throw new PlatformError("validation", "unbalanced quote in command text");
  }
  if (started || current) tokens.push(current);
  return tokens;
}

/** Peels the leading word off a body — the verb, normally. */
export function peelWord(body: string): { word: string | null; rest: string } {
  const match = /^(\S+)\s*([\s\S]*)$/.exec(body.trim());
  if (!match) return { word: null, rest: "" };
  return { word: match[1], rest: match[2] ?? "" };
}

export interface VerbResolution {
  verb: string | null;
  rest: string;
  /** True when the verb came from `defaultVerb` rather than the text. */
  defaulted: boolean;
  /**
   * True when the first token could have been read either way. A bounty titled
   * "cancel the old design" is the case in point. The caller uses this to
   * demand confirmation before doing anything destructive.
   */
  ambiguous: boolean;
}

/**
 * Resolves the verb in a mention body.
 *
 * The first token is a verb if and only if it matches a declared verb exactly,
 * case-insensitively, and appears before the first pipe. Otherwise the family's
 * `defaultVerb` applies and that token begins the first argument. The explicit
 * form always wins: `post | cancel the old design | …` is unambiguous, which is
 * the escape hatch for a title that happens to start with a verb.
 */
export function resolveVerb(
  body: string,
  verbs: string[],
  defaultVerb?: string,
): VerbResolution {
  const text = body.trim();
  if (!text) {
    return { verb: defaultVerb ?? null, rest: "", defaulted: true, ambiguous: false };
  }

  const known = new Set(verbs.map((verb) => verb.toLowerCase()));
  const firstPipe = text.search(/(?<!\\)\|/);
  const { word, rest } = peelWord(text);
  const candidate = word?.toLowerCase().replace(/[,:]$/, "") ?? "";
  const beforePipe = firstPipe === -1 || text.indexOf(word ?? "") < firstPipe;

  if (word && beforePipe && known.has(candidate)) {
    return { verb: candidate, rest, defaulted: false, ambiguous: false };
  }

  if (defaultVerb) {
    // The first token reads as prose here, but it would have read as a verb in
    // a body that had not already used the default — worth flagging when the
    // resulting command is destructive.
    const ambiguous = Boolean(word) && known.has(candidate);
    return { verb: defaultVerb, rest: text, defaulted: true, ambiguous };
  }

  return { verb: null, rest: text, defaulted: false, ambiguous: false };
}

/**
 * Splits a body on unescaped pipes.
 *
 * `\|` is a literal pipe and `\\` a literal backslash; there are no other
 * escapes. `||` is an explicitly empty field, which is not the same as a
 * missing trailing one — so trailing empties are dropped before arity is
 * checked, and interior ones are kept.
 */
export function splitPipes(body: string): string[] {
  const fields: string[] = [];
  let current = "";
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (char === "\\" && (body[i + 1] === "|" || body[i + 1] === "\\")) {
      current += body[i + 1];
      i++;
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

  // Newlines collapse to single spaces: a muse writing a long brief will wrap
  // it, and the wrap is not part of the value.
  const trimmed = fields.map((field) => field.replace(/\s*\n\s*/g, " ").trim());
  while (trimmed.length > 1 && trimmed.at(-1) === "") trimmed.pop();
  return trimmed;
}

/** True when the body uses a pipe that is not escaped. */
export function hasPipe(body: string): boolean {
  return /(^|[^\\])(\\\\)*\|/.test(body);
}

export interface RawArgs {
  positionals: string[];
  flags: Record<string, string | true>;
  /** Pipe-delimited fields, when the body used that style. */
  fields: string[] | null;
  /** `key=value` fields, when the body used the named-pipe style. */
  named: Record<string, string> | null;
}

/**
 * Three shapes are accepted, and each command declares which of them it takes.
 *
 * `@bountyboard post Write the runbook | document settlement | $250 | 7d` is how
 * a muse writes one in a post: prose with spaces and commas in it survives,
 * which `--flag value` cannot manage without quoting. `@answers bountii 12 <url>`
 * is positional, which the original spec uses and which reads better for two
 * short arguments. `--flag value` is how a script writes one.
 */
export function splitArgs(body: string): RawArgs {
  const text = body.trim();
  if (hasPipe(text)) {
    const fields = splitPipes(text);
    // `key=value` in every non-empty field means the named style. Mixing the
    // two is rejected later, where the command's declaration is in scope.
    const named = fields.filter(Boolean);
    if (named.length > 0 && named.every((field) => /^[a-z_][\w-]*\s*=/i.test(field))) {
      const map: Record<string, string> = {};
      for (const field of named) {
        const eq = field.indexOf("=");
        map[field.slice(0, eq).trim().toLowerCase()] = field.slice(eq + 1).trim();
      }
      return { positionals: [], flags: {}, fields: null, named: map };
    }
    return { positionals: [], flags: {}, fields, named: null };
  }

  const tokens = tokenize(text);
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const flagBody = token.slice(2);
    const eq = flagBody.indexOf("=");
    if (eq !== -1) {
      flags[flagBody.slice(0, eq)] = flagBody.slice(eq + 1);
      continue;
    }
    const next = tokens[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[flagBody] = true;
    } else {
      flags[flagBody] = next;
      i++;
    }
  }

  return { positionals, flags, fields: null, named: null };
}

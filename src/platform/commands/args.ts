import { parseDeadline } from "../duration";
import { PlatformError } from "../errors";
import { assertAddress } from "../evm";
import { normalizeHandle } from "../identity";
import { parseAmount } from "../money";
import { hasPipe, splitPipes, tokenize } from "./parse";
import { renderCommand } from "./trigger";
import type { ArgSpec, ArgStyle, ArgValue, ArgValues } from "./types";

function coerce(spec: ArgSpec, raw: string, now: Date): ArgValue {
  const value = raw.trim();

  if (spec.maxLen && value.length > spec.maxLen) {
    throw new PlatformError(
      "validation",
      `${spec.name} is ${value.length} characters; the limit is ${spec.maxLen}`,
    );
  }

  switch (spec.type) {
    case "string":
    case "text":
    case "id":
      if (!value) {
        throw new PlatformError("validation", `${spec.name} cannot be empty`);
      }
      return value;

    case "address":
      // Validated but never rewritten: the exact characters are what gets paid.
      return assertAddress(value, spec.name);

    case "integer":
      if (!/^-?\d+$/.test(value)) {
        throw new PlatformError("validation", `${spec.name} must be a whole number`);
      }
      return Number(value);

    // Both of these refuse to guess. A misread amount or deadline is the silent
    // corruption case: it does not error, it just moves the wrong money at the
    // wrong time, so ambiguity is an error with its own code.
    case "amount":
      return parseAmount(value);

    case "deadline":
      return parseDeadline(value, now);

    case "identity":
      return normalizeHandle(value);

    case "identity-list":
      return value
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
        .map(normalizeHandle);

    case "enum": {
      const allowed = spec.values ?? [];
      // Lenient in, strict out. The spec's statuses are uppercase because
      // agents branch on the exact string, but `list open` from a muse typing
      // into a chat box is not a different intention from `list OPEN`, and
      // refusing it teaches nothing. The declared spelling is what comes back.
      const match = allowed.find((v) => v.toLowerCase() === value.toLowerCase());
      if (!match) {
        throw new PlatformError(
          "validation",
          `${spec.name} must be one of: ${allowed.join(", ")}`,
        );
      }
      return match;
    }
  }
}

export interface BindOptions {
  style: ArgStyle;
  /** Declared keywords that are matched and discarded — the spec's `bountii`. */
  literalTokens?: string[];
  now?: Date;
}

/**
 * Binds a mention body to a command's declared grammar.
 *
 * The style is declared per verb and a verb may not mix them, because the two
 * shapes disagree about what a space means: `post A | B | C` has prose fields
 * with spaces in them, and `answer 12 <url>` has whitespace-separated tokens.
 * Guessing between them per-invocation is how a title containing a pipe, or a
 * URL containing a space, becomes a silently wrong bounty.
 */
export function bindArgs(
  specs: ArgSpec[],
  body: string,
  options: BindOptions,
): ArgValues {
  const now = options.now ?? new Date();
  const text = stripLiterals(body.trim(), options.literalTokens);

  switch (options.style) {
    case "pipe_named":
      return finish(specs, bindNamed(specs, text, now), now);
    case "pipe":
      return finish(specs, bindPipe(specs, text, now), now);
    case "positional":
      return finish(specs, bindPositional(specs, text, now), now);
  }
}

/**
 * `bountii` survives here. Under per-family addressing the family already says
 * what kind of thing is being answered, so the noun is redundant — but the spec
 * names it twice including in its acceptance criteria, so both
 * `answer bountii 12 <url>` and `answer 12 <url>` have to parse identically.
 */
function stripLiterals(text: string, literals?: string[]): string {
  if (!literals?.length) return text;
  let out = text;
  for (const literal of literals) {
    const pattern = new RegExp(`(^|\\s)${escapeRegExp(literal)}(?=\\s|$)`, "i");
    out = out.replace(pattern, "$1").trim();
  }
  return out;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function bindPipe(specs: ArgSpec[], text: string, now: Date): ArgValues {
  const values: ArgValues = {};
  if (!text) return values;

  const fields = splitPipes(text);
  if (fields.length > specs.length) {
    throw new PlatformError(
      "arg_count_mismatch",
      `too many \`|\` fields: expected at most ${specs.length} (${specs
        .map((s) => s.name)
        .join(" | ")}), got ${fields.length}`,
    );
  }

  fields.forEach((field, index) => {
    // An interior `||` is an explicitly empty field; it leaves the argument
    // unset so a default or a required-check applies, rather than binding "".
    if (!field) return;
    values[specs[index].name] = coerce(specs[index], field, now);
  });
  return values;
}

function bindNamed(specs: ArgSpec[], text: string, now: Date): ArgValues {
  const values: ArgValues = {};
  if (!text) return values;

  const byName = new Map(specs.map((s) => [s.name.toLowerCase(), s]));
  for (const field of splitPipes(text)) {
    if (!field) continue;
    const eq = field.indexOf("=");
    if (eq === -1) {
      throw new PlatformError(
        "validation",
        `this command takes \`key=value\` fields; "${field}" has no "="`,
      );
    }
    const key = field.slice(0, eq).trim().toLowerCase();
    const spec = byName.get(key);
    // Silently dropping `titel=` and creating an untitled bounty is worse than
    // an error, so an unknown key is refused rather than ignored.
    if (!spec) {
      throw new PlatformError(
        "arg_unknown",
        `unknown field "${key}"; this command takes: ${specs.map((s) => s.name).join(", ")}`,
      );
    }
    values[spec.name] = coerce(spec, field.slice(eq + 1), now);
  }
  return values;
}

function bindPositional(specs: ArgSpec[], text: string, now: Date): ArgValues {
  if (hasPipe(text)) {
    throw new PlatformError(
      "validation",
      `this command takes whitespace-separated values, not \`|\` fields: ${specs
        .map((s) => `<${s.name}>`)
        .join(" ")}`,
    );
  }

  const values: ArgValues = {};
  const tokens = tokenize(text);
  if (tokens.length > specs.length) {
    throw new PlatformError(
      "arg_count_mismatch",
      `too many values: expected ${specs.length} (${specs
        .map((s) => `<${s.name}>`)
        .join(" ")}), got ${tokens.length}`,
    );
  }
  tokens.forEach((token, index) => {
    values[specs[index].name] = coerce(specs[index], token, now);
  });
  return values;
}

function finish(specs: ArgSpec[], values: ArgValues, now: Date): ArgValues {
  for (const spec of specs) {
    if (values[spec.name] === undefined && spec.default !== undefined) {
      values[spec.name] = coerce(spec, String(spec.default), now);
    }
    if (values[spec.name] === undefined && spec.required) {
      throw new PlatformError(
        "validation",
        `missing required value <${spec.name}>: ${spec.description}`,
      );
    }
  }
  return values;
}

/**
 * Binds arguments supplied as JSON rather than as text — the structured API
 * path, where there is no grammar to parse and the caller names every field.
 */
export function bindObject(
  specs: ArgSpec[],
  input: Record<string, unknown>,
  now: Date = new Date(),
): ArgValues {
  const byName = new Map(specs.map((s) => [s.name, s]));
  for (const key of Object.keys(input)) {
    if (!byName.has(key)) {
      throw new PlatformError(
        "arg_unknown",
        `unknown argument "${key}"; this command takes: ${specs.map((s) => s.name).join(", ")}`,
      );
    }
  }

  const values: ArgValues = {};
  for (const spec of specs) {
    const supplied = input[spec.name];
    if (supplied === undefined || supplied === null || supplied === "") continue;
    values[spec.name] = coerce(spec, String(supplied), now);
  }
  return finish(specs, values, now);
}

export function usageFor(
  family: string,
  action: string,
  specs: ArgSpec[],
  style: ArgStyle,
  literalTokens?: string[],
): string {
  const head = [renderCommand(family, action), ...(literalTokens ?? [])].join(" ");

  if (style === "pipe_named") {
    const fields = specs.map((spec) =>
      spec.required ? `${spec.name}=<${spec.type}>` : `[${spec.name}=<${spec.type}>]`,
    );
    return `${head} | ${fields.join(" | ")}`;
  }

  if (style === "pipe") {
    const fields = specs.map((spec) =>
      spec.required ? `<${spec.name}>` : `[${spec.name}]`,
    );
    return `${head} ${fields.join(" | ")}`;
  }

  const parts = specs.map((spec) =>
    spec.required ? `<${spec.name}>` : `[${spec.name}]`,
  );
  return [head, ...parts].join(" ");
}

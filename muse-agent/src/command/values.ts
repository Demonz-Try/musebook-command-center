/**
 * Strict value parsers.
 *
 * The rule that governs this file: the agent never guesses. A value it cannot
 * read unambiguously is rejected with an explanation, because quietly resolving
 * "about 5 ETH" or "next friday" into a number would make the agent an
 * authority on money and deadlines. It is a client, not an authority.
 */

import { keccak256Hex } from "../crypto/keccak256.js";

export type ParseResult<T> = { ok: true; value: T } | { ok: false; reason: string };

const ok = <T>(value: T): ParseResult<T> => ({ ok: true, value });
const fail = <T>(reason: string): ParseResult<T> => ({ ok: false, reason });

/** Currencies we will accept a bare code for. Configurable per family. */
export const DEFAULT_CURRENCIES = [
  "ETH",
  "WETH",
  "USDC",
  "USDT",
  "DAI",
  "SOL",
  "BTC",
  "USD",
  "EUR",
  "GBP",
] as const;

const SYMBOL_CURRENCIES: Record<string, string> = { $: "USD", "€": "EUR", "£": "GBP" };

/**
 * Words and characters that signal the author was approximating, hedging, or
 * giving a range. Any of them makes the value ambiguous by definition.
 */
const HEDGE_PATTERN =
  /(~|≈|\+\/-|±|\b(?:approx|approximately|about|around|circa|ish|maybe|roughly|or\s+so|up\s+to|at\s+least|at\s+most|between|negotiable|tbd|tba|open|flexible)\b)/i;

const RANGE_PATTERN = /\d\s*(?:-|\u2013|\u2014|to|\/)\s*\d/i;

export interface MoneyValue {
  /** Exact decimal as written, normalized. Kept as a string: never a float. */
  amount: string;
  /** Uppercase currency code. */
  currency: string;
  /** Canonical rendering for receipts, e.g. "0.005 ETH". */
  display: string;
}

/**
 * Accepts `0.005 ETH`, `$120`, `1,500 USDC`, `120 usd`.
 * Rejects ranges, hedges, bare numbers with no currency, and unknown codes.
 */
export function parseMoney(
  raw: string,
  currencies: readonly string[] = DEFAULT_CURRENCIES,
): ParseResult<MoneyValue> {
  const input = raw.trim();
  if (!input) return fail("no amount given");
  if (HEDGE_PATTERN.test(input)) {
    return fail(`"${input}" is approximate — give one exact amount and currency, e.g. "0.005 ETH"`);
  }
  if (RANGE_PATTERN.test(input)) {
    return fail(`"${input}" looks like a range — give one exact amount, e.g. "0.005 ETH"`);
  }

  const match = input.match(
    /^(?<symbol>[$\u20ac\u00a3])?\s*(?<number>\d[\d,_\s]*(?:\.\d+)?)\s*(?<code>[A-Za-z]{2,10})?$/u,
  );
  if (!match?.groups) {
    return fail(`could not read "${input}" as an amount — use "<number> <currency>", e.g. "0.005 ETH"`);
  }

  const { symbol, number, code } = match.groups;
  const digits = (number ?? "").replace(/[,_\s]/g, "");
  if (!/^\d+(?:\.\d+)?$/.test(digits)) {
    return fail(`could not read "${input}" as an amount — use "<number> <currency>", e.g. "0.005 ETH"`);
  }

  const symbolCurrency = symbol ? SYMBOL_CURRENCIES[symbol] : undefined;
  const codeCurrency = code ? code.toUpperCase() : undefined;
  if (codeCurrency && !currencies.includes(codeCurrency)) {
    return fail(`unknown currency "${code}" — supported: ${currencies.join(", ")}`);
  }
  if (symbolCurrency && codeCurrency && symbolCurrency !== codeCurrency) {
    return fail(`"${input}" names two currencies (${symbolCurrency} and ${codeCurrency}) — pick one`);
  }
  const currency = codeCurrency ?? symbolCurrency;
  if (!currency) {
    return fail(`"${input}" has no currency — say which, e.g. "${digits} ETH" or "$${digits}"`);
  }

  const amount = normalizeDecimal(digits);
  if (amount === null) return fail(`"${input}" is not a usable amount`);
  if (Number(amount) <= 0) return fail(`amount must be greater than zero, got "${input}"`);

  return ok({ amount, currency, display: `${amount} ${currency}` });
}

/** Trim redundant zeros without ever going through a float. */
function normalizeDecimal(digits: string): string | null {
  if (!/^\d+(?:\.\d+)?$/.test(digits)) return null;
  const [whole = "0", fraction] = digits.split(".");
  const trimmedWhole = whole.replace(/^0+(?=\d)/, "");
  if (fraction === undefined) return trimmedWhole;
  const trimmedFraction = fraction.replace(/0+$/, "");
  return trimmedFraction ? `${trimmedWhole}.${trimmedFraction}` : trimmedWhole;
}

export type DurationUnit = "m" | "h" | "d" | "w";

export type DeadlineValue =
  | {
      kind: "relative";
      value: number;
      unit: DurationUnit;
      /** ISO-8601 duration. The backend turns this into an instant, not us. */
      iso8601: string;
      display: string;
    }
  | {
      kind: "absolute";
      /** Exactly what the author wrote, validated as a real calendar date/instant. */
      iso8601: string;
      display: string;
    };

const UNIT_ALIASES: Record<string, DurationUnit> = {
  m: "m", min: "m", mins: "m", minute: "m", minutes: "m",
  h: "h", hr: "h", hrs: "h", hour: "h", hours: "h",
  d: "d", day: "d", days: "d",
  w: "w", wk: "w", wks: "w", week: "w", weeks: "w",
};

const ISO_DURATION_UNIT: Record<DurationUnit, string> = { m: "TM", h: "TH", d: "D", w: "W" };

/**
 * Accepts `7d`, `48 hours`, `2w`, `P7D`, `2026-10-01`, `2026-10-01T12:00:00Z`.
 * Rejects `next friday`, `asap`, `soon`, `7`, `a week`, `end of month`.
 *
 * Relative deadlines are normalized but NOT resolved to an instant: turning
 * "7d" into a timestamp is deadline math, and deadline math belongs to the
 * backend that owns the clock.
 */
export function parseDeadline(raw: string): ParseResult<DeadlineValue> {
  const input = raw.trim();
  if (!input) return fail("no deadline given");
  if (HEDGE_PATTERN.test(input)) {
    return fail(`"${input}" is vague — give an exact duration like "7d" or a date like "2026-10-01"`);
  }

  const isoDuration = input.toUpperCase().match(/^P(?:(\d+)W|(\d+)D|T(\d+)H|T(\d+)M)$/);
  if (isoDuration) {
    const [, weeks, days, hours, minutes] = isoDuration;
    if (weeks) return relative(Number(weeks), "w");
    if (days) return relative(Number(days), "d");
    if (hours) return relative(Number(hours), "h");
    if (minutes) return relative(Number(minutes), "m");
  }

  const relativeMatch = input.match(/^(\d+)\s*([A-Za-z]+)$/);
  if (relativeMatch) {
    const [, digits, rawUnit] = relativeMatch;
    const unit = UNIT_ALIASES[(rawUnit ?? "").toLowerCase()];
    if (!unit) {
      return fail(`unknown time unit "${rawUnit}" — use minutes, hours, days or weeks (e.g. "7d")`);
    }
    return relative(Number(digits), unit);
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    if (!isRealCalendarDate(input)) return fail(`"${input}" is not a real date`);
    return ok({ kind: "absolute", iso8601: input, display: input });
  }

  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/.test(input)) {
    const normalized = input.replace(" ", "T");
    if (Number.isNaN(Date.parse(normalized))) return fail(`"${input}" is not a valid timestamp`);
    return ok({ kind: "absolute", iso8601: normalized, display: normalized });
  }

  if (/^\d+$/.test(input)) {
    return fail(`"${input}" has no time unit — say "${input}d" for days or "${input}h" for hours`);
  }

  return fail(
    `could not read "${input}" as a deadline — use a duration like "7d" or a date like "2026-10-01"`,
  );
}

function relative(value: number, unit: DurationUnit): ParseResult<DeadlineValue> {
  if (!Number.isInteger(value) || value <= 0) return fail("deadline must be a positive whole number");
  if (value > 3650) return fail(`"${value}${unit}" is too far out`);
  const isoUnit = ISO_DURATION_UNIT[unit];
  const iso8601 = isoUnit.startsWith("T") ? `PT${value}${isoUnit.slice(1)}` : `P${value}${isoUnit}`;
  return ok({ kind: "relative", value, unit, iso8601, display: `${value}${unit}` });
}

function isRealCalendarDate(input: string): boolean {
  const [year, month, day] = input.split("-").map(Number);
  if (!year || !month || !day) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/** `muse_<10 chars>` only. Keyless `anon:` identities can never sign, so they are refused. */
export function parseMuseId(raw: string): ParseResult<string> {
  const input = raw.trim().replace(/^@/, "");
  if (!input) return fail("no muse id given");
  if (input.startsWith("anon:")) {
    return fail(
      `"${input}" is a keyless identity — it cannot sign anything, so it cannot be used here`,
    );
  }
  if (!/^muse_[a-z0-9]{5,20}$/i.test(input)) {
    return fail(
      `"${input}" is not a muse id — muse ids look like "muse_1j335p3a14" (display names are not unique, so they are not accepted)`,
    );
  }
  return ok(input);
}

export function parseUrl(raw: string): ParseResult<string> {
  const input = raw.trim();
  if (!input) return fail("no url given");
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return fail(`"${input}" is not a valid url`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return fail(`"${input}" must be an http(s) url`);
  }
  return ok(parsed.toString());
}

/**
 * An EVM wallet address.
 *
 * Load-bearing rather than decorative: the contract records the funding
 * address and refuses payment from any other, so a wrong one here permanently
 * loses money. Two consequences run through this function:
 *
 *  - **Nothing is normalized.** No case folding, no internal trimming, no
 *    truncation. The value that comes out is byte-identical to the value that
 *    went in, so what the muse sees echoed back is exactly what was recorded.
 *  - **A malformed address is rejected, not forwarded.** This is the one
 *    narrow exception to "the platform validates": address syntax is
 *    context-free, and a checksum failure means the author mistyped something
 *    irreversible.
 */
export function parseEvmAddress(
  raw: string,
  options: { requireChecksum?: boolean } = {},
): ParseResult<string> {
  // Surrounding whitespace is the field separator's doing, not the author's.
  // Anything inside the string is left exactly as written.
  const input = raw.trim();
  if (!input) return fail("no wallet address given");

  if (!/^0x[0-9a-fA-F]{40}$/.test(input)) {
    return fail(
      `"${truncateForMessage(input)}" is not a wallet address — it must be 0x followed by 40 hex characters`,
    );
  }

  const body = input.slice(2);
  const mixedCase = /[a-f]/.test(body) && /[A-F]/.test(body);
  const checksummed = toChecksumAddress(input);

  // Strict by default: the address must equal its own EIP-55 form. Note this
  // is a comparison, not a "must be mixed case" rule — some addresses legitimately
  // checksum to all-uppercase or all-lowercase letters, and rejecting those
  // would be wrong.
  //
  // EIP-55 itself treats a single-case address as merely unchecksummed rather
  // than invalid. We are stricter because the checksum is the only thing
  // standing between a typo and an unfundable bounty or a burned payout.
  if (options.requireChecksum !== false) {
    if (input !== checksummed) {
      // Deliberately not offering a corrected form: if a character was
      // mistyped, the checksummed form of the wrong address is still the wrong
      // address, and showing it invites trusting it.
      return fail(
        "that wallet address does not match its EIP-55 checksum, which means either a character " +
          "is wrong or it was typed without the checksum. copy it again from your wallet rather " +
          "than retyping it",
      );
    }
    return ok(input);
  }

  if (mixedCase && input !== checksummed) {
    return fail(
      "that wallet address fails its EIP-55 checksum, which usually means a character is wrong. " +
        "copy it again from your wallet rather than retyping it",
    );
  }

  return ok(input);
}

/** EIP-55: uppercase a hex nibble when the matching keccak nibble is >= 8. */
export function toChecksumAddress(address: string): string {
  const body = address.slice(2).toLowerCase();
  const hash = keccak256Hex(body);
  let out = "0x";
  for (let i = 0; i < body.length; i += 1) {
    const character = body[i]!;
    const nibble = parseInt(hash[i]!, 16);
    out += nibble >= 8 ? character.toUpperCase() : character;
  }
  return out;
}

function truncateForMessage(value: string): string {
  return value.length <= 48 ? value : `${value.slice(0, 45)}…`;
}

/**
 * A subject id: opaque, token-shaped, never containing whitespace.
 *
 * Having this as its own type matters beyond validation — it is what gives a
 * positional verb a real shape floor, because prose fails it immediately.
 */
export function parseSubjectId(raw: string): ParseResult<string> {
  const input = raw.trim();
  if (!input) return fail("no id given");
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(input)) {
    return fail(`"${input}" is not an id — ids look like "bnt_4812" or "12"`);
  }
  return ok(input);
}

export function parseText(raw: string, options: { min?: number; max?: number } = {}): ParseResult<string> {
  const input = raw.trim().replace(/\s+/g, " ");
  const min = options.min ?? 1;
  const max = options.max ?? 280;
  if (input.length < min) return fail(`must be at least ${min} character${min === 1 ? "" : "s"}`);
  if (input.length > max) return fail(`must be at most ${max} characters (got ${input.length})`);
  return ok(input);
}

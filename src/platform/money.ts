import { PlatformError } from "./errors";

/**
 * Amounts are exact integers in a currency's minor unit — cents for USD, wei
 * for ETH — so nothing is ever held as a float. A currency must be declared
 * here before escrow will accept it; an unknown ticker is rejected rather than
 * guessed at.
 */
export interface Currency {
  code: string;
  decimals: number;
  symbol?: string;
}

export const CURRENCIES: Record<string, Currency> = {
  USD: { code: "USD", decimals: 2, symbol: "$" },
  USDC: { code: "USDC", decimals: 6 },
  ETH: { code: "ETH", decimals: 18 },
};

export const DEFAULT_CURRENCY = "USD";

export interface Money {
  currency: string;
  decimals: number;
  /** Exact integer count of minor units. */
  minor: bigint;
}

export function currencyFor(code: string): Currency {
  const currency = CURRENCIES[code?.trim().toUpperCase()];
  if (!currency) {
    throw new PlatformError(
      "unsupported_currency",
      `"${code}" is not a currency this board settles in (${Object.keys(CURRENCIES).join(", ")})`,
    );
  }
  return currency;
}

export function money(amount: string | bigint, code: string): Money {
  const currency = currencyFor(code);
  if (typeof amount === "bigint") {
    return { currency: currency.code, decimals: currency.decimals, minor: amount };
  }
  return { currency: currency.code, decimals: currency.decimals, minor: toMinor(amount, currency) };
}

function toMinor(amount: string, currency: Currency): bigint {
  const cleaned = amount.replace(/[_\s,]/g, "");
  const match = /^(\d+)(?:\.(\d+))?$/.exec(cleaned);
  if (!match) {
    throw new PlatformError("validation", `"${amount}" is not a plain decimal amount`);
  }
  const fraction = match[2] ?? "";
  if (fraction.length > currency.decimals) {
    throw new PlatformError(
      "validation",
      `${currency.code} has ${currency.decimals} decimal places; "${amount}" has ${fraction.length}`,
    );
  }
  const padded = fraction.padEnd(currency.decimals, "0");
  return BigInt(match[1] + padded);
}

/** "5000000000000000" wei → "0.005". Trailing zeros trimmed, never rounded. */
export function formatMoney(value: Money): string {
  const currency = currencyFor(value.currency);
  const negative = value.minor < 0n;
  const digits = (negative ? -value.minor : value.minor).toString().padStart(currency.decimals + 1, "0");
  const whole = digits.slice(0, digits.length - currency.decimals);
  const fraction = currency.decimals === 0 ? "" : digits.slice(digits.length - currency.decimals);
  const trimmed = fraction.replace(/0+$/, "");
  const body = trimmed ? `${whole}.${trimmed}` : whole;
  return negative ? `-${body}` : body;
}

export function displayMoney(value: Money): string {
  const currency = currencyFor(value.currency);
  const amount = formatMoney(value);
  return currency.symbol ? `${currency.symbol}${amount}` : `${amount} ${currency.code}`;
}

export function zero(code: string): Money {
  return money(0n, code);
}

export function isZero(value: Money): boolean {
  return value.minor === 0n;
}

/** Database round-trip: numeric columns come back as strings. */
export function fromStored(minor: string | number | bigint, code: string): Money {
  return money(BigInt(minor), code);
}

export function toStored(value: Money): string {
  return value.minor.toString();
}

const AMOUNT_WITH_UNIT =
  /^(?:(?<symbol>[$])\s*)?(?<amount>\d[\d_,]*(?:\.\d+)?)\s*(?<code>[a-z]{2,6})?$/i;

/**
 * Parses an amount a muse typed. Refuses to guess: a bare number with no
 * currency is ambiguous the moment more than one currency exists, so it is
 * rejected with its own error code rather than silently assumed to be dollars.
 */
export function parseAmount(input: string): Money {
  const text = input?.trim();
  if (!text) {
    throw new PlatformError("ambiguous_amount", "an amount is required");
  }

  const match = AMOUNT_WITH_UNIT.exec(text);
  if (!match?.groups) {
    throw new PlatformError(
      "ambiguous_amount",
      `"${input}" is not an amount I will guess at — write it like "0.005 ETH" or "$250"`,
    );
  }

  const { symbol, amount, code } = match.groups;
  if (symbol && code) {
    throw new PlatformError(
      "ambiguous_amount",
      `"${input}" names a currency twice — use "$250" or "250 USD", not both`,
    );
  }
  if (!symbol && !code) {
    throw new PlatformError(
      "ambiguous_amount",
      `"${input}" has no currency — write "${amount} USD" or "$${amount}" or "${amount} ETH"`,
    );
  }

  return money(amount, symbol === "$" ? "USD" : code!);
}

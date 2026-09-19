import { PlatformError } from "./errors";

const RELATIVE = /^(\d+(?:\.\d+)?)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)$/i;

const UNIT_MS: Record<string, number> = {
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
  w: 604_800_000,
  week: 604_800_000,
  weeks: 604_800_000,
};

/**
 * ISO-8601 durations, which is what a client sends when it has normalized a
 * muse's `7d` without resolving it. Deliberately no `Y` or `M`: a month is not
 * a fixed number of milliseconds, so "P1M" would mean different deadlines
 * depending on when it was read, and this is the value that decides when money
 * goes back to an owner.
 */
const ISO_DURATION = /^P(?!$)(\d+(?:\.\d+)?W)?(\d+(?:\.\d+)?D)?(?:T(?!$)(\d+(?:\.\d+)?H)?(\d+(?:\.\d+)?M)?(\d+(?:\.\d+)?S)?)?$/i;

const ISO_UNIT_MS: Record<string, number> = {
  W: 604_800_000,
  D: 86_400_000,
  H: 3_600_000,
  M: 60_000,
  S: 1_000,
};

/** Milliseconds for an ISO-8601 duration, or null if it is not one. */
export function parseIsoDuration(input: string): number | null {
  const match = ISO_DURATION.exec(input.trim());
  if (!match) return null;

  let ms = 0;
  for (const part of match.slice(1)) {
    if (!part) continue;
    const unit = part.slice(-1).toUpperCase();
    ms += Number(part.slice(0, -1)) * ISO_UNIT_MS[unit];
  }
  return ms > 0 ? ms : null;
}

/**
 * Resolves a deadline. Accepts a relative duration a muse typed (`7d`, `48h`),
 * the ISO-8601 form a client normalizes it to (`P7D`, `PT48H`), or a full ISO
 * timestamp — and nothing else: "friday", "next week" and "soon" are rejected
 * with their own code rather than interpreted, because a wrong guess here
 * decides when money goes back to the owner.
 *
 * Note what this means for a client: it may normalize the *shape* of a
 * duration, but it must not resolve it to an instant. The deadline is computed
 * here, from this server's clock, because the deadline is what the refund timer
 * fires on and a client's clock is not evidence of anything.
 */
export function parseDeadline(input: string, now: Date = new Date()): Date {
  const text = input?.trim();
  if (!text) {
    throw new PlatformError("ambiguous_deadline", "a deadline is required");
  }

  const iso = parseIsoDuration(text);
  if (iso !== null) return new Date(now.getTime() + iso);

  if (/^P/i.test(text) && /^P[\dYMWDTHS.]*$/i.test(text)) {
    throw new PlatformError(
      "ambiguous_deadline",
      `"${input}" is not a duration with a fixed length — years and months vary, so write days, weeks, hours or a full ISO timestamp`,
    );
  }

  const relative = RELATIVE.exec(text);
  if (relative) {
    const [, amount, unit] = relative;
    const ms = Number(amount) * UNIT_MS[unit.toLowerCase()];
    if (!Number.isFinite(ms) || ms <= 0) {
      throw new PlatformError("ambiguous_deadline", `"${input}" is not a usable duration");
    }
    return new Date(now.getTime() + ms);
  }

  // Only a full ISO 8601 instant. A bare date has no time zone and would move
  // the refund moment by up to a day depending on who reads it.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(text)) {
    const date = new Date(text);
    if (!Number.isNaN(date.getTime())) return date;
  }

  throw new PlatformError(
    "ambiguous_deadline",
    `"${input}" is not a deadline I will guess at — write a duration like "7d", "48h" or "P7D", or a full ISO timestamp like 2026-10-01T17:00:00Z`,
  );
}

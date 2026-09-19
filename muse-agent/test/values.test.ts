import { describe, expect, it } from "vitest";
import { parseDeadline, parseMoney, parseMuseId } from "../src/command/values.js";

describe("money", () => {
  it("accepts an exact amount with a currency code", () => {
    expect(parseMoney("0.005 ETH")).toEqual({
      ok: true,
      value: { amount: "0.005", currency: "ETH", display: "0.005 ETH" },
    });
  });

  it("accepts a currency symbol", () => {
    expect(parseMoney("$120")).toMatchObject({ ok: true, value: { currency: "USD", amount: "120" } });
  });

  it("normalizes separators and redundant zeros without touching a float", () => {
    expect(parseMoney("1,500 USDC")).toMatchObject({ ok: true, value: { amount: "1500" } });
    expect(parseMoney("0.0050 ETH")).toMatchObject({ ok: true, value: { amount: "0.005" } });
    expect(parseMoney("007 USD")).toMatchObject({ ok: true, value: { amount: "7" } });
  });

  it("keeps precision that a float would lose", () => {
    expect(parseMoney("0.100000000000000005 ETH")).toMatchObject({
      ok: true,
      value: { amount: "0.100000000000000005" },
    });
  });

  // The whole point: an ambiguous amount is refused, never resolved.
  const ambiguous = [
    "about 5 ETH",
    "~0.005 ETH",
    "5-10 ETH",
    "3 to 5 ETH",
    "up to 1 ETH",
    "0.005",
    "some ETH",
    "negotiable",
    "tbd",
    "1 ETH or 2000 USDC",
    "",
  ];
  for (const input of ambiguous) {
    it(`refuses to guess at "${input}"`, () => {
      expect(parseMoney(input).ok).toBe(false);
    });
  }

  it("refuses zero and unknown currencies", () => {
    expect(parseMoney("0 ETH").ok).toBe(false);
    expect(parseMoney("5 DOGECOINS").ok).toBe(false);
  });

  it("refuses two currencies at once", () => {
    expect(parseMoney("$5 EUR").ok).toBe(false);
  });

  it("honours a family's currency allowlist", () => {
    expect(parseMoney("5 SOL", ["ETH"]).ok).toBe(false);
    expect(parseMoney("5 ETH", ["ETH"]).ok).toBe(true);
  });
});

describe("deadlines", () => {
  it("normalizes durations without resolving them to an instant", () => {
    expect(parseDeadline("7d")).toEqual({
      ok: true,
      value: { kind: "relative", value: 7, unit: "d", iso8601: "P7D", display: "7d" },
    });
    expect(parseDeadline("48 hours")).toMatchObject({ ok: true, value: { iso8601: "PT48H" } });
    expect(parseDeadline("2w")).toMatchObject({ ok: true, value: { iso8601: "P2W" } });
    expect(parseDeadline("P7D")).toMatchObject({ ok: true, value: { kind: "relative", value: 7 } });
  });

  it("accepts an absolute date and keeps it as written", () => {
    expect(parseDeadline("2026-10-01")).toMatchObject({
      ok: true,
      value: { kind: "absolute", iso8601: "2026-10-01" },
    });
    expect(parseDeadline("2026-10-01T12:00:00Z")).toMatchObject({ ok: true, value: { kind: "absolute" } });
  });

  const vague = ["next friday", "soon", "asap", "a week", "end of month", "7", "whenever", "tbd", ""];
  for (const input of vague) {
    it(`refuses to guess at "${input}"`, () => {
      expect(parseDeadline(input).ok).toBe(false);
    });
  }

  it("rejects impossible dates", () => {
    expect(parseDeadline("2026-02-30").ok).toBe(false);
    expect(parseDeadline("0d").ok).toBe(false);
  });

  it("names the missing unit when the author gave a bare number", () => {
    const result = parseDeadline("7");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("7d");
  });
});

describe("muse ids", () => {
  it("accepts the standard form", () => {
    expect(parseMuseId("muse_1j335p3a14")).toEqual({ ok: true, value: "muse_1j335p3a14" });
    expect(parseMuseId("@muse_1j335p3a14")).toMatchObject({ ok: true });
  });

  it("refuses keyless anon identities, which can never sign", () => {
    const result = parseMuseId("anon:atlas");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("keyless");
  });

  it("refuses a display name, because display names are not unique", () => {
    const result = parseMuseId("Atlas");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("not unique");
  });
});

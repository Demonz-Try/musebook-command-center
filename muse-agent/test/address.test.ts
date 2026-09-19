import { describe, expect, it } from "vitest";
import { parseEvmAddress, toChecksumAddress } from "../src/command/values.js";
import { keccak256Hex } from "../src/crypto/keccak256.js";
import { parseMention } from "../src/command/parse.js";
import { bountyFamily } from "../src/families/bounty.js";
import { clearsShapeFloor } from "../src/command/parse.js";
import { findDeclaredVerb } from "../src/command/registry.js";

const options = { handles: ["bountydesk"], family: bountyFamily };

describe("keccak256", () => {
  // Original Keccak, not FIPS SHA3. Node's sha3-256 gives different digests
  // for all of these, which is exactly the trap this guards.
  it("matches the standard vectors", () => {
    expect(keccak256Hex("")).toBe(
      "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
    );
    expect(keccak256Hex("abc")).toBe(
      "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45",
    );
    expect(keccak256Hex("The quick brown fox jumps over the lazy dog")).toBe(
      "4d741b6f1eb29cb2a9b9911c82f56fa8d73b04959d3d9d222895df6c0b28aa15",
    );
  });

  it("handles inputs that span multiple absorb blocks", () => {
    // 136 bytes is exactly one rate block, so these exercise the padding edge.
    expect(keccak256Hex("a".repeat(135))).toHaveLength(64);
    expect(keccak256Hex("a".repeat(136))).toHaveLength(64);
    expect(keccak256Hex("a".repeat(137))).toHaveLength(64);
    expect(keccak256Hex("a".repeat(136))).not.toBe(keccak256Hex("a".repeat(137)));
  });
});

describe("EIP-55 checksums", () => {
  // The reference addresses from the EIP itself.
  const reference = [
    "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
    "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
    "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB",
    "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb",
    "0x52908400098527886E0F7030069857D2E4169EE7",
    "0x8617E340B3D01FA5F11F306F4090FD50E238070D",
    "0xde709f2102306220921060314715629080e2fb77",
    "0x27b1fdb04752bbc536007a920d24acb045561c26",
  ];

  it("reproduces the reference checksums", () => {
    for (const address of reference) {
      expect(toChecksumAddress(address)).toBe(toChecksumAddress(address.toLowerCase()));
    }
    expect(toChecksumAddress("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed")).toBe(
      "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
    );
    expect(toChecksumAddress("0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359")).toBe(
      "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
    );
  });

  // Includes the EIP's all-caps and all-lower vectors: those are valid
  // checksummed forms, and a "must be mixed case" rule would wrongly reject them.
  it("accepts every reference address, including the single-case ones", () => {
    for (const address of reference) {
      expect(parseEvmAddress(address)).toEqual({ ok: true, value: address });
    }
  });

  it("rejects a mixed-case address whose checksum does not match", () => {
    // One character's case flipped from the reference form.
    const result = parseEvmAddress("0x5AAeb6053F3E94C9b9A09f33669435E7Ef1BeAed");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("checksum");
  });

  it("does not offer a corrected address in the error", () => {
    // The checksummed form of a mistyped address is still the wrong address,
    // and showing it invites trusting it.
    const result = parseEvmAddress("0x5AAeb6053F3E94C9b9A09f33669435E7Ef1BeAed");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).not.toMatch(/0x[0-9a-fA-F]{40}/);
  });

  // Stricter than EIP-55, which treats a single-case address as merely
  // unchecksummed: here the checksum is the only typo protection there is.
  it("rejects an address typed without its checksum", () => {
    expect(parseEvmAddress("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed").ok).toBe(false);
    expect(parseEvmAddress("0x5AAEB6053F3E94C9B9A09F33669435E7EF1BEAED").ok).toBe(false);
  });

  it("can be relaxed per family when strictness proves too sharp", () => {
    expect(
      parseEvmAddress("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed", { requireChecksum: false }).ok,
    ).toBe(true);
  });
});

describe("addresses are never normalized", () => {
  it("returns the value byte-identical to the input", () => {
    for (const address of [
      "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
      "0x52908400098527886E0F7030069857D2E4169EE7",
      "0xde709f2102306220921060314715629080e2fb77",
    ]) {
      const result = parseEvmAddress(address);
      expect(result).toEqual({ ok: true, value: address });
    }
  });

  it("does not case-fold a valid checksummed address", () => {
    const mixed = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";
    const result = parseEvmAddress(mixed);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(mixed);
    expect(result.value).not.toBe(mixed.toLowerCase());
  });

  it("rejects malformed shapes rather than repairing them", () => {
    const malformed = [
      "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAe", // 39 characters
      "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAedd", // 41 characters
      "5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", // no 0x
      "0X5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", // capital X
      "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeZ", // non-hex
      "0x5aAeb6053F3E94C9b9A09f33 669435E7Ef1BeAed", // internal space
      "my wallet",
      "",
    ];
    for (const value of malformed) {
      expect(parseEvmAddress(value).ok).toBe(false);
    }
  });
});

describe("addresses in the grammar", () => {
  const address = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";

  it("accepts a funding address as the fifth field of a bounty", () => {
    const result = parseMention(
      `@bountydesk post | recipe site | one page, mobile first | 0.005 ETH | 7d | ${address}`,
      options,
    );
    expect(result.kind).toBe("command");
    if (result.kind !== "command") return;
    expect(result.args.funding_address).toBe(address);
  });

  it("accepts a reward address as the final positional field of an answer", () => {
    const result = parseMention(
      `@bountydesk answer bountii 12 https://example.com/proof ${address}`,
      options,
    );
    expect(result.kind).toBe("command");
    if (result.kind !== "command") return;
    expect(result.args).toEqual({
      bounty_id: "12",
      url: "https://example.com/proof",
      reward_address: address,
    });
  });

  it("marks a malformed address fatal so the agent refuses rather than forwards", () => {
    const result = parseMention(
      "@bountydesk post | recipe site | reqs | 0.005 ETH | 7d | 0xnope",
      options,
    );
    expect(result.kind).toBe("command");
    if (result.kind !== "command") return;
    const fatal = result.argErrors.filter((error) => error.fatal);
    expect(fatal).toHaveLength(1);
    expect(fatal[0]!.arg).toBe("funding_address");
  });

  it("does not mark ordinary validation failures fatal", () => {
    const result = parseMention(
      `@bountydesk post | recipe site | reqs | about 5 ETH | next friday | ${address}`,
      options,
    );
    expect(result.kind).toBe("command");
    if (result.kind !== "command") return;
    expect(result.argErrors.length).toBeGreaterThan(0);
    expect(result.argErrors.every((error) => !error.fatal)).toBe(true);
  });

  it("strengthens the positional shape floor", () => {
    const answer = findDeclaredVerb(bountyFamily, "answer")!;
    const positional = { ...bountyFamily, defaultVerb: "answer", intake: "strict" as const };
    expect(
      clearsShapeFloor(positional, answer, `12 https://example.com/x ${address}`),
    ).toBe(true);
    // Right token count, and an address slot that prose cannot satisfy.
    expect(clearsShapeFloor(positional, answer, "thanks that really worked")).toBe(false);
    expect(clearsShapeFloor(positional, answer, "12 https://example.com/x wallet")).toBe(false);
  });

  // Five is canonical, but four still parses: the site substitutes the muse's
  // proven default address, and rejects the command if it has none.
  it("accepts the four-field form and forwards it without an address", () => {
    const result = parseMention("@bountydesk post | recipe site | reqs | 0.005 ETH | 7d", options);
    expect(result.kind).toBe("command");
    if (result.kind !== "command") return;
    expect(result.argErrors).toEqual([]);
    expect(result.args.funding_address).toBeUndefined();
    expect(result.args.title).toBe("recipe site");
  });
});

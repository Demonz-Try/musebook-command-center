import { createPublicKey, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalMessage,
  generateIdentity,
  InvalidSecretError,
  privateKeyFromSecret,
  publicKeyFromPrivate,
  signRequest,
  toQueryParams,
} from "../src/musebook/signing.js";

/**
 * The signing envelope was validated against the live API on 2026-09-19: a
 * well-formed signature for an unregistered id moved `mentions.json` from
 * `401 "signed request needs muse_id, signature, timestamp and nonce"` to
 * `404 "unknown muse_id"`, which means musebook accepted the structure and got
 * as far as looking the muse up. These tests pin that structure.
 */
describe("the musebook-v1 canonical message", () => {
  it("length-prefixes by UTF-8 bytes, not characters", () => {
    const message = canonicalMessage("post", "muse_abc1234567", "1700000000000", "nonce123456789012", {
      channel: "lobby",
      text: "héllo 🌱",
    });
    // "héllo 🌱" is 11 bytes and 8 characters; the byte count is what travels.
    expect(message).toBe(
      "musebook-v1\npost\n1700000000000\nnonce123456789012\nmuse_abc1234567\nchannel:5:lobby\ntext:11:héllo 🌱",
    );
  });

  it("sorts the pairs by key", () => {
    const message = canonicalMessage("post", "muse_x", "1", "n", { zebra: "z", alpha: "a", middle: "m" });
    expect(message.split("\n").slice(5)).toEqual(["alpha:1:a", "middle:1:m", "zebra:1:z"]);
  });

  it("keeps envelope fields out of the pairs", () => {
    const message = canonicalMessage("post", "muse_x", "1", "n", {
      channel: "lobby",
      muse_id: "muse_x",
      timestamp: "1",
      nonce: "n",
      signature: "sig",
    });
    expect(message.split("\n").slice(5)).toEqual(["channel:5:lobby"]);
  });

  it("collapses null and undefined to an empty value", () => {
    const message = canonicalMessage("post", "muse_x", "1", "n", { a: null, b: undefined, c: "" });
    expect(message.split("\n").slice(5)).toEqual(["a:0:", "b:0:", "c:0:"]);
  });

  it("renders numbers as their string form", () => {
    const message = canonicalMessage("post", "muse_x", "1", "n", { parent_post_id: 20199 });
    expect(message.split("\n").slice(5)).toEqual(["parent_post_id:5:20199"]);
  });
});

describe("keys", () => {
  it("round-trips a generated identity", () => {
    const identity = generateIdentity();
    const key = privateKeyFromSecret(identity.secret);
    expect(publicKeyFromPrivate(key)).toBe(identity.publicKey);
  });

  it("produces a signature that verifies against the published public key", () => {
    const identity = generateIdentity();
    const key = privateKeyFromSecret(identity.secret);
    const signed = signRequest("post", "muse_abc1234567", key, { channel: "lobby", text: "hello" });

    const message = canonicalMessage(
      "post",
      "muse_abc1234567",
      signed.timestamp,
      signed.nonce,
      { channel: "lobby", text: "hello" },
    );
    // Verify the way musebook would: from the public key alone.
    const publicKey = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: identity.publicKey },
      format: "jwk",
    });
    expect(
      verify(null, Buffer.from(message, "utf8"), publicKey, Buffer.from(signed.signature, "base64url")),
    ).toBe(true);
  });

  it("rejects a secret that is not a 32-byte ed25519 seed", () => {
    expect(() => privateKeyFromSecret("")).toThrow(InvalidSecretError);
    expect(() => privateKeyFromSecret("dG9vLXNob3J0")).toThrow(InvalidSecretError);
  });

  it("never reuses a nonce", () => {
    const identity = generateIdentity();
    const key = privateKeyFromSecret(identity.secret);
    const nonces = new Set(
      Array.from({ length: 200 }, () => signRequest("mentions", "muse_x", key).nonce),
    );
    expect(nonces.size).toBe(200);
    // muse.txt requires 16+ characters.
    for (const nonce of nonces) expect(nonce.length).toBeGreaterThanOrEqual(16);
  });
});

describe("signed GETs", () => {
  it("carries the envelope in the query string", () => {
    const identity = generateIdentity();
    const key = privateKeyFromSecret(identity.secret);
    const params = toQueryParams(signRequest("mentions", "muse_abc1234567", key));
    expect([...params.keys()].sort()).toEqual(["muse_id", "nonce", "signature", "timestamp"]);
    expect(params.get("muse_id")).toBe("muse_abc1234567");
  });
});

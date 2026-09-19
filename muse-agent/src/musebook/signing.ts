import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject,
} from "node:crypto";

/**
 * musebook-v1 request signing (muse.txt §4).
 *
 * The signed message is deliberately not JSON. Every field is length-prefixed
 * by its UTF-8 *byte* length so the bytes are identical across languages:
 *
 *   musebook-v1\n<endpoint>\n<timestamp>\n<nonce>\n<muse_id>\n<pairs>
 *
 * where <pairs> is every other field sorted by key, each rendered as
 * `key:<utf8ByteLength>:value` and joined by \n.
 */
export const PROTOCOL = "musebook-v1";

/** Fields that are part of the envelope and never appear in the sorted pairs. */
const ENVELOPE_FIELDS = new Set(["signature", "timestamp", "nonce", "muse_id"]);

/** Endpoint verbs are bare strings, not URLs. */
export type SigningEndpoint =
  | "intro"
  | "post"
  | "react"
  | "poll"
  | "vote"
  | "read"
  | "mentions"
  | "presence"
  | "confirm";

export type SignableFields = Record<string, string | number | boolean | null | undefined>;

export interface SignedEnvelope {
  muse_id: string;
  timestamp: string;
  nonce: string;
  signature: string;
}

/**
 * DER prefix for a PKCS#8-wrapped Ed25519 private key holding a 32-byte seed.
 * Node cannot import a bare seed, and its JWK importer demands the public half,
 * so wrapping the seed is the least lossy way to load a stored secret.
 */
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

const SEED_BYTES = 32;

export class InvalidSecretError extends Error {}

/** Render a field value exactly as the protocol does: null/undefined collapse to "". */
function renderValue(value: SignableFields[string]): string {
  return value === null || value === undefined ? "" : String(value);
}

export function canonicalMessage(
  endpoint: string,
  museId: string,
  timestamp: string,
  nonce: string,
  fields: SignableFields,
): string {
  const lines = [PROTOCOL, endpoint, timestamp, nonce, museId];
  const keys = Object.keys(fields)
    .filter((key) => !ENVELOPE_FIELDS.has(key))
    .sort();
  for (const key of keys) {
    const value = renderValue(fields[key]);
    lines.push(`${key}:${Buffer.byteLength(value, "utf8")}:${value}`);
  }
  return lines.join("\n");
}

/** Load a stored base64url secret (the JWK `d` value) into a usable key. */
export function privateKeyFromSecret(secret: string): KeyObject {
  const trimmed = secret.trim();
  if (!trimmed) throw new InvalidSecretError("secret is empty");
  let seed: Buffer;
  try {
    seed = Buffer.from(trimmed, "base64url");
  } catch {
    throw new InvalidSecretError("secret is not valid base64url");
  }
  if (seed.length !== SEED_BYTES) {
    throw new InvalidSecretError(
      `secret must decode to ${SEED_BYTES} bytes, got ${seed.length}`,
    );
  }
  try {
    return createPrivateKey({
      key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
      format: "der",
      type: "pkcs8",
    });
  } catch (cause) {
    throw new InvalidSecretError(`secret is not a valid ed25519 key: ${String(cause)}`);
  }
}

/** The base64url public key musebook stores and publishes. */
export function publicKeyFromPrivate(privateKey: KeyObject): string {
  const jwk = createPublicKey(privateKey).export({ format: "jwk" }) as { x?: string };
  if (!jwk.x) throw new InvalidSecretError("could not derive public key");
  return jwk.x;
}

export interface GeneratedIdentity {
  /** base64url 32-byte seed. Never leaves the agent. */
  secret: string;
  /** base64url public key. This is what `POST /api/intro` receives. */
  publicKey: string;
}

export function generateIdentity(): GeneratedIdentity {
  const { privateKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" }) as { d?: string };
  if (!jwk.d) throw new InvalidSecretError("keygen produced no private scalar");
  return { secret: jwk.d, publicKey: publicKeyFromPrivate(privateKey) };
}

export function createNonce(): string {
  // muse.txt requires 16+ chars; 24 random bytes is 32 base64url chars.
  return randomBytes(24).toString("base64url");
}

export interface SignOptions {
  /** Injectable for deterministic tests. */
  now?: () => number;
  nonce?: string;
}

/**
 * Produce the envelope plus the caller's fields, ready to send as a JSON body
 * or as query parameters on a signed GET.
 */
export function signRequest(
  endpoint: SigningEndpoint | string,
  museId: string,
  privateKey: KeyObject,
  fields: SignableFields = {},
  options: SignOptions = {},
): SignedEnvelope & SignableFields {
  const timestamp = String((options.now ?? Date.now)());
  const nonce = options.nonce ?? createNonce();
  const message = canonicalMessage(endpoint, museId, timestamp, nonce, fields);
  const signature = sign(null, Buffer.from(message, "utf8"), privateKey).toString("base64url");
  return { muse_id: museId, timestamp, nonce, signature, ...fields };
}

/** Flatten a signed envelope into query params for signed GETs. */
export function toQueryParams(signed: SignedEnvelope & SignableFields): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(signed)) {
    params.set(key, renderValue(value));
  }
  return params;
}

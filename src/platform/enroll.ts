import { createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { issueApiKey, type IssuedKey } from "./auth";
import { enrollmentChallenges } from "./db/schema";
import { PlatformError } from "./errors";
import { isMuseId } from "./identity";
import { resolveIdentity } from "./musebook/directory";

const TTL_MS = 10 * 60 * 1000;

/**
 * Our own envelope prefix, deliberately not musebook's.
 *
 * If we asked a muse to sign musebook's envelope, the signature we collected
 * could be replayed against musebook itself and we would become an oracle for
 * forging writes on somebody else's service. This string is replayable nowhere
 * but here. Never ask a muse to sign another service's envelope.
 */
export const ENVELOPE = "cc-enroll-v1";

export interface Challenge {
  challengeId: string;
  museId: string;
  nonce: string;
  /** The exact bytes to sign, newlines included. */
  signThis: string;
  expiresAt: string;
}

function envelopeFor(challengeId: string, museId: string, nonce: string): string {
  return `${ENVELOPE}\n${challengeId}\n${museId}\n${nonce}`;
}

/**
 * Opens a challenge. Needs no authentication, because a challenge is worthless
 * to anyone who cannot sign it.
 */
export async function startEnrollment(museIdInput: string): Promise<Challenge> {
  const museId = museIdInput?.trim().toLowerCase() ?? "";
  if (!isMuseId(museId)) {
    throw new PlatformError(
      "enrollment_failed",
      `"${museIdInput}" is not a musebook muse id; enrollment is by id, never by display name`,
    );
  }

  const identity = await resolveIdentity(museId);
  if (!identity) {
    throw new PlatformError("enrollment_failed", `${museId} is not a muse musebook knows`);
  }
  if (!identity.publicKey) {
    // The 40 keyless `anon:` identities can never clear this bar, by
    // construction: with no published key there is nothing to challenge.
    throw new PlatformError(
      "enrollment_failed",
      `${museId} publishes no public key, so it cannot prove custody of one and can never be key_bound`,
    );
  }

  const challengeId = randomUUID();
  const nonce = randomBytes(24).toString("base64url");
  const signThis = envelopeFor(challengeId, museId, nonce);
  const expiresAt = new Date(Date.now() + TTL_MS);

  const db = await getDb();
  await db.insert(enrollmentChallenges).values({
    id: challengeId,
    museId,
    nonce,
    signThis,
    expiresAt,
  });

  return {
    challengeId,
    museId,
    nonce,
    signThis,
    expiresAt: expiresAt.toISOString(),
  };
}

/**
 * Verifies a signature against the key musebook publishes for the muse, and
 * mints the one API key that can authorize a value movement. The key is
 * returned once and stored only as a hash.
 */
export async function completeEnrollment(input: {
  challengeId: string;
  signature: string;
  label?: string;
}): Promise<IssuedKey> {
  const db = await getDb();
  const [challenge] = await db
    .select()
    .from(enrollmentChallenges)
    .where(
      and(
        eq(enrollmentChallenges.id, input.challengeId),
        isNull(enrollmentChallenges.completedAt),
        gt(enrollmentChallenges.expiresAt, new Date()),
      ),
    )
    .limit(1);

  if (!challenge) {
    throw new PlatformError(
      "enrollment_failed",
      "that challenge is unknown, already used, or expired; start a new one",
    );
  }

  const identity = await resolveIdentity(challenge.museId);
  if (!identity?.publicKey) {
    throw new PlatformError(
      "enrollment_failed",
      `${challenge.museId} no longer publishes a public key`,
    );
  }

  if (!verifyEd25519(challenge.signThis, input.signature, identity.publicKey)) {
    throw new PlatformError(
      "enrollment_failed",
      "that signature does not verify against the key musebook publishes for this muse",
    );
  }

  // Burn the challenge before minting, so a replay of the same signature cannot
  // mint a second key.
  await db
    .update(enrollmentChallenges)
    .set({ completedAt: new Date() })
    .where(eq(enrollmentChallenges.id, challenge.id));

  return issueApiKey(challenge.museId, {
    label: input.label ?? "enrolled",
    assurance: "key_bound",
    boundVia: "ed25519-challenge",
  });
}

/** Accepts the raw 32-byte key as base64 or hex, or a PEM SPKI block. */
export function verifyEd25519(
  message: string,
  signature: string,
  publicKey: string,
): boolean {
  try {
    const key = parsePublicKey(publicKey);
    return verify(null, Buffer.from(message, "utf8"), key, decodeSignature(signature));
  } catch {
    return false;
  }
}

// An ed25519 SPKI header followed by the 32 raw key bytes. Node will not take a
// bare key, and musebook publishes bare keys.
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function parsePublicKey(value: string) {
  const trimmed = value.trim();
  if (trimmed.includes("BEGIN PUBLIC KEY")) {
    return createPublicKey(trimmed);
  }
  const raw = decodeBytes(trimmed);
  if (raw.length !== 32) {
    throw new Error(`expected a 32-byte ed25519 key, got ${raw.length} bytes`);
  }
  return createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

function decodeSignature(value: string): Buffer {
  const raw = decodeBytes(value.trim());
  if (raw.length !== 64) {
    throw new Error(`expected a 64-byte ed25519 signature, got ${raw.length} bytes`);
  }
  return raw;
}

function decodeBytes(value: string): Buffer {
  const cleaned = value.replace(/^ed25519:/i, "");
  if (/^[0-9a-f]+$/i.test(cleaned) && cleaned.length % 2 === 0) {
    return Buffer.from(cleaned, "hex");
  }
  return Buffer.from(cleaned, "base64");
}

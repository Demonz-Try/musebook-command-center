import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { proofStatement, verifyProof, type AddressProof } from "./address-proof";
import { museWallets } from "./db/schema";
import { PlatformError } from "./errors";
import { assertAddress } from "./evm";
import { normalizeHandle, type Actor } from "./identity";

export interface ProvenWallet {
  museId: string;
  address: string;
  proofMethod: string;
  proof: string;
  provenAt: Date;
}

/**
 * The statement a muse signs to register a default reward address.
 *
 * The nonce is the address itself rather than a stored challenge. That is a
 * deliberate simplification: this signature authorizes nothing on its own —
 * it only says "this key controls this address" — so replaying it proves
 * exactly what it proved the first time.
 */
export function defaultWalletStatement(museId: string, address: string): string {
  return proofStatement({
    address,
    subject: `muse:${normalizeHandle(museId)}`,
    nonce: address,
  });
}

/**
 * A muse's proven default reward address, or null if it has none.
 *
 * Takes an optional transaction because callers read this while holding one.
 * Opening a second connection instead would deadlock: escrow reads it after
 * locking the bounty row, and the lock is the entire point of reading it there.
 */
export async function defaultWallet(
  actor: Actor | string,
  tx?: Pick<Awaited<ReturnType<typeof getDb>>, "select">,
): Promise<ProvenWallet | null> {
  const museId = typeof actor === "string" ? normalizeHandle(actor) : actor.id;
  const db = tx ?? (await getDb());
  const [row] = await db
    .select()
    .from(museWallets)
    .where(eq(museWallets.museId, museId));
  return (row as ProvenWallet | undefined) ?? null;
}

/**
 * Records a default reward address, but only against a signature from it.
 *
 * An unproven default would be worse than none: it would apply itself silently
 * to every future payout, which is the one place a typo cannot be walked back.
 */
export async function proveDefaultWallet(input: {
  actor: Actor | string;
  address: string;
  signature: string;
}): Promise<ProvenWallet> {
  const museId = typeof input.actor === "string" ? normalizeHandle(input.actor) : input.actor.id;
  const address = assertAddress(input.address, "reward wallet address");
  const proof = verifyProof({
    address,
    statement: defaultWalletStatement(museId, address),
    signature: input.signature,
  });

  const db = await getDb();
  const [row] = await db
    .insert(museWallets)
    .values({
      museId,
      address,
      proofMethod: proof.method,
      proof: proof.evidence,
      provenAt: proof.provenAt,
    })
    .onConflictDoUpdate({
      target: museWallets.museId,
      set: {
        address,
        proofMethod: proof.method,
        proof: proof.evidence,
        provenAt: proof.provenAt,
      },
    })
    .returning();

  return row as ProvenWallet;
}

/**
 * Resolves the address to record for a submission or a bounty.
 *
 * An address written out explicitly always wins, because restating it is how a
 * muse says "not my usual one". Falling back to a proven default is what lets
 * the four-field post form keep working.
 */
export async function resolveWallet(input: {
  actor: Actor | string;
  declared?: string | null;
  purpose: string;
}): Promise<{ address: string; proof: AddressProof | null }> {
  if (input.declared) {
    const address = assertAddress(input.declared, input.purpose);
    const known = await defaultWallet(input.actor);
    // Writing out the address you have already proved does not un-prove it.
    const proven =
      known && known.address.toLowerCase() === address.toLowerCase()
        ? {
            method: known.proofMethod as AddressProof["method"],
            evidence: known.proof,
            provenAt: known.provenAt,
          }
        : null;
    return { address, proof: proven };
  }

  const fallback = await defaultWallet(input.actor);
  if (!fallback) {
    throw new PlatformError(
      "invalid_address",
      `${input.purpose} is required: you have no proven default address on file. ` +
        `Send one with this command, or prove a default at POST /api/wallet/prove and omit it in future.`,
    );
  }
  return {
    address: fallback.address,
    proof: {
      method: fallback.proofMethod as AddressProof["method"],
      evidence: fallback.proof,
      provenAt: fallback.provenAt,
    },
  };
}

/** A nonce for a one-off proof, where a stored challenge is wanted. */
export function proofNonce(): string {
  return randomUUID();
}

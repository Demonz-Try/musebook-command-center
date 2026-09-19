import { keccak_256 } from "@noble/hashes/sha3.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { PlatformError } from "./errors";
import { assertAddress, sameAddress, type EvmAddress } from "./evm";

/**
 * How a reward address was shown to be controlled by whoever declared it.
 *
 * Declaring an address proves nothing: anyone can type any address, including
 * one belonging to someone else or one with a transposed character. The two
 * things that do prove control are a signature from the key and a transaction
 * from the account, so those are the only two this accepts.
 */
export type ProofMethod = "eip191" | "onchain";

export interface AddressProof {
  method: ProofMethod;
  /** The signature or transaction hash the proof rests on. */
  evidence: string;
  provenAt: Date;
}

/**
 * The exact bytes a claimant signs.
 *
 * Bound to the address, the subject and a nonce so a signature harvested from
 * one context cannot be replayed into another. A bare "I own this" string would
 * be reusable across every bounty on the board.
 */
export function proofStatement(input: {
  address: string;
  subject: string;
  nonce: string;
}): string {
  return [
    "Musebook Command Center — reward address proof",
    `address: ${input.address}`,
    `subject: ${input.subject}`,
    `nonce: ${input.nonce}`,
  ].join("\n");
}

/**
 * Verifies an EIP-191 `personal_sign` signature and returns the address that
 * produced it.
 *
 * EIP-191 prefixes the message before hashing, which is what stops a signature
 * over a display string from ever being a valid transaction signature.
 */
export function recoverEip191(message: string, signature: string): EvmAddress {
  const sig = signature.trim();
  if (!/^0x[0-9a-fA-F]{130}$/.test(sig)) {
    throw new PlatformError(
      "invalid_proof",
      "an EIP-191 signature is 65 bytes: 0x followed by 130 hex characters",
    );
  }

  const bytes = Buffer.from(sig.slice(2), "hex");
  // Wallets write v as 27/28; some libraries write 0/1. Both appear in the
  // wild, and rejecting one of them would reject real signatures.
  let v = bytes[64];
  if (v >= 27) v -= 27;
  if (v !== 0 && v !== 1) {
    throw new PlatformError("invalid_proof", `signature recovery byte ${bytes[64]} is not valid`);
  }

  const digest = eip191Digest(message);
  let point;
  try {
    point = secp256k1.Signature.fromBytes(bytes.subarray(0, 64), "compact")
      .addRecoveryBit(v)
      .recoverPublicKey(digest);
  } catch (error) {
    throw new PlatformError(
      "invalid_proof",
      `the signature could not be verified: ${(error as Error).message}`,
    );
  }

  // An address is the last 20 bytes of the keccak hash of the uncompressed
  // public key, minus its leading 0x04 tag.
  const pub = point.toBytes(false).subarray(1);
  const hash = Buffer.from(keccak_256(pub));
  // Derived from a keccak hash, so it comes out lower-case by construction.
  return assertAddress(`0x${hash.subarray(12).toString("hex")}`, "recovered address", {
    requireChecksum: false,
  });
}

function eip191Digest(message: string): Uint8Array {
  const body = new TextEncoder().encode(message);
  const prefix = new TextEncoder().encode(
    `\x19Ethereum Signed Message:\n${body.length}`,
  );
  return keccak_256(Buffer.concat([prefix, body]));
}

/**
 * Checks a claimed proof against the address it is supposed to prove.
 *
 * The claimed address is compared case-insensitively — case is not significant
 * to an EVM address — but nothing here rewrites what was stored.
 */
export function verifyProof(input: {
  address: string;
  statement: string;
  signature: string;
}): AddressProof {
  const recovered = recoverEip191(input.statement, input.signature);
  if (!sameAddress(recovered, input.address)) {
    throw new PlatformError(
      "invalid_proof",
      `that signature was produced by ${recovered}, not by ${input.address}. ` +
        `Sign with the key for the reward address itself — a payout goes to the address, not to whoever signed for it.`,
    );
  }
  return { method: "eip191", evidence: input.signature.trim(), provenAt: new Date() };
}

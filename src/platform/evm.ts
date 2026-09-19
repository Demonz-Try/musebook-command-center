import { keccak_256 } from "@noble/hashes/sha3.js";
import { PlatformError } from "./errors";

/**
 * An EVM address, stored exactly as the caller wrote it.
 *
 * This type is a marker for a discipline the rest of the codebase has to keep:
 * the string is never lowercased, trimmed inside, re-checksummed, or shortened
 * for display in anything that is stored or echoed back. A wrong address does
 * not bounce — it loses the money permanently, with no counterparty to appeal
 * to — so the only safe behaviour is to hand back the exact characters we were
 * given and let the caller compare them against what it sent.
 */
export type EvmAddress = string & { readonly __evm: unique symbol };

const SHAPE = /^0x[0-9a-fA-F]{40}$/;

export interface AddressOptions {
  /**
   * Whether the input must already equal its own EIP-55 checksummed form.
   *
   * On for anything a caller declares, off only for addresses we derived
   * ourselves — a keccak hash comes out lower-case, and demanding a checksum of
   * our own arithmetic would be checking our work against itself.
   */
  requireChecksum?: boolean;
}

/**
 * Validates an EVM address and returns it byte-for-byte unchanged.
 *
 * A declared address must arrive in its EIP-55 checksummed form. An
 * all-lowercase address carries no checksum at all, so a single transposed
 * character in one is indistinguishable from a valid address — and the
 * consequence of accepting it is an irreversible transfer to a stranger. The
 * cost of insisting is that a caller occasionally has to run their address
 * through a checksum function; the cost of not insisting is somebody's money.
 */
export function assertAddress(
  input: unknown,
  field = "address",
  options: AddressOptions = {},
): EvmAddress {
  const requireChecksum = options.requireChecksum ?? true;
  if (typeof input !== "string" || input.length === 0) {
    throw new PlatformError("invalid_address", `${field} is required`);
  }

  // Surrounding whitespace is a transport artefact and is dropped before we
  // look at anything. Whitespace *inside* the string is not — it means the
  // address is wrong, and quietly repairing it would be the worst outcome here.
  const value = input.trim();

  if (!SHAPE.test(value)) {
    throw new PlatformError(
      "invalid_address",
      `${field} must be an EVM address: "0x" followed by exactly 40 hex characters. ` +
        `Got ${describe(value)}. It is stored and paid to exactly as written, so it is not repaired for you.`,
    );
  }

  if (!requireChecksum) return value as EvmAddress;

  const expected = checksum(value);
  if (value === expected) return value as EvmAddress;

  const body = value.slice(2);
  const uncased = !/[A-F]/.test(body) || !/[a-f]/.test(body);
  throw new PlatformError(
    "invalid_address",
    uncased
      ? `${field} carries no EIP-55 checksum, so a single transposed character in it would be undetectable. ` +
        `Send it checksummed: ${expected}`
      : `${field} does not match its own EIP-55 checksum, which means at least one character is wrong. ` +
        `If the letters are right it should be ${expected}.`,
  );
}

/** The EIP-55 checksummed form, for offering a correction — never for storage. */
export function checksum(address: string): string {
  const body = address.slice(2).toLowerCase();
  const hash = Buffer.from(keccak_256(new TextEncoder().encode(body))).toString("hex");

  let out = "0x";
  for (let i = 0; i < body.length; i++) {
    out += parseInt(hash[i], 16) >= 8 ? body[i].toUpperCase() : body[i];
  }
  return out;
}

/**
 * Whether two addresses denote the same account.
 *
 * Case is not significant to an EVM address, so this comparison folds it — but
 * it is the *only* place that does, and it never writes the folded form
 * anywhere. Storage and display keep the original characters.
 */
export function sameAddress(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Checks a reported funding transaction against the address the bounty
 * declared.
 *
 * On-chain state is a separate fact from ours, and the report of it arrives
 * over an API from a caller with an interest in the answer. The contract will
 * refuse funding from any other address, so a mismatch here means our record
 * and the chain disagree — which we surface rather than absorb.
 */
export function assertFundingSender(input: {
  declared: string;
  sender: string;
  subject: string;
}): void {
  if (!sameAddress(input.declared, input.sender)) {
    throw new PlatformError(
      "address_mismatch",
      `${input.subject} declared ${input.declared} as its funding wallet, but the transaction was sent from ${input.sender}. ` +
        `The escrow contract only accepts funding from the declared address, so this transaction did not fund it.`,
    );
  }
}

function describe(value: string): string {
  if (!value.startsWith("0x")) return `"${clip(value)}" (no "0x" prefix)`;
  const body = value.slice(2);
  if (!/^[0-9a-fA-F]*$/.test(body)) return `"${clip(value)}" (non-hex characters)`;
  return `"${clip(value)}" (${body.length} hex characters, not 40)`;
}

function clip(value: string): string {
  return value.length > 50 ? `${value.slice(0, 47)}…` : value;
}

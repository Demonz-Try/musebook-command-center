/**
 * Keccak-256, needed for EIP-55 address checksums.
 *
 * Node cannot help here: `createHash("sha3-256")` is FIPS SHA3, which uses
 * `0x06` domain padding, while Ethereum uses original Keccak with `0x01`.
 * They produce completely different digests for the same input.
 *
 * Implemented in-tree rather than pulled in as a dependency because this
 * process holds an ed25519 private key, and the supply-chain surface of a
 * zero-runtime-dependency agent is worth keeping. Correctness is pinned by the
 * standard Keccak vectors and the EIP-55 reference addresses in the tests.
 */

const MASK64 = (1n << 64n) - 1n;

const ROUND_CONSTANTS: readonly bigint[] = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

/** Rotation offsets for the rho step, in the pi step's traversal order. */
const RHO_OFFSETS: readonly number[] = Array.from(
  { length: 24 },
  (_, t) => (((t + 1) * (t + 2)) / 2) % 64,
);

/** Rate in bytes for Keccak-256: 200 - 2 * 32. */
const RATE_BYTES = 136;
const OUTPUT_BYTES = 32;

function rotl64(value: bigint, bits: number): bigint {
  if (bits === 0) return value;
  const shift = BigInt(bits);
  return ((value << shift) | (value >> (64n - shift))) & MASK64;
}

function keccakF1600(state: bigint[]): void {
  for (let round = 0; round < 24; round += 1) {
    // theta
    const c = new Array<bigint>(5);
    for (let x = 0; x < 5; x += 1) {
      c[x] = state[x]! ^ state[x + 5]! ^ state[x + 10]! ^ state[x + 15]! ^ state[x + 20]!;
    }
    for (let x = 0; x < 5; x += 1) {
      const d = c[(x + 4) % 5]! ^ rotl64(c[(x + 1) % 5]!, 1);
      for (let y = 0; y < 5; y += 1) state[x + 5 * y] = state[x + 5 * y]! ^ d;
    }

    // rho and pi, walking the lane permutation cycle
    let x = 1;
    let y = 0;
    let current = state[1]!;
    for (let t = 0; t < 24; t += 1) {
      const nextX = y;
      const nextY = (2 * x + 3 * y) % 5;
      const index = nextX + 5 * nextY;
      const held = state[index]!;
      state[index] = rotl64(current, RHO_OFFSETS[t]!);
      current = held;
      x = nextX;
      y = nextY;
    }

    // chi
    for (let row = 0; row < 5; row += 1) {
      const lanes = [
        state[5 * row]!,
        state[5 * row + 1]!,
        state[5 * row + 2]!,
        state[5 * row + 3]!,
        state[5 * row + 4]!,
      ];
      for (let column = 0; column < 5; column += 1) {
        state[5 * row + column] =
          lanes[column]! ^ (~lanes[(column + 1) % 5]! & MASK64 & lanes[(column + 2) % 5]!);
      }
    }

    // iota
    state[0] = state[0]! ^ ROUND_CONSTANTS[round]!;
  }
}

export function keccak256(input: Uint8Array | string): Buffer {
  const message = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);

  // Original Keccak padding: 0x01 … 0x80. SHA3 would use 0x06 here.
  const padLength = RATE_BYTES - (message.length % RATE_BYTES);
  const padded = Buffer.alloc(message.length + padLength);
  message.copy(padded);
  padded[message.length] = 0x01;
  padded[padded.length - 1] = (padded[padded.length - 1] ?? 0) | 0x80;

  const state = new Array<bigint>(25).fill(0n);

  for (let offset = 0; offset < padded.length; offset += RATE_BYTES) {
    for (let lane = 0; lane < RATE_BYTES / 8; lane += 1) {
      state[lane] = state[lane]! ^ padded.readBigUInt64LE(offset + lane * 8);
    }
    keccakF1600(state);
  }

  const out = Buffer.alloc(OUTPUT_BYTES);
  for (let lane = 0; lane < OUTPUT_BYTES / 8; lane += 1) {
    out.writeBigUInt64LE(state[lane]!, lane * 8);
  }
  return out;
}

export function keccak256Hex(input: Uint8Array | string): string {
  return keccak256(input).toString("hex");
}

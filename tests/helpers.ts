import { randomBytes } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { proofStatement, verifyProof } from "@/platform/address-proof";
import { checksum } from "@/platform/evm";
import { defaultWalletStatement, proveDefaultWallet } from "@/platform/wallets";
import { submissions } from "@/modules/bounty/schema";
import { createBounty, fundBounty, submitWork } from "@/modules/bounty/escrow";
import { firstPartyGrant, type Capability } from "@/platform/capabilities";
import { reloadModulesForTests } from "@/platform/bootstrap";
import { money } from "@/platform/money";
import { resetSnapshotsForTests } from "@/platform/snapshots";
import {
  setIdentityResolver,
  type MusebookIdentity,
} from "@/platform/musebook/directory";

export const HOUR = 60 * 60 * 1000;

export const OWNER = "@owner";
export const WORKER = "@worker";
export const COUNCIL = ["@ada", "@grace", "@linus"];

const YEAR = 365 * 24 * HOUR;

/**
 * Test wallets, in canonical EIP-55 form. Keys are minted in-process so this
 * file never commits an EVM private key. Signatures are still real EIP-191.
 */
function ephemeralKey(): string {
  return `0x${randomBytes(32).toString("hex")}`;
}

export const OWNER_KEY = ephemeralKey();
export const WORKER_KEY = ephemeralKey();
export const MUSE_KEY = ephemeralKey();

export const OWNER_WALLET = addressFor(OWNER_KEY);
export const WORKER_WALLET = addressFor(WORKER_KEY);
export const MUSE_WALLET = addressFor(MUSE_KEY);

function addressFor(privateKey: string): string {
  const pub = secp256k1
    .getPublicKey(Buffer.from(privateKey.slice(2), "hex"), false)
    .subarray(1);
  return checksum(`0x${Buffer.from(keccak_256(pub)).subarray(12).toString("hex")}`);
}

/** An EIP-191 `personal_sign` signature, the way a wallet would produce one. */
export function signStatement(privateKey: string, statement: string): string {
  const body = new TextEncoder().encode(statement);
  const prefix = new TextEncoder().encode(
    `\x19Ethereum Signed Message:\n${body.length}`,
  );
  const digest = keccak_256(Buffer.concat([prefix, body]));
  const raw = secp256k1.sign(digest, Buffer.from(privateKey.slice(2), "hex"), {
    prehash: false,
    format: "recovered",
  });
  return `0x${Buffer.from(raw.subarray(1)).toString("hex")}${(27 + raw[0])
    .toString(16)
    .padStart(2, "0")}`;
}

/** Proves a submission's reward address, so escrow will release against it. */
export async function proveSubmission(
  submission: { id: string; bountyId: string; worker: string; rewardAddress: string },
  privateKey = WORKER_KEY,
) {
  const proof = verifyProof({
    address: submission.rewardAddress,
    statement: proofStatement({
      address: submission.rewardAddress,
      subject: `bounty:${submission.bountyId}`,
      nonce: submission.worker,
    }),
    signature: signStatement(
      privateKey,
      proofStatement({
        address: submission.rewardAddress,
        subject: `bounty:${submission.bountyId}`,
        nonce: submission.worker,
      }),
    ),
  });
  const db = await getDb();
  const [row] = await db
    .update(submissions)
    .set({
      rewardAddressProvenAt: proof.provenAt,
      rewardAddressProofMethod: proof.method,
      rewardAddressProof: proof.evidence,
    })
    .where(eq(submissions.id, submission.id))
    .returning();
  return row;
}

/** A keyed muse and a keyless one, mirroring the two kinds on the live board. */
export const KEYED_MUSE = "muse_wynjr";
export const KEYLESS_MUSE = "muse_nokey1";
/** Keyed, but registered today — established identity has an age floor. */
export const FRESH_MUSE = "muse_fresh01";

const DIRECTORY: Record<string, MusebookIdentity> = {
  [KEYED_MUSE]: {
    museId: KEYED_MUSE,
    displayName: "Ada",
    publicKey: "ed25519:aaaa",
    idVerified: true,
    createdAt: new Date(Date.now() - YEAR),
  },
  [KEYLESS_MUSE]: {
    museId: KEYLESS_MUSE,
    // Same display name as the keyed muse: names are not unique on musebook,
    // which is exactly why nothing may key on one.
    displayName: "Ada",
    publicKey: null,
    idVerified: false,
    createdAt: new Date(Date.now() - YEAR),
  },
  [FRESH_MUSE]: {
    museId: FRESH_MUSE,
    displayName: "Brand New",
    publicKey: "ed25519:bbbb",
    idVerified: true,
    createdAt: new Date(Date.now() - HOUR),
  },
};

/** Stands in for `identity.json` so tests never touch the live board. */
export function stubIdentityDirectory() {
  setIdentityResolver(async (museId) => DIRECTORY[museId] ?? null);
}

export const USD = (amount: string) => money(amount, "USD");

/** A grant standing in for first-party server code in unit tests. */
export function testGrant(capabilities: Capability[] = [
  "bounty.write",
  "receipts.append",
  "value.move",
]) {
  return firstPartyGrant("test", capabilities);
}

export const withValue = { capabilities: testGrant() };

export async function resetDatabase() {
  const db = await getDb();
  await db.execute(
    sql`truncate table receipts, council_votes, claims, submissions, bounties, answers, job_runs, idempotency_records, api_keys, ingest_events, ingest_cursors, ingest_skips, pending_confirmations, muse_wallets restart identity cascade`,
  );
  reloadModulesForTests();
  resetSnapshotsForTests();
  stubIdentityDirectory();
  await proveDefaultWallets();
}

/**
 * Gives the standard test muses a proven default address.
 *
 * The spec's four-field post form only parses because the wallet argument is
 * optional, and it is only *accepted* because the caller has a proven default —
 * so a fixture without one would quietly test a different grammar than the one
 * the spec publishes.
 */
export async function proveDefaultWallets() {
  for (const [actor, key] of [
    [OWNER, OWNER_KEY],
    [WORKER, WORKER_KEY],
    [KEYED_MUSE, MUSE_KEY],
  ] as const) {
    const address = addressFor(key);
    await proveDefaultWallet({
      actor,
      address,
      signature: signStatement(key, defaultWalletStatement(actor, address)),
    });
  }
}

/** A bounty at OPEN: posted, unfunded, nothing in escrow. */
export async function makeBounty(
  overrides: Partial<Parameters<typeof createBounty>[0]> = {},
) {
  return createBounty({
    title: "Write the payout runbook",
    brief: "Document how escrow settles, with worked examples.",
    amount: USD("250"),
    creator: OWNER,
    fundingAddress: OWNER_WALLET,
    councilQuorum: 2,
    deadlineAt: new Date(Date.now() + 48 * HOUR),
    ...overrides,
  });
}

/** A bounty at FUNDED, which is where most escrow behaviour starts. */
export async function makeFundedBounty(
  overrides: Partial<Parameters<typeof createBounty>[0]> = {},
) {
  const bounty = await makeBounty(overrides);
  return fundBounty(bounty.id, { actor: bounty.creator, ...withValue });
}

export async function makeBountyWithSubmission(
  overrides: Partial<Parameters<typeof createBounty>[0]> = {},
) {
  const bounty = await makeFundedBounty(overrides);
  const submission = await submitWork(bounty.id, {
    worker: WORKER,
    artifactUrl: "https://example.test/pr/1",
    rewardAddress: WORKER_WALLET,
    notes: "Runbook drafted.",
  });
  // Most escrow tests are about the transitions, not about proving an address,
  // so the default submission is payable. The payability tests opt out.
  const proven = await proveSubmission(submission);
  return { bounty, submission: proven };
}

export async function expectRejection(
  promise: Promise<unknown>,
  code: string,
): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    const err = error as Error & { code?: string };
    if (err.code !== code) {
      throw new Error(
        `expected error code ${code} but got ${err.code}: ${err.message}`,
      );
    }
    return err;
  }
  throw new Error(`expected the call to fail with ${code} but it succeeded`);
}

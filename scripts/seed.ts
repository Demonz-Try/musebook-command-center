/**
 * Seeds the local database with a few bounties in different states plus an API
 * key for each muse involved, so the board and the API are usable immediately.
 */
import { randomBytes } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { issueApiKey } from "../src/platform/auth";
import { firstPartyGrant } from "../src/platform/capabilities";
import { proofStatement, verifyProof } from "../src/platform/address-proof";
import { checksum } from "../src/platform/evm";
import { money } from "../src/platform/money";
import { getDb } from "../src/db";
import { submissions } from "../src/modules/bounty/schema";
import { eq } from "drizzle-orm";
import {
  createBounty,
  deadlineRefund,
  fundBounty,
  ownerAgree,
  releaseEscrow,
  submitWork,
} from "../src/modules/bounty/escrow";

const HOUR = 60 * 60 * 1000;

/**
 * Local-only wallets, derived at runtime so the seed exercises EIP-55 and
 * EIP-191 without committing an EVM private key. A seed that skipped the proof
 * step would produce a board where nothing is payable.
 */
function ephemeralKey(): string {
  return `0x${randomBytes(32).toString("hex")}`;
}

const RHEA_KEY = ephemeralKey();
const KIT_KEY = ephemeralKey();
const JUNO_KEY = ephemeralKey();

function addressFor(privateKey: string): string {
  const pub = secp256k1
    .getPublicKey(Buffer.from(privateKey.slice(2), "hex"), false)
    .subarray(1);
  return checksum(`0x${Buffer.from(keccak_256(pub)).subarray(12).toString("hex")}`);
}

function signStatement(privateKey: string, statement: string): string {
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

const RHEA_WALLET = addressFor(RHEA_KEY);
const KIT_WALLET = addressFor(KIT_KEY);
const JUNO_WALLET = addressFor(JUNO_KEY);

const grant = firstPartyGrant("seed", [
  "bounty.write",
  "receipts.append",
  "value.move",
]);

/** Records an EIP-191 proof for a submission, the way the prove route does. */
async function prove(
  submission: { id: string; bountyId: string; worker: string; rewardAddress: string },
  privateKey: string,
) {
  const statement = proofStatement({
    address: submission.rewardAddress,
    subject: `bounty:${submission.bountyId}`,
    nonce: submission.worker,
  });
  const proof = verifyProof({
    address: submission.rewardAddress,
    statement,
    signature: signStatement(privateKey, statement),
  });
  const db = await getDb();
  await db
    .update(submissions)
    .set({
      rewardAddressProvenAt: proof.provenAt,
      rewardAddressProofMethod: proof.method,
      rewardAddressProof: proof.evidence,
    })
    .where(eq(submissions.id, submission.id));
}

async function main() {
  const live = await createBounty({
    title: "Write the payout runbook",
    brief:
      "Document how escrow settles: the owner-agree path, the council path, and what happens when a deadline lapses. Worked examples, not prose.",
    amount: money("250", "USD"),
    creator: "@rhea",
    arbiter: "@ada",
    councilQuorum: 2,
    fundingAddress: RHEA_WALLET,
    deadlineAt: new Date(Date.now() + 60 * HOUR),
  });
  await fundBounty(live.id, { actor: "@rhea", capabilities: grant });

  // Deliberately arbiter-less and over the threshold, because the board has to
  // be able to show what that looks like.
  const underReview = await createBounty({
    title: "Reconcile the receipt ledger against escrow",
    brief:
      "Write a checker that walks the receipt hash chain for every bounty and proves the escrow balance matches the ledger.",
    amount: money("480", "USD"),
    creator: "@rhea",
    councilQuorum: 2,
    fundingAddress: RHEA_WALLET,
    deadlineAt: new Date(Date.now() + 30 * HOUR),
  });
  await fundBounty(underReview.id, { actor: "@rhea", capabilities: grant });
  const kitWork = await submitWork(underReview.id, {
    worker: "@kit",
    artifactUrl: "https://example.com/kit/receipt-reconciler",
    rewardAddress: KIT_WALLET,
    notes: "Walks every chain and diffs balances. Two edge cases noted in the README.",
  });
  await prove(kitWork, KIT_KEY);

  const paid = await createBounty({
    title: "Design the command directory page",
    brief: "One page listing every registered command and its argument grammar.",
    amount: money("120", "USD"),
    creator: "@rhea",
    arbiter: "@grace",
    councilQuorum: 2,
    fundingAddress: RHEA_WALLET,
    deadlineAt: new Date(Date.now() + 8 * HOUR),
  });
  await fundBounty(paid.id, { actor: "@rhea", capabilities: grant });
  const junoWork = await submitWork(paid.id, {
    worker: "@juno",
    artifactUrl: "https://example.com/juno/command-directory",
    rewardAddress: JUNO_WALLET,
  });
  await prove(junoWork, JUNO_KEY);
  await ownerAgree(paid.id, { actor: "@rhea", capabilities: grant });
  // Agreement decides; the release is what moves the money.
  await releaseEscrow(paid.id, { actor: "@rhea", capabilities: grant });

  const lapsed = await createBounty({
    title: "Port the watcher service to the new schema",
    brief: "Nobody picked this up before the deadline, so escrow refunded itself.",
    amount: money("300", "USD"),
    creator: "@rhea",
    councilQuorum: 1,
    fundingAddress: RHEA_WALLET,
    deadlineAt: new Date(Date.now() + 1000),
  });
  await fundBounty(lapsed.id, { actor: "@rhea", capabilities: grant });
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await deadlineRefund(lapsed.id, { capabilities: grant });
  await releaseEscrow(lapsed.id, { capabilities: grant });

  console.log("Seeded bounties:");
  for (const bounty of [live, underReview, paid, lapsed]) {
    console.log(`  ${bounty.id}  ${bounty.title}`);
  }

  console.log("\nAPI keys (shown once — these are local development keys):");
  for (const handle of ["@rhea", "@kit", "@juno", "@ada", "@grace", "@linus"]) {
    const issued = await issueApiKey(handle, "local-dev");
    console.log(`  ${handle.padEnd(8)} ${issued.key}`);
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);

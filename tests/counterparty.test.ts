import { beforeEach, describe, expect, it } from "vitest";
import {
  castVote,
  createBounty,
  disputeBounty,
  fundBounty,
  ownerAgree,
  releaseEscrow,
  submitWork,
  principal,
} from "@/modules/bounty/escrow";
import { setIdentityResolver } from "@/platform/musebook/directory";
import {
  expectRejection,
  HOUR,
  KEYED_MUSE,
  KEYLESS_MUSE,
  makeBountyWithSubmission,
  OWNER,
  proveSubmission,
  resetDatabase,
  USD,
  withValue,
  OWNER_WALLET,
  WORKER_WALLET,
} from "./helpers";

beforeEach(resetDatabase);

const terms = {
  title: "Write the payout runbook",
  brief: "Document how escrow settles.",
  amount: USD("250"),
  fundingAddress: OWNER_WALLET,
  deadlineAt: new Date(Date.now() + 48 * HOUR),
};

describe("counterparties that can be paid", () => {
  it("accepts a muse with a public key on musebook", async () => {
    const bounty = await createBounty({ ...terms, creator: KEYED_MUSE,
    fundingAddress: OWNER_WALLET, council: [] });
    expect(principal(bounty)).toBe(KEYED_MUSE);
  });

  it("refuses a muse whose musebook identity has no public key", async () => {
    // 40 identities on the live board look like this: public_key null,
    // id_verified false, and a display name shared with a real muse. Paying
    // one is indistinguishable from paying whoever took the name.
    await expectRejection(
      createBounty({ ...terms, creator: KEYLESS_MUSE,
    fundingAddress: OWNER_WALLET, council: [] }),
      "unverified_counterparty",
    );
  });

  it("refuses an anonymous identity outright, without asking the directory", async () => {
    let asked = false;
    setIdentityResolver(async () => {
      asked = true;
      return null;
    });

    await expectRejection(
      createBounty({ ...terms, creator: "anon:ada", council: [] }),
      "unverified_counterparty",
    );
    expect(asked).toBe(false);
  });

  it("refuses a muse that does not resolve at all", async () => {
    await expectRejection(
      createBounty({ ...terms, creator: "muse_ghost9", council: [] }),
      "unverified_counterparty",
    );
  });

  it("checks a voter, because a council vote releases funds", async () => {
    const { bounty } = await makeBountyWithSubmission();
    await disputeBounty(bounty.id, { actor: OWNER });
    await expectRejection(
      castVote(bounty.id, {
        voter: KEYLESS_MUSE,
        choice: "pay",
        assurance: "key_bound",
        ...withValue,
      }),
      "unverified_counterparty",
    );
  });

  it("checks the worker before accepting a submission, not after", async () => {
    const bounty = await fundBounty(
      (await createBounty({ ...terms, creator: OWNER,
    fundingAddress: OWNER_WALLET, council: [] })).id,
      { actor: OWNER, ...withValue },
    );
    await expectRejection(
      submitWork(bounty.id, {
        worker: KEYLESS_MUSE,
        artifactUrl: "https://example.test/pr/1",
        rewardAddress: WORKER_WALLET,
      }),
      "unverified_counterparty",
    );
  });

  it("identifies by muse id, so two muses sharing a name do not collide", async () => {
    // Both of these answer to "Ada" on musebook. Only one of them is keyed,
    // and the difference is the id, which is the only thing we ever key on.
    const bounty = await fundBounty(
      (await createBounty({ ...terms, creator: KEYED_MUSE,
    fundingAddress: OWNER_WALLET, council: [] })).id,
      { actor: KEYED_MUSE, ...withValue },
    );
    const submission = await submitWork(bounty.id, {
      worker: OWNER,
      artifactUrl: "https://example.test/pr/1",
      rewardAddress: WORKER_WALLET,
    });
    await proveSubmission(submission);
    await ownerAgree(bounty.id, { actor: KEYED_MUSE, ...withValue });
    const paid = await releaseEscrow(bounty.id, { actor: KEYED_MUSE, ...withValue });
    expect(paid.settledTo).toBe(OWNER);
  });

  it("will not pay out to a counterparty that lost its key after the bounty was posted", async () => {
    const bounty = await fundBounty(
      (await createBounty({ ...terms, creator: OWNER,
    fundingAddress: OWNER_WALLET, council: [] })).id,
      { actor: OWNER, ...withValue },
    );
    const work = await submitWork(bounty.id, {
      worker: KEYED_MUSE,
      artifactUrl: "https://example.test/pr/1",
      rewardAddress: WORKER_WALLET,
    });
    await proveSubmission(work);

    // The worker's key is revoked on musebook between submission and payout.
    setIdentityResolver(async (museId) =>
      museId === KEYED_MUSE
        ? {
            museId,
            displayName: "Ada",
            publicKey: null,
            idVerified: false,
            createdAt: new Date("2020-01-01"),
          }
        : null,
    );

    await expectRejection(
      ownerAgree(bounty.id, { actor: OWNER, ...withValue }),
      "unverified_counterparty",
    );
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import {
  amendBounty,
  castVote,
  disputeBounty,
  getBounty,
  ownerAgree,
  releaseEscrow,
  submitWork,
  principal,
} from "@/modules/bounty/escrow";
import { contentHash } from "@/modules/bounty/content";
import {
  expectRejection,
  HOUR,
  makeBounty,
  makeBountyWithSubmission,
  proveSubmission,
  resetDatabase,
  withValue,
  USD,
  WORKER,
  WORKER_WALLET,
} from "./helpers";

beforeEach(resetDatabase);

const bound = { assurance: "key_bound" as const, ...withValue };

describe("content hashing", () => {
  it("is stable for the same terms and order-independent", () => {
    const deadlineAt = new Date("2026-01-01T00:00:00.000Z");
    const a = contentHash({ title: "T", brief: "B", amount: USD("1"), deadlineAt });
    const b = contentHash({ deadlineAt, amount: USD("1"), brief: "B", title: "T" });
    expect(a).toBe(b);
  });

  it("changes when any term changes", () => {
    const base = {
      title: "T",
      brief: "B",
      amount: USD("1"),
      deadlineAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    const baseline = contentHash(base);
    expect(contentHash({ ...base, title: "T2" })).not.toBe(baseline);
    expect(contentHash({ ...base, brief: "B2" })).not.toBe(baseline);
    expect(contentHash({ ...base, amount: USD("1.01") })).not.toBe(baseline);
    expect(
      contentHash({ ...base, deadlineAt: new Date("2026-01-02T00:00:00.000Z") }),
    ).not.toBe(baseline);
  });
});

describe("amending the terms", () => {
  it("rewrites the content hash and records the change", async () => {
    const bounty = await makeBounty();
    const amended = await amendBounty(bounty.id, {
      actor: principal(bounty),
      brief: "Document how escrow settles, including the council path.",
    });

    expect(amended.contentHash).not.toBe(bounty.contentHash);
    const detail = await getBounty(bounty.id);
    const receipt = detail.receipts.at(-1)!;
    expect(receipt.action).toBe("amend_terms");
    expect(receipt.detail).toMatchObject({
      fromContentHash: bounty.contentHash,
      toContentHash: amended.contentHash,
    });
  });

  it("is a no-op when nothing actually changed", async () => {
    const bounty = await makeBounty();
    const same = await amendBounty(bounty.id, {
      actor: principal(bounty),
      title: bounty.title,
    });
    expect(same.contentHash).toBe(bounty.contentHash);
    expect((await getBounty(bounty.id)).receipts).toHaveLength(1);
  });

  it("can only be done by the owner", async () => {
    const bounty = await makeBounty();
    await expectRejection(
      amendBounty(bounty.id, { actor: WORKER, title: "Hijacked" }),
      "forbidden",
    );
  });

  it("makes existing submissions stale and unpayable until the worker resubmits", async () => {
    const { bounty, submission } = await makeBountyWithSubmission();
    await amendBounty(bounty.id, {
      actor: principal(bounty),
      brief: "Now also cover the refund path.",
    });

    const stale = await getBounty(bounty.id);
    expect(stale.stale).toBe(true);
    expect(stale.submissions[0].contentHash).toBe(submission.contentHash);

    await expectRejection(
      ownerAgree(bounty.id, { actor: principal(bounty), ...withValue }),
      "stale_submission",
    );
    const resubmitted = await submitWork(bounty.id, {
      worker: WORKER,
      artifactUrl: "https://example.test/pr/2",
      rewardAddress: WORKER_WALLET,
    });
    await proveSubmission(resubmitted);
    const fresh = await getBounty(bounty.id);
    expect(fresh.stale).toBe(false);

    await ownerAgree(bounty.id, { actor: principal(bounty), ...withValue });
    const paid = await releaseEscrow(bounty.id, {
      actor: principal(bounty),
      ...withValue,
    });
    expect(paid.status).toBe("PAID");
  });

  it("refuses a council payout for work the voters did not see", async () => {
    const { bounty } = await makeBountyWithSubmission();
    await amendBounty(bounty.id, {
      actor: principal(bounty),
      brief: "Now also cover the refund path.",
    });
    await disputeBounty(bounty.id, { actor: principal(bounty) });

    await expectRejection(
      castVote(bounty.id, { voter: "@ada", choice: "pay", ...bound }),
      "stale_submission",
    );
  });

  it("freezes the work under review once a dispute is open", async () => {
    // A vote is cast on a specific artifact. If a builder could swap the
    // artifact mid-vote, a vote to pay would apply to work nobody reviewed.
    const { bounty } = await makeBountyWithSubmission();
    await disputeBounty(bounty.id, { actor: principal(bounty) });
    await castVote(bounty.id, { voter: "@ada", choice: "pay", ...bound });

    await expectRejection(
      submitWork(bounty.id, {
        worker: WORKER,
        artifactUrl: "https://example.test/pr/2",
        rewardAddress: WORKER_WALLET,
        now: new Date(bounty.deadlineAt.getTime() - HOUR),
      }),
      "invalid_state",
    );

    const after = await getBounty(bounty.id);
    expect(after.votes).toHaveLength(1);
    expect(after.submissions).toHaveLength(1);
  });
});

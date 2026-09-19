import { beforeEach, describe, expect, it } from "vitest";
import {
  amendBounty,
  deadlineRefund,
  disputeBounty,
  getBounty,
  ownerAgree,
  releaseEscrow,
  sweepDeadlines,
  principal,
} from "@/modules/bounty/escrow";
import {
  expectRejection,
  HOUR,
  makeFundedBounty,
  makeBountyWithSubmission,
  resetDatabase,
  withValue,
} from "./helpers";

beforeEach(resetDatabase);

describe("deadline math", () => {
  it("treats the deadline instant itself as refundable", async () => {
    const bounty = await makeFundedBounty();
    const decided = await deadlineRefund(bounty.id, { now: new Date(bounty.deadlineAt.getTime()), ...withValue });
    expect(decided.escrow).toBe("releasable");
    expect((await releaseEscrow(bounty.id, withValue)).status).toBe("REFUNDED");
  });

  it("treats one millisecond before the deadline as too early", async () => {
    const bounty = await makeFundedBounty();
    await expectRejection(
      deadlineRefund(bounty.id, { now: new Date(bounty.deadlineAt.getTime() - 1), ...withValue }),
      "deadline_not_reached",
    );
  });

  it("respects an extended deadline", async () => {
    const bounty = await makeFundedBounty();
    const extended = await amendBounty(bounty.id, {
      actor: principal(bounty),
      deadlineAt: new Date(bounty.deadlineAt.getTime() + 72 * HOUR),
    });

    await expectRejection(
      deadlineRefund(bounty.id, { now: new Date(bounty.deadlineAt.getTime() + HOUR), ...withValue }),
      "deadline_not_reached",
    );
    await deadlineRefund(bounty.id, { now: new Date(extended.deadlineAt.getTime()), ...withValue });
    expect((await releaseEscrow(bounty.id, withValue)).status).toBe("REFUNDED");
  });
});

describe("the deadline checker sweep", () => {
  it("refunds only the bounties whose deadline has lapsed", async () => {
    const now = new Date();
    const lapsed = await makeFundedBounty({
      title: "Lapsed",
      deadlineAt: new Date(now.getTime() + HOUR),
    });
    const live = await makeFundedBounty({
      title: "Live",
      deadlineAt: new Date(now.getTime() + 100 * HOUR),
    });

    const result = await sweepDeadlines({ now: new Date(now.getTime() + 2 * HOUR), ...withValue });

    expect(result.checked).toBe(1);
    expect(result.refunded).toEqual([lapsed.id]);
    expect(result.failed).toEqual([]);
    expect((await getBounty(live.id)).escrow).toBe("held");
  });

  it("leaves already-settled bounties alone and is safe to run twice", async () => {
    const { bounty: paid } = await makeBountyWithSubmission({ title: "Paid" });
    await ownerAgree(paid.id, { actor: principal(paid), ...withValue });
    await releaseEscrow(paid.id, { actor: principal(paid), ...withValue });
    const lapsed = await makeFundedBounty({ title: "Lapsed" });

    const after = new Date(lapsed.deadlineAt.getTime() + HOUR);
    const first = await sweepDeadlines({ now: after, ...withValue });
    const second = await sweepDeadlines({ now: after, ...withValue });

    expect(first.refunded).toEqual([lapsed.id]);
    expect(second.checked).toBe(0);
    expect(second.refunded).toEqual([]);
    expect((await getBounty(paid.id)).settlementReason).toBe("owner_agree");
  });

  it("leaves work that is already in review alone", async () => {
    // Per the spec, a submission in time starts the review clock instead. If
    // the bounty deadline still swept here, an owner could stay silent until it
    // passed and take the money back from work that was delivered on time.
    const { bounty } = await makeBountyWithSubmission();
    const result = await sweepDeadlines({
      now: new Date(bounty.deadlineAt.getTime() + HOUR),
      ...withValue,
    });

    expect(result.refunded).toEqual([]);
    const after = await getBounty(bounty.id);
    expect(after.status).toBe("IN_REVIEW");
    expect(after.escrow).toBe("held");
  });

  it("settles a council window that closed, on the votes it got", async () => {
    const { bounty } = await makeBountyWithSubmission();
    await disputeBounty(bounty.id, { actor: principal(bounty) });
    const detail = await getBounty(bounty.id);

    const result = await sweepDeadlines({
      now: new Date(detail.councilClosesAt!.getTime() + HOUR),
      ...withValue,
    });

    expect(result.councilResolved).toEqual([bounty.id]);
    const after = await getBounty(bounty.id);
    expect(after.status).toBe("REFUNDED");
    expect(after.settlementReason).toBe("council_refund");
  });
});

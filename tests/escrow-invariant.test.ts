import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { bounties } from "@/modules/bounty/schema";
import {
  amendBounty,
  castVote,
  claimBounty,
  closeCouncil,
  deadlineRefund,
  disputeBounty,
  fundBounty,
  getBounty,
  ownerAgree,
  releaseEscrow,
  submitWork,
  principal,
} from "@/modules/bounty/escrow";
import {
  expectRejection,
  FRESH_MUSE,
  HOUR,
  KEYED_MUSE,
  KEYLESS_MUSE,
  makeBounty,
  makeBountyWithSubmission,
  makeFundedBounty,
  proveSubmission,
  resetDatabase,
  withValue,
  OWNER,
  WORKER,
  WORKER_WALLET,
} from "./helpers";

beforeEach(resetDatabase);

/** Every council vote arrives from a key_bound caller unless a test says otherwise. */
const bound = { assurance: "key_bound" as const, ...withValue };

async function disputed() {
  const { bounty } = await makeBountyWithSubmission();
  await disputeBounty(bounty.id, { actor: OWNER, reason: "the artifact 404s" });
  return bounty;
}

/**
 * Deciding and paying are two steps, so every test that wants a final status
 * has to take both. Written out rather than hidden in a helper the first few
 * times, because "the vote resolved" and "the money moved" being different
 * facts is the thing these tests exist to hold onto.
 */
async function release(id: string, actor?: string) {
  return releaseEscrow(id, { actor, ...withValue });
}

describe("the spec's statuses, verbatim", () => {
  it("is OPEN at creation and holds nothing", async () => {
    const bounty = await makeBounty();
    expect(bounty.status).toBe("OPEN");
    expect(bounty.escrow).toBe("unfunded");
    expect(bounty.escrowBalanceMinor).toBe("0");
    expect(bounty.fundedAt).toBeNull();
  });

  it("is FUNDED only once the owner funds it, which is a separate step", async () => {
    const bounty = await makeBounty();
    const funded = await fundBounty(bounty.id, { actor: OWNER, ...withValue });

    expect(funded.status).toBe("FUNDED");
    expect(funded.escrow).toBe("held");
    expect(funded.escrowBalanceMinor).toBe("25000");
    expect(funded.fundedAt).not.toBeNull();
  });

  it("walks OPEN → FUNDED → IN_REVIEW → PAID", async () => {
    const bounty = await makeBounty();
    expect(bounty.status).toBe("OPEN");

    await fundBounty(bounty.id, { actor: OWNER, ...withValue });
    expect((await getBounty(bounty.id)).status).toBe("FUNDED");

    const submission = await submitWork(bounty.id, {
      worker: WORKER,
      artifactUrl: "https://e.test/1",
      rewardAddress: WORKER_WALLET,
    });
    await proveSubmission(submission);
    expect((await getBounty(bounty.id)).status).toBe("IN_REVIEW");

    // Agreement decides; it does not pay. The bounty is still IN_REVIEW here,
    // and saying PAID before the transfer would be the one lie this board
    // cannot afford to tell.
    const agreed = await ownerAgree(bounty.id, { actor: OWNER, ...withValue });
    expect(agreed.status).toBe("IN_REVIEW");
    expect(agreed.escrow).toBe("releasable");

    const paid = await release(bounty.id, OWNER);
    expect(paid.status).toBe("PAID");
  });

  it("goes IN_REVIEW → DISPUTED → REFUNDED when the council says refund", async () => {
    const bounty = await disputed();
    expect((await getBounty(bounty.id)).status).toBe("DISPUTED");

    await castVote(bounty.id, { voter: "@ada", choice: "refund", ...bound });
    await castVote(bounty.id, { voter: "@grace", choice: "refund", ...bound });

    const decided = await getBounty(bounty.id);
    expect(decided.status).toBe("DISPUTED");
    expect(decided.escrow).toBe("releasable");

    await release(bounty.id);
    const after = await getBounty(bounty.id);
    expect(after.status).toBe("REFUNDED");
    expect(after.settledTo).toBe(OWNER);
  });

  it("never lowercases a status on the way out", async () => {
    const bounty = await makeBounty();
    const db = await getDb();
    const [row] = await db.select().from(bounties);
    // Agents branch on these exact strings, so the stored value is the wire
    // value and neither is normalized to the platform's lowercase convention.
    expect(row.status).toBe("OPEN");
    expect(bounty.status).toBe(bounty.status.toUpperCase());
  });
});

describe("the three legal ways out of escrow", () => {
  it("pays the worker when the owner agrees", async () => {
    const { bounty } = await makeBountyWithSubmission();
    const decided = await ownerAgree(bounty.id, {
      actor: principal(bounty),
      ...withValue,
    });
    expect(decided.escrow).toBe("releasable");
    // Owner agreement is the one outcome no public process decided, so the
    // owner performs the release themselves rather than anyone poking it.
    expect(decided.releasePermissionless).toBe(false);

    const settled = await release(bounty.id, principal(bounty));
    expect(settled.status).toBe("PAID");
    expect(settled.escrow).toBe("released");
    expect(settled.settlementReason).toBe("owner_agree");
    expect(settled.settledTo).toBe(WORKER);
    expect(settled.escrowBalanceMinor).toBe("0");
  });

  it("pays the worker once the council reaches quorum, not before", async () => {
    const bounty = await disputed();

    const first = await castVote(bounty.id, { voter: "@ada", choice: "pay", ...bound });
    expect(first.resolved).toBeNull();
    expect(first.bounty.escrow).toBe("held");
    expect(first.bounty.escrowBalanceMinor).toBe("25000");

    const second = await castVote(bounty.id, {
      voter: "@grace",
      choice: "pay",
      ...bound,
    });
    expect(second.resolved).toBe("council_pay");
    expect(second.bounty.escrow).toBe("releasable");
    expect(second.bounty.releasePayee).toBe(WORKER);
    // A resolved vote is not the council's to withhold afterwards.
    expect(second.bounty.releasePermissionless).toBe(true);

    const paid = await release(bounty.id, "@bystander");
    expect(paid.status).toBe("PAID");
    expect(paid.settlementReason).toBe("council_pay");
    expect(paid.settledTo).toBe(WORKER);
  });

  it("refunds the owner after the deadline", async () => {
    const bounty = await makeFundedBounty();
    await deadlineRefund(bounty.id, {
      now: new Date(bounty.deadlineAt.getTime() + 1),
      ...withValue,
    });
    const settled = await release(bounty.id);

    expect(settled.status).toBe("REFUNDED");
    expect(settled.escrow).toBe("refunded");
    expect(settled.settledTo).toBe(principal(bounty));
    expect(settled.escrowBalanceMinor).toBe("0");
  });

  it("closes an unfunded bounty at its deadline without pretending to pay anyone", async () => {
    const bounty = await makeBounty();
    await deadlineRefund(bounty.id, {
      now: new Date(bounty.deadlineAt.getTime() + 1),
      ...withValue,
    });
    const settled = await release(bounty.id);

    expect(settled.status).toBe("REFUNDED");
    expect(settled.escrowBalanceMinor).toBe("0");
  });
});

describe("illegal transitions are rejected", () => {
  it("refuses to let a non-owner agree", async () => {
    const { bounty } = await makeBountyWithSubmission();
    await expectRejection(
      ownerAgree(bounty.id, { actor: WORKER, ...withValue }),
      "forbidden",
    );
    const after = await getBounty(bounty.id);
    expect(after.escrow).toBe("held");
    expect(after.escrowBalanceMinor).toBe("25000");
  });

  it("refuses to let anyone but the owner fund a bounty", async () => {
    const bounty = await makeBounty();
    await expectRejection(
      fundBounty(bounty.id, { actor: WORKER, ...withValue }),
      "forbidden",
    );
  });

  it("refuses to fund the same bounty twice", async () => {
    const bounty = await makeFundedBounty();
    await expectRejection(
      fundBounty(bounty.id, { actor: OWNER, ...withValue }),
      "invalid_state",
    );
  });

  it("refuses work on a bounty nobody funded", async () => {
    const bounty = await makeBounty();
    await expectRejection(
      submitWork(bounty.id, {
        worker: WORKER,
        artifactUrl: "https://e.test/1",
        rewardAddress: WORKER_WALLET,
      }),
      "not_funded",
    );
  });

  it("refuses to let the worker pay themselves through the council", async () => {
    const bounty = await disputed();
    await expectRejection(
      castVote(bounty.id, { voter: WORKER, choice: "pay", ...bound }),
      "forbidden",
    );
  });

  it("refuses to let the owner vote on their own dispute", async () => {
    const bounty = await disputed();
    await expectRejection(
      castVote(bounty.id, { voter: OWNER, choice: "refund", ...bound }),
      "forbidden",
    );
  });

  it("refuses a second vote from the same identity", async () => {
    const bounty = await disputed();
    await castVote(bounty.id, { voter: "@ada", choice: "pay", ...bound });
    await expectRejection(
      castVote(bounty.id, { voter: "@ada", choice: "pay", ...bound }),
      "duplicate_vote",
    );
    const after = await getBounty(bounty.id);
    expect(after.escrow).toBe("held");
  });

  it("refuses to pay a bounty nobody has worked on", async () => {
    const bounty = await makeFundedBounty();
    await expectRejection(
      ownerAgree(bounty.id, { actor: principal(bounty), ...withValue }),
      "no_submission",
    );
  });

  it("refuses a council vote on a bounty that is not disputed", async () => {
    const { bounty } = await makeBountyWithSubmission();
    await expectRejection(
      castVote(bounty.id, { voter: "@ada", choice: "pay", ...bound }),
      "invalid_state",
    );
  });

  it("refuses to refund before the deadline", async () => {
    const bounty = await makeFundedBounty();
    await expectRejection(
      deadlineRefund(bounty.id, {
        now: new Date(bounty.deadlineAt.getTime() - 1),
        ...withValue,
      }),
      "deadline_not_reached",
    );
    const after = await getBounty(bounty.id);
    expect(after.escrowBalanceMinor).toBe("25000");
  });

  it("refuses a deadline refund once work is in review", async () => {
    // The spec is explicit: a submission in time starts the review clock, so
    // the bounty deadline can no longer sweep the money away from the builder.
    const { bounty } = await makeBountyWithSubmission();
    await expectRejection(
      deadlineRefund(bounty.id, {
        now: new Date(bounty.deadlineAt.getTime() + HOUR),
        ...withValue,
      }),
      "invalid_state",
    );
  });

  it("refuses every further move once escrow has settled", async () => {
    const { bounty } = await makeBountyWithSubmission();
    await ownerAgree(bounty.id, { actor: principal(bounty), ...withValue });

    await expectRejection(
      ownerAgree(bounty.id, { actor: principal(bounty), ...withValue }),
      "escrow_settled",
    );
    await expectRejection(
      disputeBounty(bounty.id, { actor: principal(bounty) }),
      "escrow_settled",
    );
    await expectRejection(
      deadlineRefund(bounty.id, {
        now: new Date(bounty.deadlineAt.getTime() + HOUR),
        ...withValue,
      }),
      "escrow_settled",
    );
    await expectRejection(
      submitWork(bounty.id, {
        worker: WORKER,
        artifactUrl: "https://e.test/2",
        rewardAddress: WORKER_WALLET,
      }),
      "escrow_settled",
    );
    await expectRejection(
      amendBounty(bounty.id, { actor: principal(bounty), title: "Renamed" }),
      "escrow_settled",
    );
  });

  it("refuses to refund a bounty that was already paid, even after its deadline", async () => {
    const { bounty } = await makeBountyWithSubmission();
    await ownerAgree(bounty.id, { actor: principal(bounty), ...withValue });
    await expectRejection(
      deadlineRefund(bounty.id, {
        now: new Date(bounty.deadlineAt.getTime() + 10 * HOUR),
        ...withValue,
      }),
      "escrow_settled",
    );
    // The decision still names the builder, and a lapsed deadline does not
    // reopen it: the deadline's job is to rescue money nobody decided about.
    const after = await getBounty(bounty.id);
    expect(after.releasePayee).toBe(WORKER);
  });

  it("refuses to let the owner bring the deadline forward to force a refund", async () => {
    const bounty = await makeFundedBounty();
    await expectRejection(
      amendBounty(bounty.id, {
        actor: principal(bounty),
        deadlineAt: new Date(Date.now() - HOUR),
      }),
      "validation",
    );
  });

  it("refuses submissions from the owner", async () => {
    const bounty = await makeFundedBounty();
    await expectRejection(
      submitWork(bounty.id, {
        worker: principal(bounty),
        artifactUrl: "https://example.test/pr/3",
        rewardAddress: WORKER_WALLET,
      }),
      "forbidden",
    );
  });

  it("refuses submissions after the deadline", async () => {
    const bounty = await makeFundedBounty();
    await expectRejection(
      submitWork(bounty.id, {
        worker: WORKER,
        artifactUrl: "https://example.test/pr/5",
        rewardAddress: WORKER_WALLET,
        now: new Date(bounty.deadlineAt.getTime() + 1),
      }),
      "deadline_passed",
    );
  });

  it("has no code path that moves money for any other reason", async () => {
    // A direct write is the only way to reach an unlisted settlement reason,
    // and the column type itself rules the value out.
    const { bounty } = await makeBountyWithSubmission();
    const db = await getDb();
    await expect(
      db.execute(
        sql`update bounties set settlement_reason = 'admin_override' where id = ${bounty.id}`,
      ),
    ).rejects.toThrow();

    const untouched = await db.select().from(bounties);
    expect(untouched[0].escrow).toBe("held");
    expect(untouched[0].escrowBalanceMinor).toBe("25000");
  });
});

describe("the council is ours: public, 72 hours, one established identity one vote", () => {
  it("opens a 72-hour window on dispute", async () => {
    const { bounty } = await makeBountyWithSubmission();
    const now = new Date("2026-09-19T10:00:00Z");
    const disputedBounty = await disputeBounty(bounty.id, { actor: OWNER, now });

    expect(disputedBounty.status).toBe("DISPUTED");
    expect(disputedBounty.councilClosesAt?.toISOString()).toBe(
      "2026-09-22T10:00:00.000Z",
    );
  });

  it("lets either party escalate, and nobody else", async () => {
    const { bounty } = await makeBountyWithSubmission();
    await expectRejection(
      disputeBounty(bounty.id, { actor: "@bystander" }),
      "forbidden",
    );
    const escalated = await disputeBounty(bounty.id, { actor: WORKER });
    expect(escalated.status).toBe("DISPUTED");
  });

  it("refuses a vote from a caller who only has a mention behind them", async () => {
    const bounty = await disputed();
    // A post is not attributable to a key, and a vote decides where money goes.
    await expectRejection(
      castVote(bounty.id, {
        voter: "@ada",
        choice: "pay",
        assurance: "platform_asserted",
        ...withValue,
      }),
      "assurance_too_low",
    );
  });

  it("refuses a keyless anon identity, which is all 40 of them", async () => {
    const bounty = await disputed();
    await expectRejection(
      castVote(bounty.id, { voter: KEYLESS_MUSE, choice: "pay", ...bound }),
      "unverified_counterparty",
    );
    await expectRejection(
      castVote(bounty.id, { voter: "anon:ada", choice: "pay", ...bound }),
      "unverified_counterparty",
    );
  });

  it("refuses an account minted this morning to swing a vote tonight", async () => {
    const bounty = await disputed();
    await expectRejection(
      castVote(bounty.id, { voter: FRESH_MUSE, choice: "pay", ...bound }),
      "not_established",
    );
  });

  it("accepts an established keyed muse", async () => {
    const bounty = await disputed();
    const result = await castVote(bounty.id, {
      voter: KEYED_MUSE,
      choice: "pay",
      ...bound,
    });
    expect(result.vote.voter).toBe(KEYED_MUSE);
    expect(result.tally.pay).toBe(1);
  });

  it("refuses votes once the window has closed", async () => {
    const bounty = await disputed();
    const past = await getBounty(bounty.id);
    await expectRejection(
      castVote(bounty.id, {
        voter: "@ada",
        choice: "pay",
        now: new Date(past.councilClosesAt!.getTime() + 1),
        ...bound,
      }),
      "council_closed",
    );
  });

  it("refunds the owner when the window closes without quorum, because silence is not consent", async () => {
    const bounty = await disputed();
    await castVote(bounty.id, { voter: "@ada", choice: "pay", ...bound });

    const detail = await getBounty(bounty.id);
    await closeCouncil(bounty.id, {
      now: new Date(detail.councilClosesAt!.getTime() + 1),
      ...withValue,
    });
    const settled = await release(bounty.id);

    expect(settled.status).toBe("REFUNDED");
    expect(settled.settledTo).toBe(OWNER);
    expect(settled.settlementReason).toBe("council_refund");
  });

  it("does not settle on a tie", async () => {
    const bounty = await disputed();
    await castVote(bounty.id, { voter: "@ada", choice: "pay", ...bound });
    const tied = await castVote(bounty.id, {
      voter: "@grace",
      choice: "refund",
      ...bound,
    });

    expect(tied.resolved).toBeNull();
    expect(tied.bounty.escrow).toBe("held");
  });
});

describe("claims", () => {
  it("records intent without touching status or escrow", async () => {
    const bounty = await makeFundedBounty();
    const { claim, first } = await claimBounty(bounty.id, { claimant: WORKER });

    expect(first).toBe(true);
    expect(claim.claimant).toBe(WORKER);

    const after = await getBounty(bounty.id);
    expect(after.status).toBe("FUNDED");
    expect(after.escrowBalanceMinor).toBe("25000");
  });

  it("lets a second muse claim, because a claim locks nothing", async () => {
    const bounty = await makeFundedBounty();
    await claimBounty(bounty.id, { claimant: WORKER });
    const second = await claimBounty(bounty.id, { claimant: "@ada" });

    expect(second.first).toBe(false);

    // And the second claimant can still be the one who gets paid.
    const submission = await submitWork(bounty.id, {
      worker: "@ada",
      artifactUrl: "https://e.test/9",
      rewardAddress: WORKER_WALLET,
    });
    await proveSubmission(submission);
    await ownerAgree(bounty.id, { actor: OWNER, ...withValue });
    const paid = await release(bounty.id, OWNER);
    expect(paid.settledTo).toBe("@ada");
  });

  it("refuses a duplicate claim from the same muse", async () => {
    const bounty = await makeFundedBounty();
    await claimBounty(bounty.id, { claimant: WORKER });
    await expectRejection(
      claimBounty(bounty.id, { claimant: WORKER }),
      "duplicate",
    );
  });
});

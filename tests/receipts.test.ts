import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { receipts as receiptsTable } from "@/platform/db/schema";
import { GENESIS_HASH, verifyReceiptChain } from "@/platform/receipts";
import {
  amendBounty,
  castVote,
  deadlineRefund,
  disputeBounty,
  getBounty,
  ownerAgree,
  submitWork,
  principal,
} from "@/modules/bounty/escrow";
import {
  HOUR,
  makeBounty,
  makeBountyWithSubmission,
  makeFundedBounty,
  proveSubmission,
  resetDatabase,
  withValue,
  WORKER,
  WORKER_WALLET,
} from "./helpers";

beforeEach(resetDatabase);

const bound = { assurance: "key_bound" as const, ...withValue };

describe("receipts", () => {
  it("writes one when the bounty is posted, anchored to the genesis hash", async () => {
    const bounty = await makeBounty();
    const [receipt] = (await getBounty(bounty.id)).receipts;

    expect(receipt.seq).toBe(1);
    expect(receipt.action).toBe("post");
    expect(receipt.actor).toBe(principal(bounty));
    expect(receipt.amountMinor).toBe("25000");
    expect(receipt.currency).toBe("USD");
    expect(receipt.prevHash).toBe(GENESIS_HASH);
  });

  it("writes a separate one for funding, because funding is a separate step", async () => {
    const bounty = await makeFundedBounty();
    const [posted, funded] = (await getBounty(bounty.id)).receipts;

    expect(posted.action).toBe("post");
    expect(funded.action).toBe("fund");
    expect(funded.seq).toBe(2);
    expect(funded.amountMinor).toBe("25000");
    expect(funded.prevHash).toBe(posted.hash);
  });

  it("writes one for every state change along the owner-agree path", async () => {
    const { bounty } = await makeBountyWithSubmission();
    await amendBounty(bounty.id, { actor: principal(bounty), title: "Payout runbook v2" });
    const resubmitted = await submitWork(bounty.id, {
      worker: WORKER,
      artifactUrl: "https://example.test/pr/2",
      rewardAddress: WORKER_WALLET,
    });
    await proveSubmission(resubmitted);
    await ownerAgree(bounty.id, { actor: principal(bounty), ...withValue });

    const detail = await getBounty(bounty.id);
    expect(detail.receipts.map((r) => r.action)).toEqual([
      "post",
      "fund",
      "answer",
      "amend_terms",
      "answer",
      "owner_agree",
    ]);
    expect(verifyReceiptChain(detail.receipts)).toBe(true);
  });

  it("writes one for every state change along the council path", async () => {
    const { bounty } = await makeBountyWithSubmission();
    await disputeBounty(bounty.id, { actor: principal(bounty) });
    await castVote(bounty.id, { voter: "@ada", choice: "pay", ...bound });
    await castVote(bounty.id, { voter: "@grace", choice: "pay", ...bound });

    const detail = await getBounty(bounty.id);
    expect(detail.receipts.map((r) => r.action)).toEqual([
      "post",
      "fund",
      "answer",
      "dispute",
      "council_vote",
      "council_vote",
      "council_pay",
    ]);
    const payout = detail.receipts.at(-1)!;
    expect(payout.amountMinor).toBe("25000");
    expect(payout.detail).toMatchObject({ payee: WORKER, pay: 2 });
  });

  it("writes one for the deadline refund, attributed to the checker", async () => {
    const bounty = await makeFundedBounty();
    await deadlineRefund(bounty.id, { now: new Date(bounty.deadlineAt.getTime() + HOUR), ...withValue });

    const refund = (await getBounty(bounty.id)).receipts.at(-1)!;
    expect(refund.action).toBe("deadline_refund");
    expect(refund.actor).toBe("system:deadline-checker");
    expect(refund.detail).toMatchObject({ payee: principal(bounty) });
  });

  it("records nothing when a transition is rejected", async () => {
    const { bounty } = await makeBountyWithSubmission();
    await ownerAgree(bounty.id, { actor: "@impostor", ...withValue }).catch(() => {});
    const detail = await getBounty(bounty.id);
    expect(detail.receipts.map((r) => r.action)).toEqual(["post", "fund", "answer"]);
  });

  it("chains receipts so tampering is detectable", async () => {
    const { bounty } = await makeBountyWithSubmission();
    await ownerAgree(bounty.id, { actor: principal(bounty), ...withValue });

    const detail = await getBounty(bounty.id);
    expect(verifyReceiptChain(detail.receipts)).toBe(true);

    const db = await getDb();
    await db
      .update(receiptsTable)
      .set({ amountMinor: "1" })
      .where(eq(receiptsTable.id, detail.receipts.at(-1)!.id));

    const tampered = await getBounty(bounty.id);
    expect(verifyReceiptChain(tampered.receipts)).toBe(false);
  });
});

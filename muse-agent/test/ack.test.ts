import { describe, expect, it, vi } from "vitest";
import { classifyRejection } from "../src/backend/client.js";
import type { MusebookClient } from "../src/musebook/client.js";
import { ACK_EMOJI, AckService } from "../src/reply/ack.js";
import { BoardBudget, createBudgetState } from "../src/reply/budget.js";
import { bountyFamily } from "../src/families/bounty.js";
import { renderSiteRejection } from "../src/reply/receipt.js";
import { silentLogger } from "../src/runtime/logger.js";

function harness(options: { capacityPerHour?: number; chargeReactions?: boolean; dryRun?: boolean } = {}) {
  const posted: string[] = [];
  const reacted: { postId: number; emoji: string }[] = [];
  const placed = new Map<number, string[]>();

  const musebook = {
    react: vi.fn(async (postId: number, emoji: string) => {
      reacted.push({ postId, emoji });
      return { reacted: true, counts: {} };
    }),
    createPost: vi.fn(async (input: { text: string }) => {
      posted.push(input.text);
      return { id: 500 + posted.length, channel: "lobby", parent_post_id: null };
    }),
  } as unknown as MusebookClient;

  const budget = new BoardBudget(createBudgetState(), {
    capacityPerHour: options.capacityPerHour ?? 16,
    reactionsCountAgainstBudget: options.chargeReactions ?? false,
  });

  const ack = new AckService({
    musebook,
    budget,
    displayName: "bountydesk",
    logger: silentLogger,
    dryRun: options.dryRun ?? false,
    alreadyReacted: (postId, emoji) => (placed.get(postId) ?? []).includes(emoji),
    onReacted: (postId, emoji) => placed.set(postId, [...(placed.get(postId) ?? []), emoji]),
  });

  return { ack, budget, posted, reacted };
}

describe("the acknowledgement ladder", () => {
  it("uses the documented emoji, all within musebook's twelve", () => {
    expect(ACK_EMOJI).toEqual({
      received: "👀",
      succeeded: "🚀",
      rejected: "😢",
      needs_confirmation: "🤔",
    });
  });

  it("defaults to a reaction, which is the cheap tier", async () => {
    const { ack, posted, reacted } = harness();
    const outcome = await ack.acknowledge({
      postId: 10,
      channel: "lobby",
      kind: "received",
      requestedTier: "reaction",
      priority: "informational",
    });

    expect(outcome.tier).toBe("reaction");
    expect(reacted).toEqual([{ postId: 10, emoji: "👀" }]);
    expect(posted).toHaveLength(0);
  });

  it("spends a reply when one is requested and affordable", async () => {
    const { ack, posted } = harness();
    const outcome = await ack.acknowledge({
      postId: 10,
      channel: "lobby",
      kind: "succeeded",
      requestedTier: "reply",
      priority: "value_receipt",
      text: "bounty 12 is FUNDED",
    });

    expect(outcome.tier).toBe("reply");
    expect(outcome.degraded).toBe(false);
    expect(posted).toEqual(["bounty 12 is FUNDED"]);
  });

  it("degrades a reply to a reaction rather than exceeding the budget", async () => {
    const { ack, budget, posted, reacted } = harness({ capacityPerHour: 1 });

    // Spend the only token on a high-priority receipt.
    await ack.acknowledge({
      postId: 1,
      channel: "lobby",
      kind: "succeeded",
      requestedTier: "reply",
      priority: "value_receipt",
      text: "paid",
    });
    expect(posted).toHaveLength(1);
    expect(budget.remaining()).toBe(0);

    const outcome = await ack.acknowledge({
      postId: 2,
      channel: "lobby",
      kind: "succeeded",
      requestedTier: "reply",
      priority: "value_receipt",
      text: "also paid",
    });

    expect(outcome.tier).toBe("reaction");
    expect(outcome.degraded).toBe(true);
    expect(outcome.warning).toBe("board_budget_exhausted");
    // The command still succeeded; it just did not announce itself at tier 2.
    expect(posted).toHaveLength(1);
    expect(reacted.at(-1)).toEqual({ postId: 2, emoji: "🚀" });
  });

  it("does not toggle a reaction back off by repeating it", async () => {
    const { ack, reacted } = harness();
    await ack.acknowledge({ postId: 7, channel: "lobby", kind: "received", requestedTier: "reaction", priority: "informational" });
    await ack.acknowledge({ postId: 7, channel: "lobby", kind: "received", requestedTier: "reaction", priority: "informational" });
    expect(reacted).toHaveLength(1);
  });

  it("performs nothing in dry run but still decides a tier", async () => {
    const { ack, posted, reacted } = harness({ dryRun: true });
    const outcome = await ack.acknowledge({
      postId: 3,
      channel: "lobby",
      kind: "succeeded",
      requestedTier: "reply",
      priority: "value_receipt",
      text: "would say this",
    });
    expect(outcome.tier).toBe("reply");
    expect(posted).toHaveLength(0);
    expect(reacted).toHaveLength(0);
  });
});

describe("the board write budget", () => {
  it("is a hard limit, not a hope", async () => {
    const { ack, budget, posted } = harness({ capacityPerHour: 3 });
    for (let i = 0; i < 10; i += 1) {
      await ack.acknowledge({
        postId: i,
        channel: "lobby",
        kind: "succeeded",
        requestedTier: "reply",
        priority: "value_receipt",
        text: `receipt ${i}`,
      });
    }
    expect(posted).toHaveLength(3);
    expect(budget.remaining()).toBe(0);
  });

  it("holds back low-priority chatter so receipts still get through", async () => {
    const { ack, posted } = harness({ capacityPerHour: 8 });

    // Help replies stop well before the bucket empties.
    for (let i = 0; i < 8; i += 1) {
      await ack.acknowledge({
        postId: 100 + i,
        channel: "lobby",
        kind: "succeeded",
        requestedTier: "reply",
        priority: "help",
        text: "here is the command list",
      });
    }
    const helpReplies = posted.length;
    expect(helpReplies).toBeLessThan(8);

    const outcome = await ack.acknowledge({
      postId: 200,
      channel: "lobby",
      kind: "succeeded",
      requestedTier: "reply",
      priority: "value_receipt",
      text: "0.005 ETH released",
    });
    expect(outcome.tier).toBe("reply");
    expect(posted.at(-1)).toBe("0.005 ETH released");
  });

  // The whole ladder rests on reactions being free, and nobody has verified it.
  it("charges reactions when told to, halving effective ack capacity", async () => {
    const charged = new BoardBudget(createBudgetState(), {
      capacityPerHour: 10,
      reactionsCountAgainstBudget: true,
    });
    expect(charged.costOf("reaction")).toBe(1);
    charged.consume("reaction", "informational");
    expect(charged.remaining()).toBe(9);

    const free = new BoardBudget(createBudgetState(), {
      capacityPerHour: 10,
      reactionsCountAgainstBudget: false,
    });
    expect(free.costOf("reaction")).toBe(0);
    free.consume("reaction", "informational");
    expect(free.remaining()).toBe(10);
  });

  it("reports what it spent so the ladder is observable", async () => {
    const { ack, budget } = harness({ capacityPerHour: 5 });
    await ack.acknowledge({ postId: 1, channel: "lobby", kind: "received", requestedTier: "reaction", priority: "informational" });
    await ack.acknowledge({
      postId: 2,
      channel: "lobby",
      kind: "succeeded",
      requestedTier: "reply",
      priority: "value_receipt",
      text: "done",
    });

    const snapshot = budget.snapshot();
    expect(snapshot.totals.reactions).toBe(1);
    expect(snapshot.totals.posts).toBe(1);
    expect(snapshot.usedThisHour).toBe(1);
    expect(snapshot.remaining).toBe(4);
    expect(snapshot.reactionsCountAgainstBudget).toBe(false);
  });

  it("recovers capacity as the sliding window moves", () => {
    let now = 1_000_000;
    const budget = new BoardBudget(createBudgetState(), {
      capacityPerHour: 2,
      reactionsCountAgainstBudget: true,
      now: () => now,
    });
    budget.consume("post", "value_receipt");
    budget.consume("post", "value_receipt");
    expect(budget.remaining()).toBe(0);

    now += 61 * 60 * 1000;
    expect(budget.remaining()).toBe(2);
  });
});

describe("rejections name the remedy that applies", () => {
  const context = {
    family: bountyFamily,
    requesterName: "Caller",
    postId: 42,
    familyMuseId: "muse_agent0001",
  };

  it("classifies an authorization failure separately from a malformed command", () => {
    expect(classifyRejection("assurance_insufficient")).toBe("authorization");
    expect(classifyRejection("actor_not_authenticatable")).toBe("authorization");
    expect(classifyRejection("permission_denied")).toBe("authorization");
    expect(classifyRejection("arg_missing")).toBe("malformed");
    expect(classifyRejection("arg_type_invalid")).toBe("malformed");
    expect(classifyRejection("confirmation_required")).toBe("confirmation");
    expect(classifyRejection("transition_invalid")).toBe("state");
  });

  // Funding needs key_bound; opening a bounty does not. A muse told to "check
  // your syntax" after a perfectly good `fund` would go in circles.
  it("tells an unauthorized caller to enroll, not to retype the command", () => {
    const reply = renderSiteRejection(
      "funding a bounty needs a key-bound identity",
      "authorization",
      context,
      { enrollUrl: "https://example.test/enroll" },
    );
    expect(reply).toContain("https://example.test/enroll");
    expect(reply).toContain("nothing about the command itself was wrong");
    expect(reply).not.toContain("fix the command");
  });

  it("tells an author with a bad command to fix and repost", () => {
    const reply = renderSiteRejection("deadline is not readable", "malformed", context);
    expect(reply).toContain("fix the command and post it again");
    expect(reply).not.toContain("key-bound");
  });

  it("names our muse id on every reply, because names are not unique", () => {
    const reply = renderSiteRejection("nope", "other", context);
    expect(reply).toContain("muse_agent0001");
  });
});

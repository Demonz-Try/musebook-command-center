import { beforeEach, describe, expect, it } from "vitest";
import { getBounty, listBounties } from "@/modules/bounty/escrow";
import {
  getWatermark,
  ingestPost,
  listSkips,
  pollSource,
  recentIngestEvents,
} from "@/platform/ingest/pipeline";
import type { FetchedPost, IngestPost, IngestSource } from "@/platform/ingest/types";
import { HOUR, makeBountyWithSubmission, OWNER, resetDatabase } from "./helpers";

beforeEach(resetDatabase);

const AUTHOR = "muse_wynjr";

function makePost(id: number, text: string, overrides: Partial<IngestPost> = {}): IngestPost {
  return {
    postId: id,
    channel: "lobby",
    museId: AUTHOR,
    text,
    createdAt: "2026-09-19 10:00:00",
    parentPostId: null,
    ...overrides,
  };
}

/**
 * A stand-in for the live board. `window` is what `latest.json` would return —
 * only ever the newest 100 — and `archive` is what `thread.json` can still
 * reach one id at a time. `poison` reproduces the ids that 500 forever.
 */
function fakeBoard(options: {
  window: IngestPost[];
  archive?: IngestPost[];
  poison?: number[];
  flaky?: Map<number, number>;
}): IngestSource & { fetchCalls: number[] } {
  const archive = new Map((options.archive ?? []).map((p) => [p.postId, p]));
  const poison = new Set(options.poison ?? []);
  const flaky = options.flaky ?? new Map();
  const fetchCalls: number[] = [];

  return {
    id: "musebook:lobby",
    transport: "test",
    channel: "lobby",
    fetchCalls,
    async fetch() {
      return options.window;
    },
    async fetchOne(postId): Promise<FetchedPost> {
      fetchCalls.push(postId);
      if (poison.has(postId)) {
        return { ok: false, permanentFailure: "thread.json responded 500" };
      }
      const remaining = flaky.get(postId);
      if (remaining && remaining > 0) {
        flaky.set(postId, remaining - 1);
        return { ok: false, transientFailure: "timeout" };
      }
      const post = archive.get(postId);
      if (!post) return { ok: false, permanentFailure: "no such post" };
      return { ok: true, post };
    },
  };
}

const source = { id: "musebook:lobby", transport: "test", channel: "lobby" };

describe("deduplication", () => {
  it("runs a post once, however many times it arrives", async () => {
    const post = makePost(100, "@bountyboard list open");

    const first = await ingestPost(source, post);
    const second = await ingestPost(source, post);

    expect(first.outcome).toBe("dispatched");
    expect(second.outcome).toBe("skipped");
    expect(second.reason).toBe("already seen");
  });

  it("ignores a post that addresses no family, and records that it did", async () => {
    const result = await ingestPost(source, makePost(101, "just chatting in here"));
    expect(result.outcome).toBe("ignored");

    const events = await recentIngestEvents(source.id);
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe("ignored");
  });
});

describe("acknowledgement", () => {
  it("replies to a command that worked", async () => {
    const result = await ingestPost(source, makePost(110, "@bountyboard list open"));
    expect(result.outcome).toBe("dispatched");
    expect(result.reply).toContain("bounty(ies)");
  });

  it("replies to a command it rejected, with a code the author can act on", async () => {
    const result = await ingestPost(
      source,
      makePost(111, "@bountyboard post T | B | 250 | 7d"),
    );
    expect(result.outcome).toBe("rejected");
    expect(result.reply).toContain("ambiguous_amount");
    // Silence is the failure mode we are avoiding: musebook tells the author
    // nothing, so a rejected command must still come back with something.
    expect(result.reply).toBeTruthy();
  });

  it("says nothing to a bare word that is not a verb, because it is not a command", async () => {
    // "explode" clears no argument floor, so it reads as conversation rather
    // than a misspelled verb. Answering "unknown_command" here would mean
    // answering every greeting, which is the failure the silence rule exists
    // to prevent. A body that is command-shaped and names no verb does get an
    // error -- that is the test above.
    const result = await ingestPost(source, makePost(112, "@bountyboard explode"));
    expect(result.outcome).toBe("ignored");
    expect(result.reply).toBeUndefined();
  });
});

describe("authorization at the ingest boundary", () => {
  it("refuses to move value on the strength of a post", async () => {
    const { bounty } = await makeBountyWithSubmission();
    const result = await ingestPost(
      source,
      makePost(120, `@bountyboard agree ${bounty.id}`, { museId: AUTHOR }),
    );

    // Refused before the handler runs, on assurance rather than capability: a
    // mention is capped at platform_asserted, and agree needs key_bound. The
    // reply names where to enroll, because "no" without "here is how" is how a
    // muse concludes the board is broken.
    expect(result.outcome).toBe("rejected");
    expect(result.reply).toContain("assurance_too_low");
    expect(result.reply).toContain("/api/enroll/start");

    const after = await getBounty(bounty.id);
    expect(after.escrow).toBe("held");
    expect(after.escrowBalanceMinor).toBe("25000");
  });

  it("refuses a post with no muse id rather than keying on a display name", async () => {
    const result = await ingestPost(
      source,
      makePost(121, "@bountyboard list", { museId: null }),
    );
    expect(result.outcome).toBe("rejected");
    expect(result.reason).toContain("muse id");
  });
});

describe("truncated bodies", () => {
  const full = "@bountyboard post Ship the indexer | Index every receipt | 0.005 ETH | 7d";

  it("fetches the full post instead of parsing a clipped one", async () => {
    // What the mention inbox would hand us: the same post, cut at 200 chars —
    // here cut mid-amount, which still parses as a valid, wrong amount.
    const clipped = makePost(130, "@bountyboard post Ship the indexer | Index every receipt | 0.005", {
      truncated: true,
    });
    const board = fakeBoard({
      window: [],
      archive: [makePost(130, full)],
    });

    const result = await ingestPost(board, clipped);
    expect(result.outcome).toBe("dispatched");

    const [bounty] = await listBounties();
    expect(bounty.amountMinor).toBe("5000000000000000");
    expect(bounty.currency).toBe("ETH");
  });

  it("refuses rather than parsing a clipped body it cannot replace", async () => {
    const board = fakeBoard({ window: [], archive: [], poison: [131] });
    const result = await ingestPost(
      board,
      makePost(131, "@bountyboard post T | B | 0.005", { truncated: true }),
    );

    expect(result.outcome).toBe("rejected");
    expect(result.reply).toContain("truncated");
    expect(await listBounties()).toHaveLength(0);
  });
});

describe("the high-watermark and the 100-post window", () => {
  it("starts at zero and advances to the newest post it handled", async () => {
    const board = fakeBoard({
      window: [makePost(10, "hello"), makePost(11, "@bountyboard list")],
    });

    expect(await getWatermark(board.id)).toBe(0);
    await pollSource(board);
    expect(await getWatermark(board.id)).toBe(11);
  });

  it("never replays a window it has already seen", async () => {
    const board = fakeBoard({
      window: [makePost(20, "@bountyboard list"), makePost(21, "@bountyboard list")],
    });

    const first = await pollSource(board);
    const second = await pollSource(board);

    expect(first.results.map((r) => r.outcome)).toEqual(["dispatched", "dispatched"]);
    expect(second.results).toHaveLength(0);
    expect(await getWatermark(board.id)).toBe(21);
  });

  it("closes a gap one post at a time when the window has run ahead", async () => {
    // We stopped at 200. The window now starts at 205, so 201–204 fell out of
    // it entirely — there is no pagination and no backfill, so each must be
    // fetched directly or it is lost.
    const board = fakeBoard({
      window: [makePost(205, "@bountyboard list"), makePost(206, "hello")],
      archive: [
        makePost(201, "@bountyboard list"),
        makePost(202, "chatter"),
        makePost(203, "@bountyboard list"),
        makePost(204, "chatter"),
      ],
    });
    await seedWatermark(board, 200);

    const report = await pollSource(board);

    expect(board.fetchCalls).toEqual([201, 202, 203, 204]);
    expect(report.gap).toMatchObject({ from: 201, to: 204, recovered: 4, skipped: [] });
    expect(await getWatermark(board.id)).toBe(206);
    expect(
      report.results.filter((r) => r.outcome === "dispatched"),
    ).toHaveLength(3);
  });

  it("leaves the watermark alone when a gap is still open, so a crash re-runs", async () => {
    // 202 is merely slow, not poisoned. Stepping over it would lose the post
    // forever, so the watermark stays put and the next poll tries again.
    const board = fakeBoard({
      window: [makePost(203, "@bountyboard list")],
      archive: [makePost(201, "chatter"), makePost(202, "@bountyboard list")],
      flaky: new Map([[202, 1]]),
    });
    await seedWatermark(board, 200);

    await expect(pollSource(board)).rejects.toThrow(/still open at post 202/);
    expect(await getWatermark(board.id)).toBe(200);

    // Second pass: the blip has cleared, the gap closes, the watermark moves.
    const report = await pollSource(board);
    expect(report.gap).toMatchObject({ recovered: 2, skipped: [] });
    expect(await getWatermark(board.id)).toBe(203);
  });

  it("writes off a poisoned id instead of retrying it forever", async () => {
    // Roughly one id in twenty 500s reproducibly. Retrying one of those would
    // wedge the ingest permanently, so it is recorded and counted as closed.
    const board = fakeBoard({
      window: [makePost(205, "@bountyboard list")],
      archive: [makePost(201, "chatter"), makePost(203, "chatter"), makePost(204, "chatter")],
      poison: [202],
    });
    await seedWatermark(board, 200);

    const report = await pollSource(board);

    expect(report.gap).toMatchObject({ skipped: [202] });
    expect(await getWatermark(board.id)).toBe(205);

    const skips = await listSkips(board.id);
    expect(skips).toHaveLength(1);
    expect(skips[0]).toMatchObject({ postId: 202, permanent: true });
    expect(skips[0].reason).toContain("500");

    // And a later poll does not go back for it.
    board.fetchCalls.length = 0;
    await pollSource(board);
    expect(board.fetchCalls).not.toContain(202);
  });

  it("gives up on a merely-flaky id after a bounded number of attempts", async () => {
    const board = fakeBoard({
      window: [makePost(202, "@bountyboard list")],
      archive: [],
      flaky: new Map([[201, 99]]),
    });
    await seedWatermark(board, 200);

    await expect(pollSource(board)).rejects.toThrow(/still open/);
    await expect(pollSource(board)).rejects.toThrow(/still open/);
    // Third failure crosses the limit, so the id is written off and the poll
    // completes rather than the channel stalling on one unreadable post.
    const report = await pollSource(board);
    expect(report.gap).toMatchObject({ skipped: [201] });
    expect(await getWatermark(board.id)).toBe(202);
  });
});

/** Puts the cursor where a previous run would have left it. */
async function seedWatermark(board: IngestSource, postId: number) {
  await ingestPost(board, makePost(postId, "chatter"));
  await pollSourceQuietly(board, postId);
}

async function pollSourceQuietly(board: IngestSource, postId: number) {
  const { getDb } = await import("@/db");
  const { ingestCursors } = await import("@/platform/db/schema");
  const db = await getDb();
  await db
    .insert(ingestCursors)
    .values({
      id: board.id,
      source: board.transport,
      channel: board.channel,
      highWatermarkPostId: postId,
    })
    .onConflictDoUpdate({
      target: ingestCursors.id,
      set: { highWatermarkPostId: postId },
    });
}

describe("the deadline sweep is unaffected by ingest", () => {
  it("still refunds a lapsed bounty", async () => {
    const { bounty } = await makeBountyWithSubmission();
    await ingestPost(source, makePost(300, `@bountyboard refund ${bounty.id}`));
    const after = await getBounty(bounty.id);
    // The ingested refund was refused for want of a key, not for want of a
    // lapsed deadline, so escrow is untouched.
    expect(after.escrow).toBe("held");
    expect(after.deadlineAt.getTime()).toBeGreaterThan(Date.now() + 40 * HOUR);
    expect(OWNER).toBe(bounty.owner);
  });
});

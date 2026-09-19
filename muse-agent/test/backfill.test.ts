import { describe, expect, it, vi } from "vitest";
import { runBackfill } from "../src/ingest/backfill.js";
import { PostFetcher } from "../src/ingest/fetcher.js";
import { advanceWatermark, createState, detectGap, markPoisoned } from "../src/ingest/state.js";
import type { MusebookClient } from "../src/musebook/client.js";
import { PermanentPostError, type MusebookPost } from "../src/musebook/types.js";
import { silentLogger } from "../src/runtime/logger.js";

function post(id: number, text = "hello"): MusebookPost {
  return {
    id,
    channel: "lobby",
    text,
    name: "Someone",
    muse_id: `muse_${String(id).padStart(10, "0")}`,
    parent_post_id: null,
    created_at: "2026-09-19 10:00:00",
    reply_count: 0,
    id_verified: true,
    founder: false,
    avatar_url: null,
  };
}

/**
 * thread.json stand-in. `threads` maps a probed id to the posts it returns;
 * `broken` is the set of ids that return a permanent 500.
 */
function fakeClient(options: { threads: Record<number, MusebookPost[]>; broken?: number[] }) {
  const broken = new Set(options.broken ?? []);
  const getThread = vi.fn(async (postId: number) => {
    if (broken.has(postId)) throw new PermanentPostError(postId, 500);
    return options.threads[postId] ?? [post(postId)];
  });
  return { client: { getThread } as unknown as MusebookClient, getThread };
}

function fetcherFor(client: MusebookClient, state: ReturnType<typeof createState>) {
  return new PostFetcher({
    client,
    logger: silentLogger,
    isPoisoned: (postId) => state.poisonedPostIds.includes(postId),
    onPoisoned: (postId) => markPoisoned(state, postId),
  });
}

describe("backfill through thread.json", () => {
  it("recovers a gap the feed can no longer list", async () => {
    const state = createState("bounty", "muse_test000");
    state.watermark = 100;
    state.highestSeenId = 105;
    detectGap(state, 105);

    const { client, getThread } = fakeClient({ threads: {} });
    const result = await runBackfill(state, fetcherFor(client, state), {
      isInteresting: () => false,
      logger: silentLogger,
    });

    expect(result.complete).toBe(true);
    expect(state.gap).toBeNull();
    expect(getThread).toHaveBeenCalledTimes(4);
    expect(advanceWatermark(state)).toBe(105);
  });

  it("accounts for every id a thread returns, not just the one probed", async () => {
    const state = createState("bounty", null);
    state.watermark = 100;
    state.highestSeenId = 111;
    detectGap(state, 111);
    expect(state.gap?.remaining).toHaveLength(10);

    // One thread covers the whole range, so one request should close the gap.
    const wholeThread = [101, 102, 103, 104, 105, 106, 107, 108, 109, 110].map((id) => post(id));
    const { client, getThread } = fakeClient({ threads: { 110: wholeThread } });

    const result = await runBackfill(state, fetcherFor(client, state), {
      isInteresting: () => false,
      logger: silentLogger,
    });

    expect(getThread).toHaveBeenCalledTimes(1);
    expect(result.complete).toBe(true);
    expect(state.gap).toBeNull();
  });

  it("queues only the recovered posts that mention us", async () => {
    const state = createState("bounty", null);
    state.watermark = 100;
    state.highestSeenId = 104;
    detectGap(state, 104);

    const thread = [post(101, "unrelated chatter"), post(102, "@bountydesk status BNT-9"), post(103, "more chatter")];
    const { client } = fakeClient({ threads: { 103: thread } });

    const result = await runBackfill(state, fetcherFor(client, state), {
      isInteresting: (candidate) => /@bountydesk\b/i.test(candidate.text),
      logger: silentLogger,
    });

    expect(result.queued).toBe(1);
    expect(Object.keys(state.posts)).toEqual(["102"]);
  });

  // The compounding trap: thread.json is the only backfill mechanism AND the
  // endpoint with reproducible permanent 500s.
  it("skips a permanently broken id instead of wedging on it", async () => {
    const state = createState("bounty", null);
    state.watermark = 14_279;
    state.highestSeenId = 14_283;
    detectGap(state, 14_283);

    const { client, getThread } = fakeClient({ threads: {}, broken: [14_280] });
    const result = await runBackfill(state, fetcherFor(client, state), {
      isInteresting: () => false,
      logger: silentLogger,
    });

    expect(result.complete).toBe(true);
    expect(result.skipped).toBe(1);
    expect(state.poisonedPostIds).toContain(14_280);
    expect(getThread).toHaveBeenCalledTimes(3);
    // The gap closed despite the poisoned id, so the watermark moves on.
    expect(advanceWatermark(state)).toBe(14_283);
  });

  it("does not re-probe a poisoned id on a later pass", async () => {
    const state = createState("bounty", null);
    state.watermark = 14_279;
    state.highestSeenId = 14_281;
    detectGap(state, 14_281);

    const { client, getThread } = fakeClient({ threads: {}, broken: [14_280] });
    const fetcher = fetcherFor(client, state);

    await runBackfill(state, fetcher, { isInteresting: () => false, logger: silentLogger });
    expect(getThread).toHaveBeenCalledTimes(1);

    // A later gap covering the same id must not spend another request on it.
    state.watermark = 14_279;
    detectGap(state, 14_281);
    await runBackfill(state, fetcher, { isInteresting: () => false, logger: silentLogger });
    expect(getThread).toHaveBeenCalledTimes(1);
  });

  it("survives a gap where every id is broken", async () => {
    const state = createState("bounty", null);
    state.watermark = 0;
    state.highestSeenId = 4;
    detectGap(state, 4);

    const { client } = fakeClient({ threads: {}, broken: [1, 2, 3] });
    const result = await runBackfill(state, fetcherFor(client, state), {
      isInteresting: () => false,
      logger: silentLogger,
    });

    expect(result.skipped).toBe(3);
    expect(state.gap).toBeNull();
    expect(advanceWatermark(state)).toBe(4);
  });

  it("stops at the request budget and leaves the rest for the next pass", async () => {
    const state = createState("bounty", null);
    state.watermark = 0;
    state.highestSeenId = 21;
    detectGap(state, 21);

    const { client, getThread } = fakeClient({ threads: {} });
    const result = await runBackfill(state, fetcherFor(client, state), {
      budget: 5,
      isInteresting: () => false,
      logger: silentLogger,
    });

    expect(getThread).toHaveBeenCalledTimes(5);
    expect(result.complete).toBe(false);
    expect(result.remaining).toBe(15);
    // Unfinished gap keeps the watermark pinned so the next run resumes it.
    expect(advanceWatermark(state)).toBe(0);
  });

  it("works newest-first so the freshest missed commands land even if the budget runs out", async () => {
    const state = createState("bounty", null);
    state.watermark = 0;
    state.highestSeenId = 11;
    detectGap(state, 11);

    const { client, getThread } = fakeClient({ threads: {} });
    await runBackfill(state, fetcherFor(client, state), {
      budget: 2,
      isInteresting: () => false,
      logger: silentLogger,
    });

    expect(getThread.mock.calls.map((call) => call[0])).toEqual([10, 9]);
  });
});

describe("post fetching", () => {
  it("reports a permanently broken post as unavailable rather than throwing", async () => {
    const state = createState("bounty", null);
    const { client } = fakeClient({ threads: {}, broken: [18_440] });
    const fetcher = fetcherFor(client, state);

    const outcome = await fetcher.getPost(18_440);
    expect(outcome).toMatchObject({ ok: false, reason: "unavailable" });
    expect(state.poisonedPostIds).toContain(18_440);
  });

  it("serves a cached post without another request", async () => {
    const state = createState("bounty", null);
    const { client, getThread } = fakeClient({ threads: { 7: [post(7)] } });
    const fetcher = fetcherFor(client, state);

    await fetcher.getPost(7);
    await fetcher.getPost(7);
    expect(getThread).toHaveBeenCalledTimes(1);
  });
});

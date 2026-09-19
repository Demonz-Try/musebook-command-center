import { describe, expect, it } from "vitest";
import {
  advanceWatermark,
  createState,
  isKnown,
  recordPost,
  updateRecord,
} from "../src/ingest/state.js";

describe("dedupe by post id", () => {
  it("collapses the same post arriving from the inbox, the stream and a backfill", () => {
    const state = createState("bounty", "muse_test000");
    const first = recordPost(state, { postId: 4242, source: "mentions", channel: "lobby" });
    const second = recordPost(state, { postId: 4242, source: "live" });
    const third = recordPost(state, { postId: 4242, source: "backfill" });

    expect(Object.keys(state.posts)).toEqual(["4242"]);
    expect(second).toBe(first);
    expect(third).toBe(first);
    // The source that saw it first wins, so the audit trail stays honest.
    expect(first?.source).toBe("mentions");
  });

  it("fills in details a later sighting knows and the first did not", () => {
    const state = createState("bounty", null);
    recordPost(state, { postId: 7, source: "live", channel: null });
    recordPost(state, { postId: 7, source: "mentions", channel: "rentahuman", fromMuseId: "muse_abc1234567" });

    expect(state.posts["7"]).toMatchObject({ channel: "rentahuman", fromMuseId: "muse_abc1234567" });
  });

  it("does not re-queue a post that has already been executed", () => {
    const state = createState("bounty", null);
    recordPost(state, { postId: 50, source: "mentions" });
    updateRecord(state, 50, { status: "done", replyPostId: 51 });

    const again = recordPost(state, { postId: 50, source: "mentions" });
    expect(again?.status).toBe("done");
    expect(again?.replyPostId).toBe(51);
  });

  it("ignores ids the watermark has already passed, even after pruning", () => {
    const state = createState("bounty", null);
    recordPost(state, { postId: 10, source: "mentions" });
    updateRecord(state, 10, { status: "done" });
    advanceWatermark(state);
    delete state.posts["10"];

    expect(isKnown(state, 10)).toBe(true);
    expect(recordPost(state, { postId: 10, source: "mentions" })).toBeNull();
  });

  it("tracks the highest seen id even for posts it will not act on", () => {
    const state = createState("bounty", null);
    recordPost(state, { postId: 900, source: "live" });
    expect(state.highestSeenId).toBe(900);
  });
});

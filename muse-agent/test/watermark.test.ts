import { describe, expect, it } from "vitest";
import {
  advanceWatermark,
  closeGapId,
  createState,
  detectGap,
  isKnown,
  markPoisoned,
  pendingRecords,
  pruneRecords,
  recordPost,
  updateRecord,
  type AgentState,
} from "../src/ingest/state.js";

function stateWith(watermark: number): AgentState {
  const state = createState("bounty", "muse_test000");
  state.watermark = watermark;
  state.highestSeenId = watermark;
  return state;
}

describe("watermark resume", () => {
  it("advances to the highest seen id once everything resolves", () => {
    const state = stateWith(100);
    recordPost(state, { postId: 101, source: "mentions" });
    recordPost(state, { postId: 102, source: "mentions" });
    expect(advanceWatermark(state)).toBe(100);

    updateRecord(state, 101, { status: "done" });
    updateRecord(state, 102, { status: "ignored" });
    expect(advanceWatermark(state)).toBe(102);
  });

  it("stops just below the lowest unresolved id", () => {
    const state = stateWith(100);
    recordPost(state, { postId: 101, source: "mentions" });
    recordPost(state, { postId: 102, source: "mentions" });
    recordPost(state, { postId: 103, source: "mentions" });
    updateRecord(state, 101, { status: "done" });
    updateRecord(state, 103, { status: "done" });

    // 102 is still in flight, so the watermark may not pass it even though a
    // higher id is already finished.
    expect(advanceWatermark(state)).toBe(101);
    updateRecord(state, 102, { status: "done" });
    expect(advanceWatermark(state)).toBe(103);
  });

  it("never moves backwards", () => {
    const state = stateWith(500);
    advanceWatermark(state);
    expect(state.watermark).toBe(500);
    recordPost(state, { postId: 501, source: "mentions" });
    expect(advanceWatermark(state)).toBe(500);
  });

  it("resumes from the persisted watermark and treats everything below as handled", () => {
    const state = stateWith(1000);
    expect(isKnown(state, 999)).toBe(true);
    expect(isKnown(state, 1000)).toBe(true);
    expect(isKnown(state, 1001)).toBe(false);
    // An old id arriving again is not re-queued.
    expect(recordPost(state, { postId: 999, source: "mentions" })).toBeNull();
    expect(Object.keys(state.posts)).toHaveLength(0);
  });

  it("abandoned work stops blocking so one poisoned mention cannot wedge the agent", () => {
    const state = stateWith(10);
    recordPost(state, { postId: 11, source: "mentions" });
    recordPost(state, { postId: 12, source: "mentions" });
    updateRecord(state, 12, { status: "done" });
    expect(advanceWatermark(state)).toBe(10);

    updateRecord(state, 11, { status: "abandoned" });
    expect(advanceWatermark(state)).toBe(12);
  });

  it("keeps a retrying record out of the ready queue until its backoff expires", () => {
    const state = stateWith(0);
    recordPost(state, { postId: 5, source: "mentions" });
    updateRecord(state, 5, { status: "retry", nextAttemptAt: 10_000 });
    expect(pendingRecords(state, 9_000)).toHaveLength(0);
    expect(pendingRecords(state, 11_000)).toHaveLength(1);
  });

  it("prunes settled records the watermark has subsumed, without forgetting them", () => {
    const state = stateWith(0);
    for (let id = 1; id <= 10; id += 1) {
      recordPost(state, { postId: id, source: "mentions" });
      updateRecord(state, id, { status: "done" });
    }
    advanceWatermark(state);
    expect(pruneRecords(state, 3)).toBe(7);
    expect(Object.keys(state.posts)).toHaveLength(3);
    // Pruned ids are below the watermark, so they still read as handled.
    expect(isKnown(state, 1)).toBe(true);
  });
});

describe("gap detection and backfill bookkeeping", () => {
  it("opens a gap for ids that were never listed", () => {
    const state = stateWith(1000);
    const detection = detectGap(state, 1101);
    expect(detection.opened).toBe(true);
    expect(state.gap).toMatchObject({ from: 1001, to: 1100 });
    expect(state.gap?.remaining).toHaveLength(100);
  });

  it("does not open a gap when the window is contiguous", () => {
    const state = stateWith(1000);
    expect(detectGap(state, 1001).opened).toBe(false);
    expect(state.gap).toBeNull();
  });

  it("pins the watermark below the gap until the gap closes", () => {
    const state = stateWith(1000);
    detectGap(state, 1004);
    state.highestSeenId = 1004;
    recordPost(state, { postId: 1004, source: "mentions" });
    updateRecord(state, 1004, { status: "done" });

    // 1001..1003 are unaccounted for, so the watermark stays put even though
    // the newest post is already handled.
    expect(advanceWatermark(state)).toBe(1000);

    closeGapId(state, 1001);
    closeGapId(state, 1002);
    expect(advanceWatermark(state)).toBe(1002);

    closeGapId(state, 1003);
    expect(state.gap).toBeNull();
    expect(advanceWatermark(state)).toBe(1004);
  });

  it("re-runs rather than skips after a crash mid-backfill", () => {
    const state = stateWith(1000);
    detectGap(state, 1006);
    closeGapId(state, 1001);
    closeGapId(state, 1002);
    advanceWatermark(state);

    // Simulate a crash: only what was persisted survives.
    const resumed: AgentState = JSON.parse(JSON.stringify(state));
    expect(resumed.watermark).toBe(1002);
    expect(resumed.gap?.remaining).toEqual([1003, 1004, 1005]);
  });

  it("merges a second gap into the open one instead of dropping the older ids", () => {
    const state = stateWith(1000);
    detectGap(state, 1004);
    closeGapId(state, 1001);
    state.highestSeenId = 1010;
    detectGap(state, 1010);
    expect(state.gap?.remaining).toContain(1002);
    expect(state.gap?.remaining).toContain(1009);
  });

  it("caps an enormous gap and lets the watermark past the part it gave up on", () => {
    const state = stateWith(0);
    state.watermark = 10;
    const detection = detectGap(state, 20_000, { maxGapSize: 100 });
    expect(detection.truncated).toEqual({ requested: 19_989, covered: 100 });
    expect(state.gap?.remaining).toHaveLength(100);
    expect(state.watermark).toBe(19_899);
  });

  it("closes a poisoned id permanently and records it", () => {
    const state = stateWith(1000);
    detectGap(state, 1003);
    markPoisoned(state, 1001);
    expect(state.poisonedPostIds).toEqual([1001]);
    expect(state.gap?.remaining).toEqual([1002]);
    expect(state.gap?.skipped).toEqual([1001]);

    // A poisoned id is never re-queued by a later gap.
    markPoisoned(state, 1002);
    expect(state.gap).toBeNull();
    state.watermark = 1000;
    expect(detectGap(state, 1003).opened).toBe(false);
    expect(state.gap).toBeNull();
    expect(state.watermark).toBe(1002);
  });
});

/**
 * Durable ingest state and the pure functions that move it.
 *
 * Kept free of IO so every rule below is directly testable: watermark advance,
 * gap detection, backfill bookkeeping and dedupe are the parts that decide
 * whether a restart re-runs work or silently skips it.
 */

import { createBudgetState, type BoardBudgetState } from "../reply/budget.js";

export type PostStatus =
  /** Ingested, not yet processed. Blocks the watermark. */
  | "seen"
  /** Transient failure; will be retried. Blocks the watermark. */
  | "retry"
  /** Executed and receipted. Terminal. */
  | "done"
  /** Bad input; we replied with an error. Terminal. */
  | "rejected"
  /** Conversational mention; deliberately silent. Terminal. */
  | "ignored"
  /** Repeated internal failure; we gave up without spamming. Terminal. */
  | "abandoned"
  /** musebook cannot serve the body (permanent 500). Terminal. */
  | "unavailable";

const TERMINAL_STATUSES = new Set<PostStatus>([
  "done",
  "rejected",
  "ignored",
  "abandoned",
  "unavailable",
]);

export type IngestSource = "mentions" | "backfill" | "live" | "manual";

export interface PostRecord {
  id: number;
  status: PostStatus;
  source: IngestSource;
  attempts: number;
  channel?: string | null;
  fromMuseId?: string | null;
  idempotencyKey?: string;
  /** Set once the site API has acknowledged. Survives a crash before replying. */
  backendAcknowledged?: boolean;
  /** Set once the public receipt exists. Guarantees we never reply twice. */
  replyPostId?: number;
  /** Set once the site has settled the invocation, so a retry only re-acks. */
  settled?: boolean;
  /** Async work in flight; poll this rather than re-invoking. */
  jobId?: string;
  /** Tier actually spent, for operators auditing the ack ladder. */
  ackTier?: string;
  lastError?: string;
  nextAttemptAt?: number;
  firstSeenAt: string;
  updatedAt: string;
}

export interface GapState {
  from: number;
  to: number;
  /** Ids still unaccounted for. The watermark cannot pass the lowest of these. */
  remaining: number[];
  openedAt: string;
  /** Ids we deliberately stopped trying to fetch, with the reason. */
  skipped: number[];
}

export interface AgentState {
  version: 1;
  familyId: string;
  museId: string | null;
  /** Sliding-window board write budget. Survives restarts on purpose. */
  boardBudget: BoardBudgetState;
  /** Emoji already placed per post. Reactions toggle, so a repeat removes one. */
  reactions: Record<string, string[]>;
  /** Every post id at or below this is fully resolved. */
  watermark: number;
  /** Highest id observed, resolved or not. */
  highestSeenId: number;
  posts: Record<string, PostRecord>;
  /** thread.json 5xx ids. Permanent; never retried. */
  poisonedPostIds: number[];
  gap: GapState | null;
  lastPollAt: string | null;
  lastWatermarkAt: string | null;
}

export function createState(familyId: string, museId: string | null): AgentState {
  return {
    version: 1,
    familyId,
    museId,
    boardBudget: createBudgetState(),
    reactions: {},
    watermark: 0,
    highestSeenId: 0,
    posts: {},
    poisonedPostIds: [],
    gap: null,
    lastPollAt: null,
    lastWatermarkAt: null,
  };
}

export function getRecord(state: AgentState, postId: number): PostRecord | undefined {
  return state.posts[String(postId)];
}

export function isTerminal(status: PostStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
 * True when this post has already been handled (or is already queued).
 * Dedupe is strictly on the integer post id — never on timestamps, which come
 * back in two different formats from two different surfaces.
 */
export function isKnown(state: AgentState, postId: number): boolean {
  if (postId <= state.watermark) return true;
  return state.posts[String(postId)] !== undefined;
}

export interface RecordPostInput {
  postId: number;
  source: IngestSource;
  channel?: string | null;
  fromMuseId?: string | null;
  now?: () => string;
}

/**
 * Register a post for processing. Idempotent: an id that is already known keeps
 * its existing record, so the same mention arriving from the inbox, the
 * WebSocket and a backfill collapses onto one unit of work.
 */
export function recordPost(state: AgentState, input: RecordPostInput): PostRecord | null {
  const { postId, source } = input;
  const now = (input.now ?? defaultNow)();
  if (postId <= state.watermark) return null;

  state.highestSeenId = Math.max(state.highestSeenId, postId);
  const key = String(postId);
  const existing = state.posts[key];
  if (existing) {
    if (input.channel && !existing.channel) existing.channel = input.channel;
    if (input.fromMuseId && !existing.fromMuseId) existing.fromMuseId = input.fromMuseId;
    return existing;
  }

  const record: PostRecord = {
    id: postId,
    status: "seen",
    source,
    attempts: 0,
    channel: input.channel ?? null,
    fromMuseId: input.fromMuseId ?? null,
    firstSeenAt: now,
    updatedAt: now,
  };
  state.posts[key] = record;
  return record;
}

export function updateRecord(
  state: AgentState,
  postId: number,
  patch: Partial<Omit<PostRecord, "id">>,
  now: () => string = defaultNow,
): PostRecord | undefined {
  const record = state.posts[String(postId)];
  if (!record) return undefined;
  Object.assign(record, patch, { updatedAt: now() });
  return record;
}

/**
 * Ids that must not be passed by the watermark: anything still in flight, plus
 * every id a backfill has not yet accounted for.
 */
export function blockingIds(state: AgentState): number[] {
  const blockers: number[] = [];
  if (state.gap) blockers.push(...state.gap.remaining);
  for (const record of Object.values(state.posts)) {
    if (!isTerminal(record.status)) blockers.push(record.id);
  }
  return blockers;
}

/**
 * Advance the watermark to just below the lowest unresolved id.
 *
 * This is what makes a mid-backfill crash re-run instead of skip: while a gap
 * has unaccounted ids, the lowest of them pins the watermark in place, so the
 * next start re-derives exactly the same outstanding work.
 */
export function advanceWatermark(state: AgentState, now: () => string = defaultNow): number {
  const blockers = blockingIds(state);
  const candidate = blockers.length === 0 ? state.highestSeenId : Math.min(...blockers) - 1;
  const next = Math.max(state.watermark, Math.min(candidate, state.highestSeenId));
  if (next !== state.watermark) {
    state.watermark = next;
  }
  state.lastWatermarkAt = now();
  return state.watermark;
}

/**
 * Drop terminal records that the watermark has already subsumed. Their ids are
 * below the watermark, so `isKnown` still reports them as handled.
 */
export function pruneRecords(state: AgentState, keepBelowWatermark = 2000): number {
  const cutoff = state.watermark - keepBelowWatermark;
  if (cutoff <= 0) return 0;
  let pruned = 0;
  for (const [key, record] of Object.entries(state.posts)) {
    if (record.id <= cutoff && isTerminal(record.status)) {
      delete state.posts[key];
      pruned += 1;
    }
  }
  state.poisonedPostIds = state.poisonedPostIds.filter((id) => id > cutoff);
  return pruned;
}

export interface GapDetectionOptions {
  /** Cap on how many ids one gap may cover. */
  maxGapSize?: number;
}

export interface GapDetection {
  opened: boolean;
  /** Set when the gap was larger than the cap and the oldest ids were dropped. */
  truncated?: { requested: number; covered: number };
}

/**
 * A listing endpoint returned a page whose oldest id is above the watermark.
 * Every id in between was never listed and — because musebook has no
 * pagination, no cursor and no archive — can only be recovered by id probing.
 */
export function detectGap(
  state: AgentState,
  oldestReturnedId: number,
  options: GapDetectionOptions = {},
  now: () => string = defaultNow,
): GapDetection {
  const from = state.watermark + 1;
  const to = oldestReturnedId - 1;
  if (to < from) return { opened: false };

  // Ids below one the server just returned provably exist, so they count as
  // seen even though they were never listed. Without this the watermark
  // cannot advance past a gap it has fully reconciled.
  state.highestSeenId = Math.max(state.highestSeenId, to);

  const maxGapSize = options.maxGapSize ?? 2000;
  const fullSize = to - from + 1;
  // When a gap exceeds the cap, recover the NEWEST ids in it: they are the ones
  // still actionable, and the alternative is never closing the gap at all.
  const effectiveFrom = fullSize > maxGapSize ? to - maxGapSize + 1 : from;
  const remaining: number[] = [];
  for (let id = effectiveFrom; id <= to; id += 1) {
    if (!isKnown(state, id) && !state.poisonedPostIds.includes(id)) remaining.push(id);
  }

  if (remaining.length === 0 && !state.gap) {
    // Everything in the range is already known or already known-broken, so
    // there is nothing to recover and no reason to hold the watermark back.
    state.watermark = Math.max(state.watermark, to);
    return { opened: false };
  }

  if (state.gap) {
    // Merge into the open gap rather than replacing it, or the older
    // outstanding ids would be silently abandoned.
    const merged = new Set([...state.gap.remaining, ...remaining]);
    state.gap.remaining = [...merged].sort((a, b) => a - b);
    state.gap.to = Math.max(state.gap.to, to);
    state.gap.from = Math.min(state.gap.from, effectiveFrom);
  } else {
    state.gap = {
      from: effectiveFrom,
      to,
      remaining,
      openedAt: now(),
      skipped: [],
    };
  }

  const detection: GapDetection = { opened: true };
  if (fullSize > maxGapSize) {
    detection.truncated = { requested: fullSize, covered: maxGapSize };
    // The skipped range can never be recovered, so let the watermark move past it.
    state.watermark = Math.max(state.watermark, effectiveFrom - 1);
  }
  return detection;
}

/** Account for an id during backfill, whether it was fetched, recovered or skipped. */
export function closeGapId(state: AgentState, postId: number, skipped = false): void {
  if (!state.gap) return;
  state.gap.remaining = state.gap.remaining.filter((id) => id !== postId);
  if (skipped && !state.gap.skipped.includes(postId)) state.gap.skipped.push(postId);
  if (state.gap.remaining.length === 0) state.gap = null;
}

export function markPoisoned(state: AgentState, postId: number): void {
  if (!state.poisonedPostIds.includes(postId)) state.poisonedPostIds.push(postId);
  closeGapId(state, postId, true);
}

export function isPoisoned(state: AgentState, postId: number): boolean {
  return state.poisonedPostIds.includes(postId);
}

export function pendingRecords(state: AgentState, now = Date.now()): PostRecord[] {
  return Object.values(state.posts)
    .filter((record) => !isTerminal(record.status))
    .filter((record) => !record.nextAttemptAt || record.nextAttemptAt <= now)
    .sort((a, b) => a.id - b.id);
}

function defaultNow(): string {
  return new Date().toISOString();
}

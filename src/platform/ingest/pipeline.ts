import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { loadModules } from "../bootstrap";
import { acknowledging } from "../commands/acknowledge";
import { addressBook, dispatch, NotCommandShaped } from "../commands/registry";
import { matchAddress } from "../commands/trigger";
import { ingestCursors, ingestEvents, ingestSkips } from "../db/schema";
import { isMuseId } from "../identity";
import type { FetchedPost, IngestPost, IngestResult, IngestSource } from "./types";

/** How many times a gap id may fail before it is written off as poisoned. */
const MAX_GAP_ATTEMPTS = 3;

/** The board only ever shows the newest 100 posts in a channel. */
export const WINDOW = 100;

export async function getWatermark(sourceId: string): Promise<number> {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(ingestCursors)
    .where(eq(ingestCursors.id, sourceId));
  return row?.highWatermarkPostId ?? 0;
}

async function setWatermark(
  sourceId: string,
  source: { transport: string; channel: string | null },
  postId: number,
  error?: string,
) {
  const db = await getDb();
  await db
    .insert(ingestCursors)
    .values({
      id: sourceId,
      source: source.transport,
      channel: source.channel,
      highWatermarkPostId: postId,
      lastPolledAt: new Date(),
      lastError: error ?? null,
    })
    .onConflictDoUpdate({
      target: ingestCursors.id,
      set: {
        // Never move backwards, so two transports racing cannot replay a window.
        highWatermarkPostId: sql`greatest(${ingestCursors.highWatermarkPostId}, ${postId})`,
        lastPolledAt: new Date(),
        lastError: error ?? null,
        updatedAt: new Date(),
      },
    });
}

async function noteSkip(
  sourceId: string,
  postId: number,
  reason: string,
  permanent: boolean,
): Promise<number> {
  const db = await getDb();
  const [row] = await db
    .insert(ingestSkips)
    .values({
      id: randomUUID(),
      source: sourceId,
      postId,
      reason,
      permanent,
      attempts: 1,
    })
    .onConflictDoUpdate({
      target: [ingestSkips.source, ingestSkips.postId],
      set: {
        attempts: sql`${ingestSkips.attempts} + 1`,
        reason,
        permanent,
        lastTriedAt: new Date(),
      },
    })
    .returning();
  return row?.attempts ?? 1;
}

/** Post ids in a range that are already written off. */
async function skippedIds(sourceId: string, ids: number[]): Promise<Set<number>> {
  if (ids.length === 0) return new Set();
  const db = await getDb();
  const rows = await db
    .select({ postId: ingestSkips.postId, attempts: ingestSkips.attempts, permanent: ingestSkips.permanent })
    .from(ingestSkips)
    .where(and(eq(ingestSkips.source, sourceId), inArray(ingestSkips.postId, ids)));
  return new Set(
    rows
      .filter((row) => row.permanent || row.attempts >= MAX_GAP_ATTEMPTS)
      .map((row) => row.postId),
  );
}

export async function listSkips(sourceId: string) {
  const db = await getDb();
  return db
    .select()
    .from(ingestSkips)
    .where(eq(ingestSkips.source, sourceId))
    .orderBy(sql`${ingestSkips.postId} asc`);
}

/**
 * Handles one post.
 *
 * Every decision is recorded before anything is dispatched, keyed on
 * `(source, postId)`, so an overlapping poll, a replayed window or a second
 * transport cannot run the same command twice.
 */
export async function ingestPost(
  source: Pick<IngestSource, "id" | "transport" | "channel"> & { fetchOne?: IngestSource["fetchOne"] },
  input: IngestPost,
): Promise<IngestResult> {
  loadModules();
  const db = await getDb();

  const claimed = await db
    .insert(ingestEvents)
    .values({
      id: randomUUID(),
      source: source.id,
      postId: input.postId,
      channel: input.channel,
      museId: input.museId,
      outcome: "ignored",
    })
    .onConflictDoNothing({
      target: [ingestEvents.source, ingestEvents.postId],
    })
    .returning();

  if (claimed.length === 0) {
    return { postId: input.postId, outcome: "skipped", reason: "already seen" };
  }
  const rowId = claimed[0].id;

  const record = async (result: IngestResult, extra?: Record<string, unknown>) => {
    await db
      .update(ingestEvents)
      .set({
        outcome: result.outcome,
        reason: result.reason ?? null,
        commandText: result.command ?? null,
        result: extra ?? null,
      })
      .where(eq(ingestEvents.id, rowId));
    return result;
  };

  // The mention inbox clips bodies at 200 characters, and a clipped
  // "0.005 ETH" is a perfectly valid "0.005 ET" — or worse, a valid "0.00".
  // So a body that might be clipped is never parsed; we go and get the real one.
  let post = input;
  if (post.truncated && source.fetchOne) {
    const full = await source.fetchOne(post.postId);
    if (full.ok && full.post) {
      post = { ...full.post, truncated: false };
    } else {
      return record({
        postId: post.postId,
        outcome: "rejected",
        reason: `could not fetch the full post (${full.permanentFailure ?? full.transientFailure ?? "unknown"}); refusing to parse a truncated body`,
        reply:
          "Rejected (validation): I could only see a truncated copy of that post and will not guess at the rest. Please post the command again.",
      });
    }
  }

  const address = matchAddress(post.text ?? "", addressBook());
  if (!address) {
    return record({ postId: post.postId, outcome: "ignored", reason: "not addressed to us" });
  }

  if (!post.museId || !isMuseId(post.museId)) {
    return record({
      postId: post.postId,
      outcome: "rejected",
      reason: "no usable muse id on the post",
      command: post.text,
      reply:
        "Rejected (validation): that post carries no musebook id I can attribute it to, and I will not key on a display name.",
    });
  }

  // Always reply, pass or fail. A command that fails silently on musebook is
  // indistinguishable from one we never saw, which is how a muse ends up
  // re-posting the same broken amount forever.
  let ack;
  try {
    ack = await acknowledging(() =>
      dispatch(post.text, {
        actor: { kind: "muse", id: post.museId!.toLowerCase() },
        // A musebook post carries no signature we can check, so an ingested
        // command can never reach a privileged capability.
        origin: "mention",
      }),
    );
  } catch (error) {
    // The silence rule: this addressed us, but it does not read as an attempt
    // at a command. Conversational mentions are most of what a family muse
    // receives, and answering a greeting with "unknown command" is rude, burns
    // the board budget, and makes the family look broken.
    if (error instanceof NotCommandShaped) {
      return record({
        postId: post.postId,
        outcome: "ignored",
        reason: "addressed us, but not command-shaped",
      });
    }
    throw error;
  }

  return record(
    {
      postId: post.postId,
      outcome: ack.ok ? "dispatched" : "rejected",
      reason: ack.ok ? undefined : ack.code ?? undefined,
      command: ack.command ?? `${address.family} ${address.body}`.trim(),
      reply: ack.message,
    },
    { acknowledgement: ack },
  );
}

export interface PollReport {
  source: string;
  watermark: number;
  results: IngestResult[];
  /** Ids that fell out of the window and had to be fetched one at a time. */
  gap: { from: number; to: number; recovered: number; skipped: number[] } | null;
}

/**
 * Polls a source once.
 *
 * `latest.json` takes only `limit`, capped at 100 — `offset`, `before` and
 * `since` are accepted and silently ignored — and the busiest channel turns
 * that window over in about fifteen minutes. So when the newest id has run
 * further ahead than the window, the missing ids are fetched individually and
 * the watermark only advances once the gap is closed. A crash mid-gap re-runs
 * the gap rather than stepping over it.
 */
export async function pollSource(
  source: IngestSource,
  options: { limit?: number } = {},
): Promise<PollReport> {
  const sincePostId = await getWatermark(source.id);
  const limit = Math.min(options.limit ?? WINDOW, WINDOW);

  let posts: IngestPost[];
  try {
    posts = await source.fetch({ sincePostId, limit });
  } catch (error) {
    await setWatermark(source.id, source, sincePostId, (error as Error).message);
    throw error;
  }

  const fresh = posts
    .filter((post) => post.postId > sincePostId)
    .sort((a, b) => a.postId - b.postId);

  const results: IngestResult[] = [];
  let gap: PollReport["gap"] = null;

  const oldestFresh = fresh[0]?.postId;
  if (sincePostId > 0 && oldestFresh !== undefined && oldestFresh > sincePostId + 1) {
    gap = await closeGap(source, sincePostId, oldestFresh, results);
    if (gap.skipped.length > 0 || gap.recovered >= 0) {
      // Everything below the window either ran or was written off, so the
      // watermark may safely step up to where the window begins.
      await setWatermark(source.id, source, oldestFresh - 1);
    }
  }

  for (const post of fresh) {
    results.push(await ingestPost(source, post));
    await setWatermark(source.id, source, post.postId);
  }

  return {
    source: source.id,
    watermark: await getWatermark(source.id),
    results,
    gap,
  };
}

/**
 * Walks the ids between the watermark and the start of the window, fetching
 * each one directly. An id that fails permanently, or that has failed
 * `MAX_GAP_ATTEMPTS` times, is written off — `thread.json` 500s are
 * reproducible, so retrying one forever only stops the ingest from ever
 * catching up.
 */
async function closeGap(
  source: IngestSource,
  watermark: number,
  windowStart: number,
  results: IngestResult[],
): Promise<NonNullable<PollReport["gap"]>> {
  const from = watermark + 1;
  const to = windowStart - 1;
  const ids: number[] = [];
  for (let id = from; id <= to; id++) ids.push(id);

  const alreadySkipped = await skippedIds(source.id, ids);
  const skipped: number[] = [...alreadySkipped];
  let recovered = 0;

  for (const id of ids) {
    if (alreadySkipped.has(id)) continue;

    if (!source.fetchOne) {
      await noteSkip(source.id, id, "source cannot fetch single posts", true);
      skipped.push(id);
      continue;
    }

    let fetched: FetchedPost;
    try {
      fetched = await source.fetchOne(id);
    } catch (error) {
      fetched = { ok: false, transientFailure: (error as Error).message };
    }

    if (fetched.ok && fetched.post) {
      results.push(await ingestPost(source, fetched.post));
      recovered++;
      continue;
    }

    const reason =
      fetched.permanentFailure ?? fetched.transientFailure ?? "post did not resolve";
    const attempts = await noteSkip(
      source.id,
      id,
      reason,
      Boolean(fetched.permanentFailure),
    );
    if (fetched.permanentFailure || attempts >= MAX_GAP_ATTEMPTS) {
      skipped.push(id);
      results.push({ postId: id, outcome: "skipped", reason });
    } else {
      // Still transient. Leave the watermark where it is by reporting the gap
      // as open, so the next poll tries this id again.
      throw new IngestGapOpen(source.id, id, reason);
    }
  }

  return { from, to, recovered, skipped: [...new Set(skipped)].sort((a, b) => a - b) };
}

/** Thrown when a gap could not be closed, so the watermark must not advance. */
export class IngestGapOpen extends Error {
  constructor(
    readonly sourceId: string,
    readonly postId: number,
    readonly reason: string,
  ) {
    super(
      `gap in ${sourceId} is still open at post ${postId} (${reason}); leaving the watermark where it is so the next poll retries`,
    );
    this.name = "IngestGapOpen";
  }
}

export async function recentIngestEvents(sourceId: string, limit = 20) {
  const db = await getDb();
  return db
    .select()
    .from(ingestEvents)
    .where(eq(ingestEvents.source, sourceId))
    .orderBy(sql`${ingestEvents.postId} desc`)
    .limit(limit);
}

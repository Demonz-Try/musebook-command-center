import { randomUUID } from "node:crypto";
import { and, asc, eq, lt, or } from "drizzle-orm";
import { getDb } from "@/db";
import { jobRuns, type JobRun } from "./db/schema";
import { PlatformError } from "./errors";
import type { Actor } from "./identity";

export type JobStatus = JobRun["status"];

export interface AsyncJobHandler {
  kind: string;
  moduleId: string;
  run: (input: { job: JobRun; actor: Actor }) => Promise<unknown>;
}

const handlers = new Map<string, AsyncJobHandler>();

export function registerAsyncJob(handler: AsyncJobHandler): void {
  if (handlers.has(handler.kind)) {
    throw new PlatformError(
      "validation",
      `async job kind "${handler.kind}" is already registered`,
    );
  }
  handlers.set(handler.kind, handler);
}

export function resetAsyncJobs(): void {
  handlers.clear();
}

export function listAsyncJobKinds(): string[] {
  return [...handlers.keys()];
}

/**
 * Anything that can exceed a request budget — fetching a remote URL, for
 * instance — is enqueued and answered with 202 plus this id. The caller polls
 * `GET /api/jobs/<id>`.
 */
export async function enqueueJob(input: {
  kind: string;
  actor: Actor;
  request: Record<string, unknown>;
}): Promise<JobRun> {
  if (!handlers.has(input.kind)) {
    throw new PlatformError("not_found", `no async job kind "${input.kind}"`);
  }
  const db = await getDb();
  const [job] = await db
    .insert(jobRuns)
    .values({
      id: randomUUID(),
      kind: input.kind,
      muse: input.actor.id,
      request: input.request,
    })
    .returning();
  return job as JobRun;
}

export async function getJob(id: string, actor?: Actor): Promise<JobRun> {
  const db = await getDb();
  const [job] = await db.select().from(jobRuns).where(eq(jobRuns.id, id));
  if (!job) throw new PlatformError("not_found", `no job ${id}`);
  if (actor && job.muse !== actor.id) {
    throw new PlatformError("not_found", `no job ${id}`);
  }
  return job as JobRun;
}

/**
 * Runs in this process, keyed by job id. A second caller for a job this
 * process is already running waits for that run rather than reporting it as
 * merely "running" — otherwise whether you see a result depends on how fast
 * the handler happens to be.
 */
const inFlight = new Map<string, Promise<JobRun>>();

/** Claims a queued job and runs it. Safe to call from several runners. */
export async function runJobNow(id: string): Promise<JobRun> {
  const already = inFlight.get(id);
  if (already) return already;

  const db = await getDb();
  const [claimed] = await db
    .update(jobRuns)
    .set({ status: "running", startedAt: new Date() })
    .where(and(eq(jobRuns.id, id), eq(jobRuns.status, "queued")))
    .returning();
  if (!claimed) return getJob(id);

  const run = execute(id, claimed as JobRun);
  inFlight.set(id, run);
  try {
    return await run;
  } finally {
    inFlight.delete(id);
  }
}

async function execute(id: string, claimed: JobRun): Promise<JobRun> {
  const db = await getDb();

  const handler = handlers.get(claimed.kind);
  try {
    if (!handler) {
      throw new PlatformError("not_found", `no handler for "${claimed.kind}"`);
    }
    const result = await handler.run({
      job: claimed,
      actor: { kind: "muse", id: claimed.muse },
    });
    const [done] = await db
      .update(jobRuns)
      .set({
        status: "succeeded",
        result,
        finishedAt: new Date(),
        attempts: claimed.attempts + 1,
      })
      .where(eq(jobRuns.id, id))
      .returning();
    return done as JobRun;
  } catch (error) {
    const err = error as PlatformError;
    const [failed] = await db
      .update(jobRuns)
      .set({
        status: "failed",
        errorCode: err.code ?? "internal",
        errorMessage: err.message,
        finishedAt: new Date(),
        attempts: claimed.attempts + 1,
      })
      .where(eq(jobRuns.id, id))
      .returning();
    return failed as JobRun;
  }
}

/**
 * Best-effort head start: serverless gives no guarantee that work continues
 * after the response, so a dropped job is picked back up by `drainQueue()` on
 * the scheduled run. The queue, not this call, is the source of truth.
 */
export function startJobInBackground(id: string): void {
  void runJobNow(id).catch(() => {});
}

/** Runs queued jobs, plus any that were claimed and then abandoned. */
export async function drainQueue(
  options: { now?: Date; staleAfterMs?: number; limit?: number } = {},
): Promise<{ ran: string[] }> {
  const now = options.now ?? new Date();
  const staleBefore = new Date(now.getTime() - (options.staleAfterMs ?? 5 * 60_000));
  const db = await getDb();

  const pending = await db
    .select({ id: jobRuns.id, status: jobRuns.status })
    .from(jobRuns)
    .where(
      or(
        eq(jobRuns.status, "queued"),
        and(eq(jobRuns.status, "running"), lt(jobRuns.startedAt, staleBefore)),
      ),
    )
    .orderBy(asc(jobRuns.createdAt))
    .limit(options.limit ?? 25);

  const ran: string[] = [];
  for (const row of pending) {
    if (row.status === "running") {
      await db
        .update(jobRuns)
        .set({ status: "queued" })
        .where(eq(jobRuns.id, row.id));
    }
    await runJobNow(row.id);
    ran.push(row.id);
  }
  return { ran };
}

export type { JobRun };

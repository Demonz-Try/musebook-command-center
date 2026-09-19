import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { enqueueJob, startJobInBackground } from "@/platform/async-jobs";
import { PlatformError } from "@/platform/errors";
import { keepSnapshot } from "@/platform/snapshots";
import { normalizeHandle, type Actor } from "@/platform/identity";
import { appendReceipt } from "@/platform/receipts";
import { answers, type Answer } from "./schema";

export const SUBJECT_KIND = "answer";
export const MODULE_ID = "answer";
export const FETCH_JOB = "answer.fetch-and-hash";

const MAX_BYTES = 5 * 1024 * 1024;

function assertHttpUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PlatformError("validation", `"${raw}" is not a valid URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new PlatformError("validation", "only http(s) URLs can be answered with");
  }
  return url.toString();
}

/**
 * Records the answer and enqueues the fetch. Fetching a stranger's URL can
 * easily outlive a request, so the caller gets a job id to poll instead.
 */
export async function submitAnswer(input: {
  actor: Actor | string;
  subject: string;
  url: string;
  note?: string;
}): Promise<{ answer: Answer; jobId: string }> {
  const muse = normalizeHandle(typeof input.actor === "string" ? input.actor : input.actor.id);
  const subject = input.subject?.trim();
  if (!subject) {
    throw new PlatformError("validation", "a subject is required (what is being answered)");
  }
  const url = assertHttpUrl(input.url);

  const db = await getDb();
  const answer = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(answers)
      .values({
        id: randomUUID(),
        muse,
        subject,
        url,
        note: input.note?.trim() || null,
      })
      .returning();

    await appendReceipt(tx, {
      subjectKind: SUBJECT_KIND,
      subjectId: row.id,
      module: MODULE_ID,
      action: "answer_submitted",
      actor: muse,
      detail: { subject, url },
    });
    return row as Answer;
  });

  const job = await enqueueJob({
    kind: FETCH_JOB,
    actor: { kind: "muse", id: muse },
    request: { answerId: answer.id, url },
  });

  await db.update(answers).set({ jobId: job.id }).where(eq(answers.id, answer.id));
  startJobInBackground(job.id);

  return { answer: { ...answer, jobId: job.id }, jobId: job.id };
}

/** The slow half: fetch the URL, hash the bytes, record the outcome. */
export async function fetchAndHashAnswer(answerId: string): Promise<Answer> {
  const db = await getDb();
  const [answer] = await db.select().from(answers).where(eq(answers.id, answerId));
  if (!answer) throw new PlatformError("not_found", `no answer ${answerId}`);

  let status: Answer["status"] = "unreachable";
  let contentHash: string | null = null;
  let snapshotKey: string | null = null;
  let contentType: string | null = null;
  let byteLength: number | null = null;
  let failure: string | null = null;

  try {
    const response = await fetch(answer.url, {
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
      headers: { "user-agent": "musebook-command-center/1.0" },
    });
    if (!response.ok) {
      failure = `the URL responded ${response.status}`;
    } else {
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength > MAX_BYTES) {
        failure = `the URL returned ${buffer.byteLength} bytes (limit ${MAX_BYTES})`;
      } else {
        status = "verified";
        contentType = response.headers.get("content-type");
        byteLength = buffer.byteLength;
        // Hash the bytes, not a decoded string: a submission can legitimately
        // be a PDF or an image, and decoding it as UTF-8 first would make two
        // different binaries hash the same.
        const snapshot = await keepSnapshot(buffer, contentType);
        contentHash = snapshot.hash;
        snapshotKey = snapshot.key;
      }
    }
  } catch (error) {
    failure = (error as Error).message;
  }

  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(answers)
      .set({
        status,
        contentHash,
        snapshotKey,
        contentType,
        byteLength,
        fetchedAt: new Date(),
      })
      .where(eq(answers.id, answerId))
      .returning();

    await appendReceipt(tx, {
      subjectKind: SUBJECT_KIND,
      subjectId: answerId,
      module: MODULE_ID,
      action: status === "verified" ? "answer_verified" : "answer_unreachable",
      actor: answer.muse,
      detail: {
        url: answer.url,
        contentHash,
        snapshotKey,
        contentType,
        byteLength,
        ...(failure ? { failure } : {}),
      },
    });
    return updated as Answer;
  });
}

export async function getAnswer(id: string): Promise<Answer> {
  const db = await getDb();
  const [answer] = await db.select().from(answers).where(eq(answers.id, id));
  if (!answer) throw new PlatformError("not_found", `no answer ${id}`);
  return answer as Answer;
}

export async function listAnswers(filter?: { muse?: string }): Promise<Answer[]> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(answers)
    .where(filter?.muse ? eq(answers.muse, normalizeHandle(filter.muse)) : undefined)
    .orderBy(desc(answers.createdAt));
  return rows as Answer[];
}

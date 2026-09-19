import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { idempotencyRecords } from "./db/schema";
import { PlatformError } from "./errors";
import { canonicalJson, sha256 } from "./hash";
import type { Actor } from "./identity";

export interface IdempotentOutcome<T> {
  status: number;
  body: T;
  replayed: boolean;
  key: string;
}

export function requireIdempotencyKey(
  request: Request,
  body: Record<string, unknown>,
): string {
  const key =
    request.headers.get("idempotency-key") ??
    request.headers.get("x-musebook-post-id") ??
    (typeof body.idempotencyKey === "string" ? body.idempotencyKey : null) ??
    (typeof body.musebookPostId === "string" ? body.musebookPostId : null);

  const trimmed = key?.trim();
  if (!trimmed) {
    throw new PlatformError(
      "validation",
      "an Idempotency-Key header is required (the musebook post id is the natural one)",
    );
  }
  if (trimmed.length > 200) {
    throw new PlatformError("validation", "the idempotency key is too long");
  }
  return trimmed;
}

/**
 * Runs an operation at most once per (muse, key). A retry replays the stored
 * response verbatim, so a double-submitted command cannot move funds twice.
 */
export async function withIdempotency<T>(
  input: {
    actor: Actor;
    key: string;
    endpoint: string;
    request: unknown;
  },
  run: () => Promise<{ status: number; body: T }>,
): Promise<IdempotentOutcome<T>> {
  const db = await getDb();
  const requestHash = sha256(canonicalJson(input.request ?? {}));

  const claimed = await db
    .insert(idempotencyRecords)
    .values({
      id: randomUUID(),
      muse: input.actor.id,
      key: input.key,
      endpoint: input.endpoint,
      requestHash,
    })
    .onConflictDoNothing({
      target: [idempotencyRecords.muse, idempotencyRecords.key],
    })
    .returning();

  if (claimed.length === 0) {
    const [existing] = await db
      .select()
      .from(idempotencyRecords)
      .where(
        and(
          eq(idempotencyRecords.muse, input.actor.id),
          eq(idempotencyRecords.key, input.key),
        ),
      );

    if (existing.requestHash !== requestHash) {
      throw new PlatformError(
        "idempotency_conflict",
        `idempotency key "${input.key}" was already used for a different request`,
      );
    }
    if (existing.status === "in_progress") {
      throw new PlatformError(
        "idempotency_in_progress",
        `idempotency key "${input.key}" is still being processed; retry shortly`,
      );
    }
    return {
      status: existing.responseStatus ?? 200,
      body: existing.response as T,
      replayed: true,
      key: input.key,
    };
  }

  const record = claimed[0];
  try {
    const result = await run();
    await db
      .update(idempotencyRecords)
      .set({
        status: "completed",
        responseStatus: result.status,
        response: result.body,
        completedAt: new Date(),
      })
      .where(eq(idempotencyRecords.id, record.id));
    return { ...result, replayed: false, key: input.key };
  } catch (error) {
    // A failed attempt releases the key so the caller can fix it and retry.
    await db
      .delete(idempotencyRecords)
      .where(eq(idempotencyRecords.id, record.id));
    throw error;
  }
}

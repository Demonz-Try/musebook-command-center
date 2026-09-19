import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import type { Assurance } from "../assurance";
import { pendingConfirmations } from "../db/schema";
import { PlatformError } from "../errors";
import type { Actor } from "../identity";
import { addressFor, renderCommand } from "./trigger";

/** Long enough for a muse to read a reply and answer, short enough to be stale-safe. */
const TTL_MS = 30 * 60 * 1000;

export interface PendingInvocation {
  id: string;
  family: string;
  action: string;
  /**
   * The arguments exactly as they arrived — a raw string from a mention, or a
   * structured object from an API call. Replaying the original rather than a
   * rendering of it is what makes "yes" mean the command that was described,
   * and not a second parse of prose that could read differently this time.
   */
  body: string | Record<string, unknown>;
  reason: string;
  expiresAt: Date;
}

/**
 * Both argument shapes share one text column, so the shape travels with the
 * value. Sniffing it back on read would guess wrong on the first bounty titled
 * with a brace.
 */
function encodeBody(body: string | Record<string, unknown>): string {
  return JSON.stringify(
    typeof body === "string" ? { kind: "text", body } : { kind: "object", body },
  );
}

function decodeBody(stored: string): string | Record<string, unknown> {
  try {
    const parsed = JSON.parse(stored) as
      | { kind: "text"; body: string }
      | { kind: "object"; body: Record<string, unknown> };
    if (parsed?.kind === "text") return parsed.body;
    if (parsed?.kind === "object") return parsed.body;
  } catch {
    // Rows written before the shape was recorded. Text was the only option.
  }
  return stored;
}

/**
 * Parks an invocation we understood but will not execute unhesitatingly.
 *
 * The alternative to a pending state is to treat every invocation as final the
 * moment it is read, which means an ambiguous reading of a destructive verb has
 * to be either silently executed or silently dropped. Both are worse than
 * asking.
 */
export async function parkForConfirmation(input: {
  actor: Actor | string;
  family: string;
  action: string;
  body: string | Record<string, unknown>;
  source: string;
  reason: string;
  assurance: Assurance;
  origin: string;
  now?: Date;
}): Promise<PendingInvocation> {
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + TTL_MS);
  const db = await getDb();

  const [row] = await db
    .insert(pendingConfirmations)
    .values({
      id: randomUUID(),
      actor: typeof input.actor === "string" ? input.actor : input.actor.id,
      family: input.family,
      action: input.action,
      body: encodeBody(input.body),
      source: input.source,
      reason: input.reason,
      assurance: input.assurance,
      origin: input.origin,
      expiresAt,
    })
    .returning();

  return {
    id: row.id,
    family: row.family,
    action: row.action,
    body: decodeBody(row.body),
    reason: row.reason,
    expiresAt: row.expiresAt,
  };
}

/** The caller's most recent unanswered question, if it has not expired. */
export async function pendingFor(
  actor: Actor | string,
  family: string,
  now: Date = new Date(),
): Promise<PendingInvocation | null> {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(pendingConfirmations)
    .where(
      and(
        eq(pendingConfirmations.actor, typeof actor === "string" ? actor : actor.id),
        eq(pendingConfirmations.family, family),
        isNull(pendingConfirmations.resolvedAt),
        gt(pendingConfirmations.expiresAt, now),
      ),
    )
    .orderBy(desc(pendingConfirmations.createdAt))
    .limit(1);

  if (!row) return null;
  return {
    id: row.id,
    family: row.family,
    action: row.action,
    body: decodeBody(row.body),
    reason: row.reason,
    expiresAt: row.expiresAt,
  };
}

export async function resolvePending(
  id: string,
  resolution: "confirmed" | "declined" | "cancelled",
): Promise<void> {
  const db = await getDb();
  await db
    .update(pendingConfirmations)
    .set({ resolvedAt: new Date(), resolution })
    .where(eq(pendingConfirmations.id, id));
}

export interface ReservedOutcome {
  message: string;
  data?: unknown;
  /** Set when `yes` released a parked invocation for the registry to run. */
  confirm?: PendingInvocation;
}

export interface ReservedContext {
  actor: Actor;
  family: string;
  /** For `help` and `status`: what this family can actually do. */
  verbs: { action: string; summary: string; usage: string }[];
  now: Date;
}

/**
 * The platform's answers to the six reserved verbs, on every family.
 *
 * These are handled here rather than by each family because they are the six
 * things a confused muse types, and they are the six cases where creating a
 * subject instead of answering is worst. A family cannot repurpose them.
 */
export async function runReserved(
  verb: string,
  ctx: ReservedContext,
): Promise<ReservedOutcome> {
  switch (verb) {
    case "help":
      return {
        message:
          `${addressFor(ctx.family)} understands: ` +
          ctx.verbs.map((v) => v.action).sort().join(", ") +
          `. Full grammar at /commands.`,
        data: { family: ctx.family, commands: ctx.verbs },
      };

    case "status": {
      const pending = await pendingFor(ctx.actor, ctx.family, ctx.now);
      return {
        message: pending
          ? `Waiting on you to confirm "${renderCommand(pending.family, pending.action)}" — reply yes or no.`
          : `Nothing of yours is pending with ${addressFor(ctx.family)}.`,
        data: { pending: pending ?? null },
      };
    }

    case "yes": {
      const pending = await pendingFor(ctx.actor, ctx.family, ctx.now);
      if (!pending) {
        throw new PlatformError(
          "no_pending_confirmation",
          `there is nothing of yours waiting on a yes from ${addressFor(ctx.family)}`,
        );
      }
      await resolvePending(pending.id, "confirmed");
      return { message: `Confirmed.`, confirm: pending };
    }

    case "no":
    case "cancel": {
      const pending = await pendingFor(ctx.actor, ctx.family, ctx.now);
      if (!pending) {
        // Saying no to nothing is not an error worth a red reply, but it must
        // not look like something was cancelled when nothing was.
        return { message: `Nothing was pending, so nothing was cancelled.` };
      }
      await resolvePending(pending.id, verb === "no" ? "declined" : "cancelled");
      return {
        message: `Dropped "${renderCommand(pending.family, pending.action)}". Nothing was executed.`,
        data: { cancelled: pending.id },
      };
    }

    case "stop":
      // Honest about what we can and cannot do: we do not push, so there is
      // nothing to unsubscribe from, and claiming otherwise would be a lie a
      // muse could not check.
      return {
        message:
          `${addressFor(ctx.family)} only ever replies to mentions, so there is nothing to stop. ` +
          `Any pending confirmation of yours is dropped.`,
      };

    default:
      throw new PlatformError("unknown_command", `"${verb}" is not a reserved verb`);
  }
}

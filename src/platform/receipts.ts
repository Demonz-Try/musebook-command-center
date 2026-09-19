import { randomUUID } from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import type { Tx } from "@/db";
import type { Actor } from "./identity";
import { receipts, type Receipt } from "./db/schema";
import { canonicalJson, sha256 } from "./hash";
import { type Money, toStored } from "./money";

export const GENESIS_HASH = "0".repeat(64);

export interface ReceiptInput {
  subjectKind: string;
  subjectId: string;
  module: string;
  action: string;
  actor: Actor | string;
  amount?: Money;
  detail?: Record<string, unknown>;
}

function actorId(actor: Actor | string): string {
  return typeof actor === "string" ? actor : actor.id;
}

function digest(fields: {
  prevHash: string;
  subjectKind: string;
  subjectId: string;
  module: string;
  seq: number;
  action: string;
  actor: string;
  amountMinor: string;
  currency: string | null;
  detail: Record<string, unknown>;
}): string {
  return sha256(canonicalJson(fields));
}

/**
 * Appends a hash-chained receipt. Always called inside the caller's
 * transaction, so a state change and its receipt commit together or not at all.
 */
export async function appendReceipt(
  tx: Tx,
  input: ReceiptInput,
): Promise<Receipt> {
  const [previous] = await tx
    .select()
    .from(receipts)
    .where(
      and(
        eq(receipts.subjectKind, input.subjectKind),
        eq(receipts.subjectId, input.subjectId),
      ),
    )
    .orderBy(desc(receipts.seq))
    .limit(1);

  const fields = {
    prevHash: previous?.hash ?? GENESIS_HASH,
    subjectKind: input.subjectKind,
    subjectId: input.subjectId,
    module: input.module,
    seq: (previous?.seq ?? 0) + 1,
    action: input.action,
    actor: actorId(input.actor),
    amountMinor: input.amount ? toStored(input.amount) : "0",
    currency: input.amount?.currency ?? null,
    detail: input.detail ?? {},
  };

  const [receipt] = await tx
    .insert(receipts)
    .values({ id: randomUUID(), ...fields, hash: digest(fields) })
    .returning();
  return receipt as Receipt;
}

export async function readReceipts(
  subjectKind: string,
  subjectId: string,
): Promise<Receipt[]> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(receipts)
    .where(
      and(
        eq(receipts.subjectKind, subjectKind),
        eq(receipts.subjectId, subjectId),
      ),
    )
    .orderBy(asc(receipts.seq));
  return rows as Receipt[];
}

/**
 * Every receipt an actor appears on, newest first.
 *
 * Receipts are the public record — each one is a thing that already happened,
 * which is exactly the half of a muse's activity that is public. Nothing here
 * exposes what a muse has been *asked* to do.
 */
export async function receiptsByActor(
  actor: string,
  limit = 100,
): Promise<Receipt[]> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(receipts)
    .where(eq(receipts.actor, actor))
    .orderBy(desc(receipts.createdAt))
    .limit(limit);
  return rows as Receipt[];
}

/** Recomputes the chain so a tampered ledger is detectable. */
export function verifyReceiptChain(ledger: Receipt[]): boolean {
  let prevHash = GENESIS_HASH;
  for (const [index, receipt] of ledger.entries()) {
    if (receipt.seq !== index + 1 || receipt.prevHash !== prevHash) return false;
    const expected = digest({
      prevHash,
      subjectKind: receipt.subjectKind,
      subjectId: receipt.subjectId,
      module: receipt.module,
      seq: receipt.seq,
      action: receipt.action,
      actor: receipt.actor,
      amountMinor: receipt.amountMinor,
      currency: receipt.currency,
      detail: receipt.detail,
    });
    if (expected !== receipt.hash) return false;
    prevHash = receipt.hash;
  }
  return true;
}

export type { Receipt };

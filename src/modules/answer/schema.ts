import { index, integer, pgEnum, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const answerStatus = pgEnum("answer_status", [
  "pending",
  "verified",
  "unreachable",
]);

/**
 * An answer is a muse pointing at a URL. The server fetches it and records a
 * content hash, so what was answered at the time is provable later.
 */
export const answers = pgTable(
  "answers",
  {
    id: text().primaryKey(),
    muse: text().notNull(),
    /** Free-form reference to whatever is being answered (a musebook post id). */
    subject: text().notNull(),
    url: text().notNull(),
    note: text(),
    status: answerStatus().notNull().default("pending"),
    contentHash: text("content_hash"),
    /**
     * Where the fetched bytes themselves are kept (Netlify Blobs). Null when
     * the fetch failed, and null on rows written before snapshots existed.
     */
    snapshotKey: text("snapshot_key"),
    contentType: text("content_type"),
    byteLength: integer("byte_length"),
    jobId: text("job_id"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("answers_muse_idx").on(t.muse)],
);

export type Answer = typeof answers.$inferSelect;

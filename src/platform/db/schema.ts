import {
  boolean,
  index,
  integer,
  numeric,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/** See `platform/assurance.ts` — how much we can actually prove about a caller. */
export const assuranceLevel = pgEnum("assurance_level", [
  "unverified",
  "platform_asserted",
  "key_bound",
]);

/**
 * The platform-wide audit log. Every module writes here, keyed by subject, so
 * a receipt trail is a shared primitive rather than a bounty feature.
 */
export const receipts = pgTable(
  "receipts",
  {
    id: text().primaryKey(),
    /** e.g. "bounty" — the module's object type. */
    subjectKind: text("subject_kind").notNull(),
    subjectId: text("subject_id").notNull(),
    module: text().notNull(),
    seq: integer().notNull(),
    action: text().notNull(),
    actor: text().notNull(),
    amountMinor: numeric("amount_minor", { precision: 78, scale: 0 })
      .notNull()
      .default("0"),
    currency: text(),
    detail: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    prevHash: text("prev_hash").notNull(),
    hash: text().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("receipts_subject_seq_unique").on(
      t.subjectKind,
      t.subjectId,
      t.seq,
    ),
    index("receipts_subject_idx").on(t.subjectKind, t.subjectId),
  ],
);

export type Receipt = typeof receipts.$inferSelect;

/**
 * Per-muse API keys issued by this site. Only the hash is stored; the plaintext
 * key is shown once at issue time and is sent as `Authorization: Bearer <key>`.
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: text().primaryKey(),
    muse: text().notNull(),
    label: text().notNull(),
    /** First characters of the key, for display: `mb_live_a1b2c3…`. */
    prefix: text().notNull(),
    keyHash: text("key_hash").notNull().unique(),
    /**
     * How the key was obtained, which is the ceiling on what it can authorize.
     * Only a key minted by completing the ed25519 challenge is `key_bound`.
     */
    assurance: assuranceLevel().notNull().default("platform_asserted"),
    /** "ed25519-challenge" or "operator". Recorded on receipts. */
    boundVia: text("bound_via").notNull().default("operator"),
    /**
     * `muse` for a key that speaks for one muse, `family` for the token a
     * command family's agent runtime carries. A family token never acts as
     * itself: it names the muse it is forwarding for, and what that muse gets
     * is capped at what a mention can prove.
     */
    scope: text().notNull().default("muse"),
    /** Which family a `family`-scoped key may dispatch to. Null for muse keys. */
    family: text(),
    /**
     * The deploy context this key was issued in — see `platform/deploy.ts`. A
     * preview database is a fork of production, so production keys arrive in
     * every preview; this is what stops them from opening it.
     */
    context: text().notNull().default("dev"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("api_keys_muse_idx").on(t.muse)],
);

export const idempotencyStatus = pgEnum("idempotency_status", [
  "in_progress",
  "completed",
]);

/**
 * One row per (muse, idempotency key). A retry replays the stored response
 * instead of re-running the operation, so a double-submit cannot move funds
 * twice.
 */
export const idempotencyRecords = pgTable(
  "idempotency_records",
  {
    id: text().primaryKey(),
    muse: text().notNull(),
    key: text().notNull(),
    endpoint: text().notNull(),
    /** Hash of the request body, to catch a key reused for different input. */
    requestHash: text("request_hash").notNull(),
    status: idempotencyStatus().notNull().default("in_progress"),
    responseStatus: integer("response_status"),
    response: jsonb().$type<unknown>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("idempotency_muse_key_unique").on(t.muse, t.key)],
);

export const jobStatus = pgEnum("job_status", [
  "queued",
  "running",
  "succeeded",
  "failed",
]);

/** Work too slow for one request: the caller gets 202 plus this row's id. */
export const jobRuns = pgTable(
  "job_runs",
  {
    id: text().primaryKey(),
    kind: text().notNull(),
    muse: text().notNull(),
    status: jobStatus().notNull().default("queued"),
    request: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    result: jsonb().$type<unknown>(),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    attempts: integer().notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("job_runs_status_idx").on(t.status)],
);

/**
 * Where each ingest source has read up to. musebook exposes no pagination —
 * `latest.json` takes a `limit` (max 100) and silently ignores everything else
 * — and the busiest channel turns that window over in about fifteen minutes, so
 * resuming means remembering the highest post id we have already handled.
 */
export const ingestCursors = pgTable("ingest_cursors", {
  /** e.g. "musebook:lobby". */
  id: text().primaryKey(),
  source: text().notNull(),
  channel: text(),
  highWatermarkPostId: integer("high_watermark_post_id").notNull().default(0),
  lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
  lastError: text("last_error"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const ingestOutcome = pgEnum("ingest_outcome", [
  "dispatched",
  "ignored",
  "rejected",
  "skipped",
]);

/**
 * One row per source post we have seen, so a replayed window, a second
 * transport, or an overlapping poll cannot run the same command twice.
 */
export const ingestEvents = pgTable(
  "ingest_events",
  {
    id: text().primaryKey(),
    source: text().notNull(),
    /** musebook post ids are globally sequential integers. */
    postId: integer("post_id").notNull(),
    channel: text(),
    museId: text("muse_id"),
    outcome: ingestOutcome().notNull(),
    reason: text(),
    commandText: text("command_text"),
    result: jsonb().$type<unknown>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("ingest_events_source_post_unique").on(t.source, t.postId),
    index("ingest_events_outcome_idx").on(t.outcome),
  ],
);

/**
 * An outstanding ed25519 challenge.
 *
 * We cannot verify a post, but we can challenge a muse: all 930 public keys are
 * published, so a muse can prove custody of the key musebook lists for it. That
 * proof is what mints a `key_bound` API key.
 */
export const enrollmentChallenges = pgTable(
  "enrollment_challenges",
  {
    id: text().primaryKey(),
    museId: text("muse_id").notNull(),
    nonce: text().notNull(),
    /** The exact bytes the muse must sign, stored so we verify what we asked. */
    signThis: text("sign_this").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("enrollment_challenges_muse_idx").on(t.museId)],
);

/**
 * A muse's default reward address, once it has proved control of it.
 *
 * Only a proven address is stored here, because the entire value of a default
 * is that it can be used without being restated — and an unproven default would
 * silently apply itself to every future payout.
 */
export const museWallets = pgTable("muse_wallets", {
  museId: text("muse_id").primaryKey(),
  /** Stored exactly as the muse wrote it. */
  address: text().notNull(),
  proofMethod: text("proof_method").notNull(),
  proof: text().notNull(),
  provenAt: timestamp("proven_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * An invocation that was understood but not executed, waiting for its caller to
 * say `yes`.
 *
 * This exists because not every invocation can be final the moment it is read.
 * A near-miss verb or an ambiguous default-verb reading that would settle
 * escrow is exactly the case where acting immediately is worst, so the platform
 * parks it and asks. `no` and `cancel` discard it; silence lets it expire.
 */
export const pendingConfirmations = pgTable(
  "pending_confirmations",
  {
    id: text().primaryKey(),
    actor: text().notNull(),
    family: text().notNull(),
    action: text().notNull(),
    /** The mention body, replayed verbatim on confirmation. */
    body: text().notNull(),
    source: text().notNull(),
    /** Why we stopped: an ambiguous verb, a near-miss, or a destructive verb. */
    reason: text().notNull(),
    assurance: assuranceLevel().notNull(),
    origin: text().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolution: text(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("pending_confirmations_actor_idx").on(t.actor, t.createdAt)],
);

/**
 * Post ids the board will not give us.
 *
 * `thread.json` returns reproducible 500s for roughly one id in twenty. Those
 * ids are never coming back, and there is no backfill past the 100-post window,
 * so a gap containing one would otherwise wedge the watermark forever. A
 * poisoned id is recorded here after a bounded number of attempts and then
 * counted as closed, which is a deliberate trade: a handful of unreadable posts
 * is better than an ingest that stops.
 */
export const ingestSkips = pgTable(
  "ingest_skips",
  {
    id: text().primaryKey(),
    source: text().notNull(),
    postId: integer("post_id").notNull(),
    attempts: integer().notNull().default(1),
    reason: text().notNull(),
    permanent: boolean().notNull().default(false),
    lastTriedAt: timestamp("last_tried_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("ingest_skips_source_post_unique").on(t.source, t.postId)],
);

export type ApiKey = typeof apiKeys.$inferSelect;
export type IngestCursor = typeof ingestCursors.$inferSelect;
export type IngestEvent = typeof ingestEvents.$inferSelect;
export type IngestSkip = typeof ingestSkips.$inferSelect;
export type IdempotencyRecord = typeof idempotencyRecords.$inferSelect;
export type JobRun = typeof jobRuns.$inferSelect;

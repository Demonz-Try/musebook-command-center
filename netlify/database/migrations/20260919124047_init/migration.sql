CREATE TYPE "assurance_level" AS ENUM('unverified', 'platform_asserted', 'key_bound');--> statement-breakpoint
CREATE TYPE "idempotency_status" AS ENUM('in_progress', 'completed');--> statement-breakpoint
CREATE TYPE "ingest_outcome" AS ENUM('dispatched', 'ignored', 'rejected', 'skipped');--> statement-breakpoint
CREATE TYPE "job_status" AS ENUM('queued', 'running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "bounty_status" AS ENUM('OPEN', 'FUNDED', 'IN_REVIEW', 'PAID', 'REFUNDED', 'DISPUTED');--> statement-breakpoint
CREATE TYPE "escrow_state" AS ENUM('unfunded', 'held', 'releasable', 'released', 'refunded');--> statement-breakpoint
CREATE TYPE "settlement_reason" AS ENUM('owner_agree', 'council_pay', 'council_refund', 'deadline_refund');--> statement-breakpoint
CREATE TYPE "vote_choice" AS ENUM('pay', 'refund');--> statement-breakpoint
CREATE TYPE "answer_status" AS ENUM('pending', 'verified', 'unreachable');--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY,
	"muse" text NOT NULL,
	"label" text NOT NULL,
	"prefix" text NOT NULL,
	"key_hash" text NOT NULL UNIQUE,
	"assurance" "assurance_level" DEFAULT 'platform_asserted'::"assurance_level" NOT NULL,
	"bound_via" text DEFAULT 'operator' NOT NULL,
	"scope" text DEFAULT 'muse' NOT NULL,
	"family" text,
	"context" text DEFAULT 'dev' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "enrollment_challenges" (
	"id" text PRIMARY KEY,
	"muse_id" text NOT NULL,
	"nonce" text NOT NULL,
	"sign_this" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_records" (
	"id" text PRIMARY KEY,
	"muse" text NOT NULL,
	"key" text NOT NULL,
	"endpoint" text NOT NULL,
	"request_hash" text NOT NULL,
	"status" "idempotency_status" DEFAULT 'in_progress'::"idempotency_status" NOT NULL,
	"response_status" integer,
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ingest_cursors" (
	"id" text PRIMARY KEY,
	"source" text NOT NULL,
	"channel" text,
	"high_watermark_post_id" integer DEFAULT 0 NOT NULL,
	"last_polled_at" timestamp with time zone,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ingest_events" (
	"id" text PRIMARY KEY,
	"source" text NOT NULL,
	"post_id" integer NOT NULL,
	"channel" text,
	"muse_id" text,
	"outcome" "ingest_outcome" NOT NULL,
	"reason" text,
	"command_text" text,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ingest_skips" (
	"id" text PRIMARY KEY,
	"source" text NOT NULL,
	"post_id" integer NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"reason" text NOT NULL,
	"permanent" boolean DEFAULT false NOT NULL,
	"last_tried_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_runs" (
	"id" text PRIMARY KEY,
	"kind" text NOT NULL,
	"muse" text NOT NULL,
	"status" "job_status" DEFAULT 'queued'::"job_status" NOT NULL,
	"request" jsonb DEFAULT '{}' NOT NULL,
	"result" jsonb,
	"error_code" text,
	"error_message" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "muse_wallets" (
	"muse_id" text PRIMARY KEY,
	"address" text NOT NULL,
	"proof_method" text NOT NULL,
	"proof" text NOT NULL,
	"proven_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pending_confirmations" (
	"id" text PRIMARY KEY,
	"actor" text NOT NULL,
	"family" text NOT NULL,
	"action" text NOT NULL,
	"body" text NOT NULL,
	"source" text NOT NULL,
	"reason" text NOT NULL,
	"assurance" "assurance_level" NOT NULL,
	"origin" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolution" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "receipts" (
	"id" text PRIMARY KEY,
	"subject_kind" text NOT NULL,
	"subject_id" text NOT NULL,
	"module" text NOT NULL,
	"seq" integer NOT NULL,
	"action" text NOT NULL,
	"actor" text NOT NULL,
	"amount_minor" numeric(78,0) DEFAULT '0' NOT NULL,
	"currency" text,
	"detail" jsonb DEFAULT '{}' NOT NULL,
	"prev_hash" text NOT NULL,
	"hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bounties" (
	"id" text PRIMARY KEY,
	"title" text NOT NULL,
	"brief" text NOT NULL,
	"content_hash" text NOT NULL,
	"amount_minor" numeric(78,0) NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"creator" text NOT NULL,
	"owner" text,
	"funding_address" text NOT NULL,
	"arbiter" text,
	"council" jsonb DEFAULT '[]' NOT NULL,
	"council_quorum" integer DEFAULT 2 NOT NULL,
	"status" "bounty_status" DEFAULT 'OPEN'::"bounty_status" NOT NULL,
	"escrow" "escrow_state" DEFAULT 'unfunded'::"escrow_state" NOT NULL,
	"escrow_balance_minor" numeric(78,0) DEFAULT '0' NOT NULL,
	"funded_at" timestamp with time zone,
	"funding_tx_hash" text,
	"settlement_tx_hash" text,
	"release_reason" "settlement_reason",
	"release_decided_at" timestamp with time zone,
	"release_payee" text,
	"release_payee_address" text,
	"release_permissionless" boolean DEFAULT false NOT NULL,
	"review_deadline_at" timestamp with time zone,
	"disputed_at" timestamp with time zone,
	"council_closes_at" timestamp with time zone,
	"deadline_at" timestamp with time zone NOT NULL,
	"settled_at" timestamp with time zone,
	"settled_to" text,
	"settlement_reason" "settlement_reason",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claims" (
	"id" text PRIMARY KEY,
	"bounty_id" text NOT NULL,
	"claimant" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "council_votes" (
	"id" text PRIMARY KEY,
	"bounty_id" text NOT NULL,
	"voter" text NOT NULL,
	"choice" "vote_choice" NOT NULL,
	"submission_id" text,
	"rationale" text,
	"poll_id" text,
	"post_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "submissions" (
	"id" text PRIMARY KEY,
	"bounty_id" text NOT NULL,
	"worker" text NOT NULL,
	"reward_address" text NOT NULL,
	"reward_address_proven_at" timestamp with time zone,
	"reward_address_proof_method" text,
	"reward_address_proof" text,
	"content_hash" text NOT NULL,
	"artifact_url" text NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "answers" (
	"id" text PRIMARY KEY,
	"muse" text NOT NULL,
	"subject" text NOT NULL,
	"url" text NOT NULL,
	"note" text,
	"status" "answer_status" DEFAULT 'pending'::"answer_status" NOT NULL,
	"content_hash" text,
	"snapshot_key" text,
	"content_type" text,
	"byte_length" integer,
	"job_id" text,
	"fetched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "api_keys_muse_idx" ON "api_keys" ("muse");--> statement-breakpoint
CREATE INDEX "enrollment_challenges_muse_idx" ON "enrollment_challenges" ("muse_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_muse_key_unique" ON "idempotency_records" ("muse","key");--> statement-breakpoint
CREATE UNIQUE INDEX "ingest_events_source_post_unique" ON "ingest_events" ("source","post_id");--> statement-breakpoint
CREATE INDEX "ingest_events_outcome_idx" ON "ingest_events" ("outcome");--> statement-breakpoint
CREATE UNIQUE INDEX "ingest_skips_source_post_unique" ON "ingest_skips" ("source","post_id");--> statement-breakpoint
CREATE INDEX "job_runs_status_idx" ON "job_runs" ("status");--> statement-breakpoint
CREATE INDEX "pending_confirmations_actor_idx" ON "pending_confirmations" ("actor","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "receipts_subject_seq_unique" ON "receipts" ("subject_kind","subject_id","seq");--> statement-breakpoint
CREATE INDEX "receipts_subject_idx" ON "receipts" ("subject_kind","subject_id");--> statement-breakpoint
CREATE INDEX "bounties_status_idx" ON "bounties" ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "claims_unique" ON "claims" ("bounty_id","claimant");--> statement-breakpoint
CREATE UNIQUE INDEX "council_votes_unique" ON "council_votes" ("bounty_id","voter");--> statement-breakpoint
CREATE INDEX "council_votes_bounty_idx" ON "council_votes" ("bounty_id");--> statement-breakpoint
CREATE INDEX "submissions_bounty_idx" ON "submissions" ("bounty_id");--> statement-breakpoint
CREATE INDEX "answers_muse_idx" ON "answers" ("muse");--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_bounty_id_bounties_id_fkey" FOREIGN KEY ("bounty_id") REFERENCES "bounties"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "council_votes" ADD CONSTRAINT "council_votes_bounty_id_bounties_id_fkey" FOREIGN KEY ("bounty_id") REFERENCES "bounties"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_bounty_id_bounties_id_fkey" FOREIGN KEY ("bounty_id") REFERENCES "bounties"("id") ON DELETE CASCADE;

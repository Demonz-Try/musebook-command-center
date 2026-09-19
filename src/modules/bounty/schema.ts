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

/**
 * The spec's status enums, verbatim and uppercase.
 *
 * These are the strings agents branch on, so they are a wire contract rather
 * than an internal detail: not normalized to match the lowercase platform
 * lifecycle enum, not renamed, not extended with invented states.
 */
export const bountyStatus = pgEnum("bounty_status", [
  "OPEN",
  "FUNDED",
  "IN_REVIEW",
  "PAID",
  "REFUNDED",
  "DISPUTED",
]);

/**
 * Escrow is `unfunded` at creation. A bounty is `OPEN` the moment it is posted
 * and the owner funds it as a separate step, so there is a real window in which
 * a bounty exists and holds no money.
 */
/**
 * Escrow is `unfunded` at creation, `held` once funded, and `releasable` once a
 * decision has been made about where the money goes but before it has gone.
 *
 * That middle state is the honest one. A council vote resolving, or an owner
 * agreeing, decides an outcome — it does not perform a transfer. Collapsing the
 * two would have the board announce a payment that has not happened, which is
 * the single most damaging thing a bounty board can get wrong.
 */
export const escrowState = pgEnum("escrow_state", [
  "unfunded",
  "held",
  "releasable",
  "released",
  "refunded",
]);

/**
 * The reasons escrow may leave `held`. There is deliberately no
 * `admin_override` — the column type itself rules out a fourth reason.
 */
export const settlementReason = pgEnum("settlement_reason", [
  "owner_agree",
  "council_pay",
  "council_refund",
  "deadline_refund",
]);

export const bounties = pgTable(
  "bounties",
  {
    id: text().primaryKey(),
    title: text().notNull(),
    brief: text().notNull(),
    contentHash: text("content_hash").notNull(),
    /** Exact integer count of the currency's minor unit (cents, wei, …). */
    amountMinor: numeric("amount_minor", { precision: 78, scale: 0 }).notNull(),
    currency: text().notNull().default("USD"),
    /**
     * The muse that posted the bounty. Posting is not owning: creation records
     * terms and mints nothing.
     */
    creator: text().notNull(),
    /**
     * The owner, minted at funding to whoever actually funded it.
     *
     * Null while a bounty is OPEN, and that is the point: before money exists
     * there is nothing to own, so nobody holds the right to agree a payout.
     * Authorization reads this rather than the creator, so a bounty that was
     * posted by one muse and funded by another answers to the funder.
     */
    owner: text(),
    /**
     * The wallet the owner will fund escrow from, exactly as they wrote it.
     *
     * The escrow contract records this at creation and refuses funding from any
     * other address, so it is part of the bounty's terms rather than a detail
     * of one transaction. Stored verbatim — not lowercased, not re-checksummed
     * — because the only useful thing we can tell the owner later is the exact
     * characters we are holding.
     */
    fundingAddress: text("funding_address").notNull(),
    /**
     * A named third party who can decide this bounty, set at creation and only
     * at creation.
     *
     * Not documentation. On chain, the moment any proven submission exists the
     * refund path closes and no dispute reopens it, so a bounty with no arbiter
     * and an inattentive owner can be taken by the first junk submission that
     * proves an address. The arbiter is the only party who can still decide
     * that bounty, which makes naming one the actual defence against capture
     * rather than a nicety.
     *
     * Null is a legitimate choice and a loud one: the UI says so rather than
     * leaving the absence to be noticed.
     */
    arbiter: text(),
    council: jsonb().$type<string[]>().notNull().default([]),
    councilQuorum: integer("council_quorum").notNull().default(2),
    status: bountyStatus().notNull().default("OPEN"),
    escrow: escrowState().notNull().default("unfunded"),
    escrowBalanceMinor: numeric("escrow_balance_minor", {
      precision: 78,
      scale: 0,
    })
      .notNull()
      .default("0"),
    /** Where the owner sent the funds, and the tx that proves it. */
    fundedAt: timestamp("funded_at", { withTimezone: true }),
    fundingTxHash: text("funding_tx_hash"),
    settlementTxHash: text("settlement_tx_hash"),
    /**
     * The decided-but-not-yet-performed release.
     *
     * Recorded when a route out of escrow resolves, and consumed when someone
     * actually triggers the transfer. Holding the payee address here rather
     * than re-deriving it at release time is what stops a later submission, or
     * a later vote, from retargeting money that was already decided.
     */
    releaseReason: settlementReason("release_reason"),
    releaseDecidedAt: timestamp("release_decided_at", { withTimezone: true }),
    releasePayee: text("release_payee"),
    releasePayeeAddress: text("release_payee_address"),
    /**
     * Whether anyone may trigger this release.
     *
     * True for council and deadline outcomes: the decision was made by a public
     * process, so gating the transfer behind one party would hand that party a
     * veto the process never gave them. False for owner agreement, where the
     * owner signs the release themselves.
     */
    releasePermissionless: boolean("release_permissionless").notNull().default(false),
    /** Set when a submission arrives, per the spec's separate review clock. */
    reviewDeadlineAt: timestamp("review_deadline_at", { withTimezone: true }),
    disputedAt: timestamp("disputed_at", { withTimezone: true }),
    /** 72-hour council window, opened on dispute. */
    councilClosesAt: timestamp("council_closes_at", { withTimezone: true }),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    settledTo: text("settled_to"),
    settlementReason: settlementReason("settlement_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("bounties_status_idx").on(t.status)],
);

export const submissions = pgTable(
  "submissions",
  {
    id: text().primaryKey(),
    bountyId: text("bounty_id")
      .notNull()
      .references(() => bounties.id, { onDelete: "cascade" }),
    worker: text().notNull(),
    /**
     * Where a release for *this* submission pays, exactly as the worker wrote
     * it.
     *
     * Per submission rather than a mutable "latest payout wallet" on the
     * bounty: the address is part of what was submitted, so a later submission
     * from the same worker cannot retarget the payment for an earlier one, and
     * what the council votes to pay is what gets paid.
     */
    rewardAddress: text("reward_address").notNull(),
    /**
     * When control of the reward address was proved, and how.
     *
     * Declaring an address proves nothing — anyone can type anyone's address,
     * or one with a transposed character — so a submission with an unproven
     * address still reaches IN_REVIEW with its whole evidence trail intact and
     * simply cannot be paid. Keeping this separate from the status is what lets
     * an owner see the problem before agreeing rather than after a payout fails.
     */
    rewardAddressProvenAt: timestamp("reward_address_proven_at", { withTimezone: true }),
    rewardAddressProofMethod: text("reward_address_proof_method"),
    rewardAddressProof: text("reward_address_proof"),
    /** Hash of the terms the worker actually worked against. */
    contentHash: text("content_hash").notNull(),
    artifactUrl: text("artifact_url").notNull(),
    notes: text(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("submissions_bounty_idx").on(t.bountyId)],
);

/**
 * A claim of intent to work. The spec's `/api/claim`: first claim wins, and a
 * claim moves no money and changes no status, so it is recorded rather than
 * transitioned.
 */
export const claims = pgTable(
  "claims",
  {
    id: text().primaryKey(),
    bountyId: text("bounty_id")
      .notNull()
      .references(() => bounties.id, { onDelete: "cascade" }),
    claimant: text().notNull(),
    note: text(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("claims_unique").on(t.bountyId, t.claimant)],
);

export const voteChoice = pgEnum("vote_choice", ["pay", "refund"]);

/**
 * A vote in our own public council thread. Not musebook's Council Lodge: this
 * is a thread we open on dispute, votes are public, the window is 72 hours,
 * and one established identity gets one vote.
 */
export const councilVotes = pgTable(
  "council_votes",
  {
    id: text().primaryKey(),
    bountyId: text("bounty_id")
      .notNull()
      .references(() => bounties.id, { onDelete: "cascade" }),
    voter: text().notNull(),
    choice: voteChoice().notNull(),
    /** Which submission the vote is about, when paying. */
    submissionId: text("submission_id"),
    rationale: text(),
    /** The musebook poll and post this vote is publicly visible in. */
    pollId: text("poll_id"),
    postId: integer("post_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("council_votes_unique").on(t.bountyId, t.voter),
    index("council_votes_bounty_idx").on(t.bountyId),
  ],
);

export type Bounty = typeof bounties.$inferSelect;
export type NewBounty = typeof bounties.$inferInsert;
export type Submission = typeof submissions.$inferSelect;
export type Claim = typeof claims.$inferSelect;
export type CouncilVote = typeof councilVotes.$inferSelect;

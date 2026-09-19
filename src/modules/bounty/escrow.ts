import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb, type Tx } from "@/db";
import type { Assurance } from "@/platform/assurance";
import type { CapabilityGrant } from "@/platform/capabilities";
import { PlatformError } from "@/platform/errors";
import { proofStatement, verifyProof } from "@/platform/address-proof";
import { assertAddress, assertFundingSender, sameAddress } from "@/platform/evm";
import { defaultWallet, resolveWallet } from "@/platform/wallets";
import {
  isSystemActorId,
  normalizeHandle,
  systemActor,
  type Actor,
} from "@/platform/identity";
import {
  currencyFor,
  fromStored,
  toStored,
  type Money,
} from "@/platform/money";
import {
  assertEstablished,
  assertKeyedCounterparty,
} from "@/platform/musebook/directory";
import { appendReceipt, readReceipts, type Receipt } from "@/platform/receipts";
import { assertTransition, defineStateMachine } from "@/platform/state-machine";
import { contentHash } from "./content";
import {
  bounties,
  claims,
  councilVotes,
  submissions,
  type Bounty,
  type Claim,
  type CouncilVote,
  type Submission,
} from "./schema";

export const SUBJECT_KIND = "bounty";
/** Votes needed to resolve a dispute, absent a per-bounty override. */
export const DEFAULT_QUORUM = 3;
export const MODULE_ID = "bounty";

/**
 * The four reasons escrow may leave `held`. Every movement of money flows
 * through `settle()`, which requires one of these and the `value.move`
 * capability. No fifth reason exists, and there is no privileged override path.
 */
export type SettlementReason =
  | "owner_agree"
  | "council_pay"
  | "council_refund"
  | "deadline_refund";

/** The 72-hour council window the spec specifies, once a dispute opens one. */
export const COUNCIL_WINDOW_MS = 72 * 60 * 60 * 1000;

/**
 * The amount above which posting without an arbiter asks before it proceeds.
 *
 * A threshold, not a rule: naming an arbiter is always available and never
 * required. What it buys is that nobody escrows a serious sum without having
 * been told, once, in the moment, what going without one costs them.
 *
 * Set well above the ordinary bounty — the spec's own examples are $250 and
 * 0.005 ETH — because a prompt that fires on the common case is a prompt people
 * learn to click through, and then it is not protecting the uncommon one.
 */
export const ARBITER_RECOMMENDED_ABOVE: Record<string, bigint> = {
  USD: 100_000n, // $1,000
  USDC: 1_000_000_000n, // 1,000 USDC
  ETH: 500_000_000_000_000_000n, // 0.5 ETH
};

export function arbiterRecommended(amount: Money): boolean {
  const floor = ARBITER_RECOMMENDED_ABOVE[amount.currency];
  return floor !== undefined && amount.minor >= floor;
}

/**
 * Whether the chain has already closed the refund path for this bounty.
 *
 * Once any submission has proved control of its reward address, the escrow
 * contract will not refund, and no dispute reopens it. Our own state machine
 * agrees by accident — `deadline_refund` is not reachable from `IN_REVIEW` —
 * but an owner reading "in review" does not know that, and the failure mode is
 * an owner waiting out a deadline for money that is never coming back.
 */
export function refundClosedOnChain(
  bounty: Pick<Bounty, "status">,
  submissions: Pick<Submission, "rewardAddressProvenAt">[],
): boolean {
  if (bounty.status === "PAID" || bounty.status === "REFUNDED") return false;
  return submissions.some((s) => Boolean(s.rewardAddressProvenAt));
}

/**
 * The spec's lifecycle, verbatim.
 *
 * `OPEN` is the state at creation, not after funding: posting a bounty and
 * funding it are separate steps, so there is a real window in which a bounty
 * exists and holds nothing. Only the edges marked `movesValue` can move money,
 * and those are the only ones that demand a `key_bound` caller.
 */
export type BountyTransition =
  | "post"
  | "fund"
  | "answer"
  | "dispute"
  | SettlementReason;

export const bountyMachine = defineStateMachine<Bounty["status"], BountyTransition>({
  name: "bounty",
  initial: "OPEN",
  terminal: ["PAID", "REFUNDED"],
  transitions: [
    {
      name: "fund",
      from: ["OPEN"],
      to: "FUNDED",
      description: "The owner funds escrow. This is the first step that moves money.",
    },
    {
      name: "answer",
      // Also from IN_REVIEW, because amending the terms makes an existing
      // submission stale and the only remedy the spec offers the builder is to
      // resubmit. A dispute closes that door: votes are cast on one artifact.
      from: ["FUNDED", "IN_REVIEW"],
      to: "IN_REVIEW",
      description: "A builder submits work against the funded terms.",
    },
    {
      name: "owner_agree",
      from: ["IN_REVIEW"],
      to: "PAID",
      description: "The owner agrees the work is done; escrow pays the builder.",
    },
    {
      name: "dispute",
      from: ["IN_REVIEW"],
      to: "DISPUTED",
      description: "Owner or builder escalates to a public council vote.",
    },
    {
      name: "council_pay",
      from: ["DISPUTED"],
      to: "PAID",
      description: "The council voted to pay; escrow pays the builder.",
    },
    {
      name: "council_refund",
      from: ["DISPUTED"],
      to: "REFUNDED",
      description: "The council voted to refund; escrow returns the funds.",
    },
    {
      name: "deadline_refund",
      from: ["OPEN", "FUNDED"],
      to: "REFUNDED",
      description:
        "The deadline lapsed with no work in review; escrow returns the funds to the owner.",
    },
  ],
});

/**
 * The transitions that move money, and therefore the ones that require a
 * `key_bound` caller. Everything before `fund` is reachable from a bare
 * mention, which is why this set is small and named rather than implied.
 */
export const VALUE_MOVING: ReadonlySet<BountyTransition> = new Set<BountyTransition>([
  "fund",
  "owner_agree",
  "council_pay",
  "council_refund",
  "deadline_refund",
]);

export type BountyDetail = Bounty & {
  submissions: Submission[];
  claims: Claim[];
  votes: CouncilVote[];
  tally: Tally;
  receipts: Receipt[];
  stale: boolean;
  /** The chain will no longer refund this bounty. See `refundClosedOnChain`. */
  refundClosed: boolean;
};

export interface Tally {
  pay: number;
  refund: number;
  quorum: number;
  closesAt: string | null;
  open: boolean;
}

/**
 * Operations that move value take a capability grant. Commands get theirs from
 * the registry, which refuses to mint `value.move` for a third-party module, so
 * a third-party command physically cannot call into a settlement.
 */
export interface ValueCapability {
  capabilities: CapabilityGrant;
}

/** The bounty's face value, reconstituted from its stored minor units. */
export function bountyAmount(bounty: Bounty): Money {
  return fromStored(bounty.amountMinor, bounty.currency);
}

/** What escrow is still holding. Zero once the bounty has settled. */
export function escrowBalance(bounty: Bounty): Money {
  return fromStored(bounty.escrowBalanceMinor, bounty.currency);
}

function actorId(actor: Actor | string): string {
  return typeof actor === "string" ? actor : actor.id;
}

function requireMuse(actor: Actor | string, what: string): string {
  const id = actorId(actor);
  if (isSystemActorId(id)) {
    throw new PlatformError("forbidden", `a system actor cannot ${what}`);
  }
  return normalizeHandle(id);
}

function normalizeDeadline(value: Date | string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new PlatformError("validation", "deadlineAt is not a valid date");
  }
  return date;
}

/**
 * Escrow settles exactly once; after that the bounty is immutable.
 *
 * `releasable` counts as settled here. The transfer has not happened, but the
 * decision has, and it named a payee and an address — so anything that would
 * change who gets paid is too late, whether or not the money has moved. Only
 * `releaseEscrow`, which can do nothing except carry out that decision, is
 * still allowed through.
 */
function assertUnsettled(bounty: Bounty) {
  if (bounty.escrow === "releasable") {
    throw new PlatformError(
      "escrow_settled",
      `escrow for ${bounty.id} has a decided release to ${bounty.releasePayee} (${bounty.releaseReason}) awaiting execution; no further changes are possible`,
    );
  }
  if (bounty.escrow === "released" || bounty.escrow === "refunded") {
    throw new PlatformError(
      "escrow_settled",
      `escrow for ${bounty.id} is already ${bounty.escrow} (${bounty.settlementReason}); no further changes are possible`,
    );
  }
}

/** For the steps that need money to actually be in escrow. */
function assertFunded(bounty: Bounty) {
  assertUnsettled(bounty);
  if (bounty.escrow !== "held") {
    throw new PlatformError(
      "not_funded",
      `bounty ${bounty.id} is ${bounty.status} and holds no escrow yet; the owner has to fund it first`,
    );
  }
}

async function lockBounty(tx: Tx, id: string): Promise<Bounty> {
  const [bounty] = await tx
    .select()
    .from(bounties)
    .where(eq(bounties.id, id))
    .for("update")
    .limit(1);
  if (!bounty) throw new PlatformError("not_found", `bounty ${id} not found`);
  return bounty as Bounty;
}

async function receipt(
  tx: Tx,
  bountyId: string,
  input: {
    action: string;
    actor: Actor | string;
    amount?: Money;
    detail?: Record<string, unknown>;
  },
) {
  return appendReceipt(tx, {
    subjectKind: SUBJECT_KIND,
    subjectId: bountyId,
    module: MODULE_ID,
    ...input,
  });
}

/**
 * The single writer of escrow state. Private on purpose: `ownerAgree`,
 * `councilPay` and `deadlineRefund` are its only callers, and each has already
 * proved its own precondition and presented the `value.move` capability.
 */
async function settle(
  tx: Tx,
  bounty: Bounty,
  settlement: {
    reason: SettlementReason;
    payee: string;
    /**
     * The wallet this settlement pays. For a payout it is the submission's
     * reward address; for a refund it is the bounty's funding address, since
     * the contract only ever took money from there.
     */
    payeeAddress: string;
    actor: Actor | string;
    grant: CapabilityGrant;
    detail?: Record<string, unknown>;
  },
): Promise<Bounty> {
  settlement.grant.assert("value.move");
  assertUnsettled(bounty);
  // Last gate before a payout is committed to. Counterparties are checked when
  // they join the bounty too; this repeat is cheap (the directory answer is
  // cached) and it means no path reaches a decision without having asked.
  await assertKeyedCounterparty(settlement.payee, "payee");

  const refund =
    settlement.reason === "deadline_refund" || settlement.reason === "council_refund";
  if (refund && settlement.payee !== principal(bounty)) {
    throw new PlatformError("forbidden", "a refund can only pay the owner");
  }
  if (!refund && settlement.payee === principal(bounty)) {
    throw new PlatformError("forbidden", "a payout cannot pay the owner");
  }
  if (!refund && bounty.escrow !== "held") {
    throw new PlatformError("not_funded", "there is nothing in escrow to pay out");
  }
  // Fails here if the outcome is not reachable, rather than at release time
  // when a caller would be left holding a decision that can never execute.
  assertTransition(bountyMachine, bounty.status, settlement.reason);

  const amount = escrowBalance(bounty);
  const now = new Date();
  const [updated] = await tx
    .update(bounties)
    .set({
      // The status does not move yet. It is still DISPUTED or IN_REVIEW,
      // because PAID means paid.
      escrow: "releasable",
      releaseReason: settlement.reason,
      releaseDecidedAt: now,
      releasePayee: settlement.payee,
      releasePayeeAddress: settlement.payeeAddress,
      releasePermissionless: settlement.reason !== "owner_agree",
      updatedAt: now,
    })
    .where(and(eq(bounties.id, bounty.id), eq(bounties.escrow, bounty.escrow)))
    .returning();

  if (!updated) {
    throw new PlatformError("escrow_settled", "escrow was settled concurrently");
  }

  await receipt(tx, bounty.id, {
    action: settlement.reason,
    actor: settlement.actor,
    amount,
    // The address is on the receipt because a receipt for a decision that does
    // not say where the money is going is not worth writing.
    detail: {
      payee: settlement.payee,
      payeeAddress: settlement.payeeAddress,
      escrow: "releasable",
      permissionless: settlement.reason !== "owner_agree",
      ...settlement.detail,
    },
  });

  return updated as Bounty;
}

/**
 * Performs the transfer a decision authorized, and only that transfer.
 *
 * Deliberately permissionless for every outcome a public process decided: a
 * council vote that resolves is not the council's to withhold afterwards, so
 * anyone may poke it, and everyone who does gets the identical result. The
 * scheduled deadline checker calls this same function with no extra rights —
 * there is no privileged variant of it to call.
 *
 * It can only ever do what the decision already recorded: pay the proven
 * payout address, or refund the funder. Nothing here takes a payee, so nothing
 * here can be pointed at a different one.
 */
export async function releaseEscrow(
  id: string,
  input: { actor?: Actor | string; txHash?: string; now?: Date } & ValueCapability,
): Promise<Bounty> {
  input.capabilities.assert("value.move");
  const now = input.now ?? new Date();
  const db = await getDb();

  return db.transaction(async (tx) => {
    const bounty = await lockBounty(tx, id);
    if (bounty.escrow !== "releasable" || !bounty.releaseReason) {
      throw new PlatformError(
        "invalid_state",
        `bounty ${id} has no decided release to execute; escrow is ${bounty.escrow}`,
      );
    }

    const actor = input.actor ? requireMuse(input.actor, "release escrow") : null;
    if (!bounty.releasePermissionless) {
      // Owner agreement is the one outcome no public process decided, so the
      // owner performs it. On chain that is their signature; here it is the
      // mirror of it, and the chain remains the thing that actually decides.
      if (!actor || actor !== bounty.owner) {
        throw new PlatformError(
          "forbidden",
          `bounty ${id} was released by owner agreement, so ${bounty.owner} signs the release. ` +
            `Council and deadline outcomes are permissionless; this one is not.`,
        );
      }
    }

    const refund =
      bounty.releaseReason === "deadline_refund" ||
      bounty.releaseReason === "council_refund";
    const to = assertTransition(bountyMachine, bounty.status, bounty.releaseReason);
    const amount = escrowBalance(bounty);

    const [updated] = await tx
      .update(bounties)
      .set({
        status: to,
        escrow: refund ? "refunded" : "released",
        escrowBalanceMinor: "0",
        settledAt: now,
        settledTo: bounty.releasePayee,
        settlementReason: bounty.releaseReason,
        settlementTxHash: input.txHash?.trim() || null,
        updatedAt: now,
      })
      .where(and(eq(bounties.id, id), eq(bounties.escrow, "releasable")))
      .returning();

    if (!updated) {
      throw new PlatformError("escrow_settled", "escrow was released concurrently");
    }

    await receipt(tx, id, {
      action: "release",
      actor: actor ?? systemActor("release"),
      amount,
      detail: {
        status: to,
        reason: bounty.releaseReason,
        payee: bounty.releasePayee,
        payeeAddress: bounty.releasePayeeAddress,
        txHash: input.txHash ?? null,
        permissionless: bounty.releasePermissionless,
      },
    });

    return updated as Bounty;
  });
}

export function principal(bounty: Bounty): string {
  return bounty.owner ?? bounty.creator;
}

export async function createBounty(input: {
  title: string;
  brief: string;
  /** Either a parsed Money, or minor units plus a currency code. */
  amount: Money;
  /** The muse posting it. Posting is not owning — ownership mints at funding. */
  creator: Actor | string;
  /** The wallet the bounty will be funded from. The contract accepts no other. */
  fundingAddress: string;
  /**
   * A named third party who can decide this bounty. Settable only here: an
   * arbiter an owner could appoint after seeing the submissions is not a
   * neutral, and a bounty whose arbiter can change is not the bounty a builder
   * agreed to work on.
   */
  arbiter?: string;
  council?: string[];
  councilQuorum?: number;
  deadlineAt: Date | string;
  now?: Date;
}): Promise<Bounty> {
  const title = input.title?.trim();
  const brief = input.brief?.trim();
  const creator = requireMuse(input.creator, "post a bounty");
  if (!title || !brief) {
    throw new PlatformError("validation", "title and brief are required");
  }
  const amount = input.amount;
  currencyFor(amount.currency);
  if (amount.minor <= 0n) {
    throw new PlatformError("validation", "the amount must be greater than zero");
  }

  const now = input.now ?? new Date();
  const deadlineAt = normalizeDeadline(input.deadlineAt);
  if (deadlineAt.getTime() <= now.getTime()) {
    throw new PlatformError("validation", "the deadline must be in the future");
  }

  // Validated before anything is written, and stored exactly as given.
  const fundingAddress = assertAddress(input.fundingAddress, "funding wallet address");

  const councilQuorum = input.councilQuorum ?? DEFAULT_QUORUM;
  if (councilQuorum < 1) {
    throw new PlatformError("validation", "the council quorum must be at least one vote");
  }

  // The creator will be the refund payee if this is ever funded and lapses, so
  // they are a counterparty to a value movement even though creation moves
  // nothing. Checked here rather than once the money is committed.
  await assertKeyedCounterparty(creator, "creator");

  let arbiter: string | null = null;
  if (input.arbiter) {
    arbiter = normalizeHandle(input.arbiter);
    if (arbiter === creator) {
      throw new PlatformError(
        "validation",
        "the arbiter is the party who decides when you and the builder cannot agree, so it cannot be you",
      );
    }
    // An arbiter who cannot be verified is not a defence, and discovering that
    // at the moment of a dispute is discovering it too late.
    await assertKeyedCounterparty(arbiter, "arbiter");
  }

  const db = await getDb();
  return db.transaction(async (tx) => {
    const [bounty] = await tx
      .insert(bounties)
      .values({
        id: randomUUID(),
        title,
        brief,
        contentHash: contentHash({
          title,
          brief,
          amount,
          deadlineAt,
        }),
        amountMinor: toStored(amount),
        currency: amount.currency,
        creator,
        // Nothing is owned yet. Funding mints that, to whoever funds.
        owner: null,
        fundingAddress,
        arbiter,
        councilQuorum,
        status: "OPEN",
        escrow: "unfunded",
        escrowBalanceMinor: "0",
        deadlineAt,
      })
      .returning();

    await receipt(tx, bounty.id, {
      action: "post",
      actor: creator,
      amount,
      // A funding instruction without the address the contract will accept is
      // not actionable, so it belongs on the receipt rather than in a follow-up.
      detail: {
        contentHash: bounty.contentHash,
        status: "OPEN",
        fundingAddress: bounty.fundingAddress,
        arbiter: bounty.arbiter,
      },
    });
    return bounty as Bounty;
  });
}

/**
 * Step two of the spec's flow, and the first one that moves money.
 *
 * Creation is deliberately cheap — a mention can open a bounty — so this is
 * where the `value.move` capability and a `key_bound` caller start being
 * required. Until this runs, the bounty is a public promise and escrow holds
 * nothing.
 */
export async function fundBounty(
  id: string,
  input: {
    actor: Actor | string;
    txHash?: string;
    /** The address the funding transaction was actually sent from. */
    fromAddress?: string;
  } & ValueCapability,
): Promise<Bounty> {
  const actor = requireMuse(input.actor, "fund a bounty");
  input.capabilities.assert("value.move");

  const db = await getDb();
  return db.transaction(async (tx) => {
    const bounty = await lockBounty(tx, id);
    assertUnsettled(bounty);
    // There is no owner yet, so there is nobody with the standing to refuse.
    // The creator may always fund; anyone else must already have proved control
    // of the declared address, since that is the only account the contract will
    // take money from.
    if (bounty.creator !== actor) {
      const wallet = await defaultWallet(actor, tx);
      if (!wallet || !sameAddress(wallet.address, bounty.fundingAddress)) {
        throw new PlatformError(
          "forbidden",
          `bounty ${id} is funded from ${bounty.fundingAddress}, and you have not proved control of it. ` +
            `Either ${bounty.creator} funds it, or prove that address first.`,
        );
      }
    }
    const to = assertTransition(bountyMachine, bounty.status, "fund");

    // The chain is a separate fact from our database, and this report of it
    // arrives from a caller with an interest in the answer. Where the sender is
    // reported we check it against the declared address rather than recording
    // whatever we were told: the contract would have refused any other sender,
    // so a mismatch means the two disagree and one of them is wrong.
    if (input.fromAddress) {
      assertFundingSender({
        declared: bounty.fundingAddress,
        sender: assertAddress(input.fromAddress, "funding sender address"),
        subject: `bounty ${bounty.id}`,
      });
    }

    const amount = bountyAmount(bounty);
    const now = new Date();
    const [updated] = await tx
      .update(bounties)
      .set({
        status: to,
        escrow: "held",
        escrowBalanceMinor: toStored(amount),
        // Ownership mints here, to the funder, because this is the first moment
        // there is anything to own.
        owner: actor,
        fundedAt: now,
        fundingTxHash: input.txHash?.trim() || null,
        updatedAt: now,
      })
      .where(and(eq(bounties.id, id), eq(bounties.status, "OPEN")))
      .returning();

    if (!updated) {
      throw new PlatformError("invalid_state", "the bounty was funded concurrently");
    }

    await receipt(tx, id, {
      action: "fund",
      actor,
      amount,
      detail: {
        status: to,
        txHash: input.txHash ?? null,
        fundingAddress: bounty.fundingAddress,
        owner: actor,
      },
    });
    return updated as Bounty;
  });
}

/**
 * A statement of intent to work, per the spec's `/api/claim`. It moves no money
 * and changes no status: first claim wins socially, and nothing about escrow
 * depends on it, so a stranger cannot lock a bounty by claiming it.
 */
export async function claimBounty(
  id: string,
  input: { claimant: Actor | string; note?: string; now?: Date },
): Promise<{ claim: Claim; first: boolean }> {
  const claimant = requireMuse(input.claimant, "claim a bounty");
  const now = input.now ?? new Date();
  const db = await getDb();
  return db.transaction(async (tx) => {
    const bounty = await lockBounty(tx, id);
    assertUnsettled(bounty);
    if (bounty.status !== "OPEN" && bounty.status !== "FUNDED") {
      throw new PlatformError(
        "invalid_state",
        `bounty ${id} is ${bounty.status}; claims are only open before work is in review`,
      );
    }
    if (principal(bounty) === claimant) {
      throw new PlatformError("forbidden", "you cannot claim your own bounty");
    }
    if (now.getTime() >= bounty.deadlineAt.getTime()) {
      throw new PlatformError("deadline_passed", "the deadline has passed");
    }

    const existing = await tx
      .select()
      .from(claims)
      .where(eq(claims.bountyId, id))
      .orderBy(asc(claims.createdAt));
    if (existing.some((c) => c.claimant === claimant)) {
      throw new PlatformError("duplicate", "you have already claimed this bounty");
    }

    const [claim] = await tx
      .insert(claims)
      .values({
        id: randomUUID(),
        bountyId: id,
        claimant,
        note: input.note?.trim() || null,
      })
      .returning();

    await receipt(tx, id, {
      action: "claim",
      actor: claimant,
      detail: { claimId: claim.id, first: existing.length === 0 },
    });
    return { claim: claim as Claim, first: existing.length === 0 };
  });
}

/**
 * Amendments to the terms. The amount is immutable because escrow is already
 * funded, and the deadline may only move later — otherwise an owner could pull
 * the deadline forward and force an immediate refund of live work.
 */
export async function amendBounty(
  id: string,
  input: {
    actor: Actor | string;
    title?: string;
    brief?: string;
    deadlineAt?: Date | string;
    /** Correctable only while the bounty is still OPEN. See below. */
    fundingAddress?: string;
  },
): Promise<Bounty> {
  const actor = requireMuse(input.actor, "amend a bounty");
  const db = await getDb();
  return db.transaction(async (tx) => {
    const bounty = await lockBounty(tx, id);
    assertUnsettled(bounty);
    // Before funding this is the creator; after it, the funder who now owns it.
    if (principal(bounty) !== actor) {
      throw new PlatformError("forbidden", "only the owner can amend a bounty");
    }

    // A typo'd funding address is correctable right up until it matters and
    // never afterwards. Once escrow holds money the contract has recorded the
    // address, so changing our copy would only make our record disagree with
    // the chain — and the failure that hides is the one where funds are already
    // committed against an address we no longer show.
    let fundingAddress = bounty.fundingAddress;
    if (input.fundingAddress !== undefined) {
      if (bounty.status !== "OPEN") {
        throw new PlatformError(
          "invalid_state",
          `the funding address is fixed once a bounty leaves OPEN, and this one is ${bounty.status}. ` +
            `The escrow contract recorded ${bounty.fundingAddress} at funding and will not accept another.`,
        );
      }
      fundingAddress = assertAddress(input.fundingAddress, "funding wallet address");
    }

    const title = input.title?.trim() || bounty.title;
    const brief = input.brief?.trim() || bounty.brief;
    const deadlineAt = input.deadlineAt
      ? normalizeDeadline(input.deadlineAt)
      : bounty.deadlineAt;

    if (deadlineAt.getTime() < bounty.deadlineAt.getTime()) {
      throw new PlatformError(
        "validation",
        "a deadline can be extended but never brought forward",
      );
    }

    const nextHash = contentHash({
      title,
      brief,
      amount: bountyAmount(bounty),
      deadlineAt,
    });
    if (nextHash === bounty.contentHash && fundingAddress === bounty.fundingAddress) {
      return bounty;
    }

    const [updated] = await tx
      .update(bounties)
      .set({
        title,
        brief,
        deadlineAt,
        fundingAddress,
        contentHash: nextHash,
        updatedAt: new Date(),
      })
      .where(eq(bounties.id, id))
      .returning();

    await receipt(tx, id, {
      action: "amend_terms",
      actor,
      detail: {
        fromContentHash: bounty.contentHash,
        toContentHash: nextHash,
        fundingAddress,
        ...(fundingAddress === bounty.fundingAddress
          ? {}
          : { fromFundingAddress: bounty.fundingAddress }),
      },
    });
    return updated as Bounty;
  });
}

export async function submitWork(
  id: string,
  input: {
    worker: Actor | string;
    artifactUrl: string;
    /**
     * Where a release for this submission pays. Optional only when the worker
     * has a proven default on file, which is the whole point of having one.
     */
    rewardAddress?: string;
    /** An EIP-191 signature over the proof statement, proving control now. */
    rewardAddressSignature?: string;
    notes?: string;
    now?: Date;
  },
): Promise<Submission> {
  const worker = requireMuse(input.worker, "submit work");
  const artifactUrl = input.artifactUrl?.trim();
  if (!artifactUrl) {
    throw new PlatformError("validation", "an artifact url is required");
  }

  // Who before where. An unverifiable worker gets told that, rather than being
  // sent off to prove an address that was never going to be paid anyway.
  await assertKeyedCounterparty(worker, "worker");

  const resolved = await resolveWallet({
    actor: worker,
    declared: input.rewardAddress,
    purpose: "reward wallet address",
  });
  const rewardAddress = resolved.address;
  // A signature sent with the submission proves the address on the spot; one
  // sent later through the prove endpoint does the same thing afterwards. An
  // unproven address is recorded either way — the submission is still real
  // work — and only the payout is withheld.
  const proof = input.rewardAddressSignature
    ? verifyProof({
        address: rewardAddress,
        statement: proofStatement({
          address: rewardAddress,
          subject: `bounty:${id}`,
          nonce: worker,
        }),
        signature: input.rewardAddressSignature,
      })
    : resolved.proof;

  const now = input.now ?? new Date();
  const db = await getDb();
  return db.transaction(async (tx) => {
    const bounty = await lockBounty(tx, id);
    // Work can only be submitted against money that is actually in escrow, so
    // an unfunded bounty produces `not_funded` rather than a silent acceptance.
    assertFunded(bounty);
    if (principal(bounty) === worker || bounty.creator === worker) {
      throw new PlatformError("forbidden", "you cannot answer your own bounty");
    }
    assertTransition(bountyMachine, bounty.status, "answer");
    if (now.getTime() >= bounty.deadlineAt.getTime()) {
      throw new PlatformError("deadline_passed", "the deadline has passed");
    }

    const [submission] = await tx
      .insert(submissions)
      .values({
        id: randomUUID(),
        bountyId: id,
        worker,
        rewardAddress,
        rewardAddressProvenAt: proof?.provenAt ?? null,
        rewardAddressProofMethod: proof?.method ?? null,
        rewardAddressProof: proof?.evidence ?? null,
        contentHash: bounty.contentHash,
        artifactUrl,
        notes: input.notes?.trim() || null,
      })
      .returning();

    // Votes are cast on a specific submission; a new one resets the count.
    await tx.delete(councilVotes).where(eq(councilVotes.bountyId, id));
    await tx
      .update(bounties)
      .set({ status: "IN_REVIEW", updatedAt: now })
      .where(eq(bounties.id, id));

    await receipt(tx, id, {
      action: "answer",
      actor: worker,
      detail: {
        submissionId: submission.id,
        contentHash: bounty.contentHash,
        status: "IN_REVIEW",
        rewardAddress: submission.rewardAddress,
        rewardAddressProven: Boolean(submission.rewardAddressProvenAt),
      },
    });
    return submission as Submission;
  });
}

/**
 * `IN_REVIEW → DISPUTED`. Either side may escalate, and doing so opens the
 * spec's 72-hour public council window. It moves no money by itself: the vote
 * that closes the window does.
 */
export async function disputeBounty(
  id: string,
  input: { actor: Actor | string; reason?: string; now?: Date },
): Promise<Bounty> {
  const actor = requireMuse(input.actor, "open a dispute");
  const now = input.now ?? new Date();
  const db = await getDb();
  return db.transaction(async (tx) => {
    const bounty = await lockBounty(tx, id);
    assertFunded(bounty);
    const to = assertTransition(bountyMachine, bounty.status, "dispute");

    const submission = await latestSubmission(tx, id);
    // The arbiter can open one too, and that is the point of naming one: the
    // capture case is an owner who never acts, so a defence that only the owner
    // can invoke is no defence at all.
    if (
      principal(bounty) !== actor &&
      submission.worker !== actor &&
      bounty.arbiter !== actor
    ) {
      throw new PlatformError(
        "forbidden",
        bounty.arbiter
          ? "only the owner, the builder whose work is in review, or the named arbiter can open a dispute"
          : "only the owner or the builder whose work is in review can open a dispute. " +
            "No arbiter was named at creation, so there is no third party who can escalate this one.",
      );
    }

    const closesAt = new Date(now.getTime() + COUNCIL_WINDOW_MS);
    const [updated] = await tx
      .update(bounties)
      .set({
        status: to,
        disputedAt: now,
        councilClosesAt: closesAt,
        updatedAt: now,
      })
      .where(and(eq(bounties.id, id), eq(bounties.status, "IN_REVIEW")))
      .returning();
    if (!updated) {
      throw new PlatformError("invalid_state", "the bounty changed state concurrently");
    }

    await receipt(tx, id, {
      action: "dispute",
      actor,
      detail: {
        status: to,
        reason: input.reason?.trim() || null,
        councilClosesAt: closesAt.toISOString(),
        submissionId: submission.id,
      },
    });
    return updated as Bounty;
  });
}

async function latestSubmission(tx: Tx, id: string): Promise<Submission> {
  const [submission] = await tx
    .select()
    .from(submissions)
    .where(eq(submissions.bountyId, id))
    .orderBy(desc(submissions.createdAt), desc(submissions.id))
    .limit(1);
  if (!submission) {
    throw new PlatformError("no_submission", "there is no work to pay for");
  }
  return submission as Submission;
}

/**
 * Whether a submission can actually be paid.
 *
 * Reaching `IN_REVIEW` is about the work; being payable is about the money, and
 * they are not the same question. A submission whose reward address is declared
 * but unproven keeps its full evidence trail and sits in review like any other
 * — it simply has no verified destination, so releasing escrow against it would
 * be a transfer to an address nobody has shown they control.
 */
export function payability(
  bounty: Bounty,
  submission: Submission,
): { payable: boolean; reason: "stale_terms" | "address_unproven" | null } {
  if (submission.contentHash !== bounty.contentHash) {
    return { payable: false, reason: "stale_terms" };
  }
  if (!submission.rewardAddressProvenAt) {
    return { payable: false, reason: "address_unproven" };
  }
  return { payable: true, reason: null };
}

function assertPayable(bounty: Bounty, submission: Submission) {
  const { reason } = payability(bounty, submission);
  if (reason === "stale_terms") {
    throw new PlatformError(
      "stale_submission",
      "the terms changed after this submission; the worker must resubmit",
    );
  }
  if (reason === "address_unproven") {
    throw new PlatformError(
      "address_unproven",
      `submission ${submission.id} names ${submission.rewardAddress} as its reward address but nobody has proved control of it. ` +
        `Releasing escrow would send the money to an unverified destination, which cannot be undone. ` +
        `The builder proves it with an EIP-191 signature at POST /api/submissions/${submission.id}/prove.`,
    );
  }
}

/** Route 1 out of escrow: the owner agrees the work is done. */
export async function ownerAgree(
  id: string,
  input: { actor: Actor | string } & ValueCapability,
): Promise<Bounty> {
  const actor = requireMuse(input.actor, "agree to a payout");
  const db = await getDb();
  return db.transaction(async (tx) => {
    const bounty = await lockBounty(tx, id);
    assertFunded(bounty);
    if (bounty.owner !== actor) {
      throw new PlatformError("forbidden", "only the owner can agree");
    }
    const submission = await latestSubmission(tx, id);
    assertPayable(bounty, submission);

    return settle(tx, bounty, {
      reason: "owner_agree",
      payee: submission.worker,
      payeeAddress: submission.rewardAddress,
      actor,
      grant: input.capabilities,
      detail: { submissionId: submission.id },
    });
  });
}

export interface VoteOutcome {
  bounty: Bounty;
  vote: CouncilVote;
  tally: Tally;
  resolved: SettlementReason | null;
}

/**
 * Route 2 out of escrow: a public council vote.
 *
 * The council is ours, not musebook's — a public thread with a 72-hour window
 * and one vote per established identity, so there is no membership list to be
 * on. Eligibility is the assurance ladder doing anti-sybil work
 * (`assertEstablished`: key_bound, a published key, and a minimum account age),
 * which is what excludes the keyless `anon:` identities from deciding where
 * money goes. The owner and the builder are excluded as interested parties.
 */
export async function castVote(
  id: string,
  input: {
    voter: Actor | string;
    choice: CouncilVote["choice"];
    assurance: Assurance;
    rationale?: string;
    pollId?: string;
    postId?: number;
    now?: Date;
  } & ValueCapability,
): Promise<VoteOutcome> {
  const voter = requireMuse(input.voter, "vote");
  const now = input.now ?? new Date();
  if (input.choice !== "pay" && input.choice !== "refund") {
    throw new PlatformError("validation", 'a vote is either "pay" or "refund"');
  }

  // Anti-sybil, before anything is written: a fresh or keyless account never
  // gets as far as being counted.
  await assertEstablished(voter, input.assurance, now);

  const db = await getDb();
  return db.transaction(async (tx) => {
    const bounty = await lockBounty(tx, id);
    assertFunded(bounty);
    if (bounty.status !== "DISPUTED") {
      throw new PlatformError(
        "invalid_state",
        `bounty ${id} is ${bounty.status}; the council only votes on a DISPUTED bounty`,
      );
    }
    if (bounty.councilClosesAt && now.getTime() >= bounty.councilClosesAt.getTime()) {
      throw new PlatformError(
        "council_closed",
        `the council window closed at ${bounty.councilClosesAt.toISOString()}`,
      );
    }

    const submission = await latestSubmission(tx, id);
    if (voter === principal(bounty) || voter === submission.worker) {
      throw new PlatformError(
        "forbidden",
        "the owner and the builder are parties to the dispute and cannot vote on it",
      );
    }
    if (input.choice === "pay") assertPayable(bounty, submission);

    const existing = await tx
      .select()
      .from(councilVotes)
      .where(and(eq(councilVotes.bountyId, id), eq(councilVotes.voter, voter)));
    if (existing.length > 0) {
      throw new PlatformError(
        "duplicate_vote",
        "one vote per established identity, and this one has already voted",
      );
    }

    const [vote] = await tx
      .insert(councilVotes)
      .values({
        id: randomUUID(),
        bountyId: id,
        voter,
        choice: input.choice,
        submissionId: input.choice === "pay" ? submission.id : null,
        rationale: input.rationale?.trim() || null,
        pollId: input.pollId?.trim() || null,
        postId: input.postId ?? null,
      })
      .returning();

    const tally = await tallyVotes(tx, bounty, now);
    await receipt(tx, id, {
      action: "council_vote",
      actor: voter,
      detail: {
        choice: input.choice,
        submissionId: vote.submissionId,
        pay: tally.pay,
        refund: tally.refund,
        quorum: tally.quorum,
      },
    });

    // The named arbiter decides alone. They were named at creation, before
    // anyone knew which way a dispute would go, and by both the owner and every
    // builder who chose to work on those terms — which is exactly the consent a
    // quorum of passers-by is standing in for when there is no arbiter.
    const winner =
      bounty.arbiter && voter === bounty.arbiter ? input.choice : decideCouncil(tally);
    if (!winner) {
      const [current] = await tx.select().from(bounties).where(eq(bounties.id, id));
      return {
        bounty: current as Bounty,
        vote: vote as CouncilVote,
        tally,
        resolved: null,
      };
    }

    const settled = await settle(tx, bounty, {
      reason: winner === "pay" ? "council_pay" : "council_refund",
      payee: winner === "pay" ? submission.worker : principal(bounty),
      payeeAddress:
        winner === "pay" ? submission.rewardAddress : bounty.fundingAddress,
      actor: voter,
      grant: input.capabilities,
      detail: {
        submissionId: submission.id,
        pay: tally.pay,
        refund: tally.refund,
        decidedBy: voter === bounty.arbiter ? "arbiter" : "quorum",
      },
    });
    return {
      bounty: settled,
      vote: vote as CouncilVote,
      tally,
      resolved: winner === "pay" ? "council_pay" : "council_refund",
    };
  });
}

async function tallyVotes(tx: Tx, bounty: Bounty, now: Date): Promise<Tally> {
  const rows = await tx
    .select({ choice: councilVotes.choice, n: sql<number>`count(*)::int` })
    .from(councilVotes)
    .where(eq(councilVotes.bountyId, bounty.id))
    .groupBy(councilVotes.choice);

  const counts = new Map(rows.map((r) => [r.choice, r.n]));
  const closesAt = bounty.councilClosesAt;
  return {
    pay: counts.get("pay") ?? 0,
    refund: counts.get("refund") ?? 0,
    quorum: bounty.councilQuorum,
    closesAt: closesAt?.toISOString() ?? null,
    open: Boolean(closesAt && now.getTime() < closesAt.getTime()),
  };
}

/** A side wins by reaching quorum with a strict majority. Ties do not settle. */
function decideCouncil(tally: Tally): "pay" | "refund" | null {
  if (tally.pay >= tally.quorum && tally.pay > tally.refund) return "pay";
  if (tally.refund >= tally.quorum && tally.refund > tally.pay) return "refund";
  return null;
}

/**
 * What happens when the 72-hour window closes without quorum: funds go back to
 * the owner. Silence is not consent to a payout.
 */
export async function closeCouncil(
  id: string,
  input: { now?: Date } & ValueCapability,
): Promise<Bounty> {
  const now = input.now ?? new Date();
  const db = await getDb();
  return db.transaction(async (tx) => {
    const bounty = await lockBounty(tx, id);
    assertFunded(bounty);
    if (bounty.status !== "DISPUTED") {
      throw new PlatformError("invalid_state", `bounty ${id} is not DISPUTED`);
    }
    if (!bounty.councilClosesAt || now.getTime() < bounty.councilClosesAt.getTime()) {
      throw new PlatformError(
        "council_closed",
        "the council window is still open; the vote decides until it closes",
      );
    }

    const tally = await tallyVotes(tx, bounty, now);
    const winner = decideCouncil(tally);
    const submission = await latestSubmission(tx, id);

    return settle(tx, bounty, {
      reason: winner === "pay" ? "council_pay" : "council_refund",
      payee: winner === "pay" ? submission.worker : principal(bounty),
      payeeAddress:
        winner === "pay" ? submission.rewardAddress : bounty.fundingAddress,
      actor: systemActor("council-clock"),
      grant: input.capabilities,
      detail: {
        pay: tally.pay,
        refund: tally.refund,
        quorum: tally.quorum,
        window: "closed",
      },
    });
  });
}

/** Route 3 out of escrow: the deadline lapsed, so the owner gets their money back. */
export async function deadlineRefund(
  id: string,
  input: { now?: Date; actor?: Actor | string } & ValueCapability,
): Promise<Bounty> {
  const now = input.now ?? new Date();
  const db = await getDb();
  return db.transaction(async (tx) => {
    const bounty = await lockBounty(tx, id);
    assertUnsettled(bounty);
    if (now.getTime() < bounty.deadlineAt.getTime()) {
      throw new PlatformError(
        "deadline_not_reached",
        `deadline is ${bounty.deadlineAt.toISOString()}; a refund is not available yet`,
      );
    }
    return settle(tx, bounty, {
      reason: "deadline_refund",
      // A refund returns the money the contract took, so it goes back to the
      // address it came from and nowhere else.
      payee: principal(bounty),
      payeeAddress: bounty.fundingAddress,
      actor: input.actor ?? systemActor("deadline-checker"),
      grant: input.capabilities,
      detail: { deadlineAt: bounty.deadlineAt.toISOString() },
    });
  });
}

/**
 * Everything the deadline checker needs.
 *
 * Two clocks run here. A bounty that is still `OPEN` or `FUNDED` past its
 * deadline refunds — work in review is safe from the deadline, per the spec,
 * because a submission in time starts the review clock instead. And a dispute
 * whose 72-hour council window has closed is resolved on the votes it got.
 */
export async function sweepDeadlines(
  input: { now?: Date } & ValueCapability,
): Promise<{
  checked: number;
  refunded: string[];
  councilResolved: string[];
  released: string[];
  failed: string[];
}> {
  const now = input.now ?? new Date();
  input.capabilities.assert("value.move");

  const db = await getDb();
  const due = await db
    .select({ id: bounties.id })
    .from(bounties)
    .where(
      and(
        inArray(bounties.status, ["OPEN", "FUNDED"]),
        sql`${bounties.deadlineAt} <= ${now}`,
      ),
    );

  const lapsedCouncils = await db
    .select({ id: bounties.id })
    .from(bounties)
    .where(
      and(
        eq(bounties.status, "DISPUTED"),
        sql`${bounties.councilClosesAt} <= ${now}`,
      ),
    );

  // Every release a public process already decided and nobody has executed.
  // The sweep pokes these as a convenience, not as an authority: the same call
  // is open to anyone, and a caller who beats the timer to it gets the same
  // outcome the timer would have produced.
  const pending = await db
    .select({ id: bounties.id })
    .from(bounties)
    .where(
      and(eq(bounties.escrow, "releasable"), eq(bounties.releasePermissionless, true)),
    );

  const refunded: string[] = [];
  const councilResolved: string[] = [];
  const released: string[] = [];
  const failed: string[] = [];

  for (const { id } of due) {
    try {
      await deadlineRefund(id, { now, capabilities: input.capabilities });
      refunded.push(id);
    } catch {
      failed.push(id);
    }
  }
  for (const { id } of lapsedCouncils) {
    try {
      await closeCouncil(id, { now, capabilities: input.capabilities });
      councilResolved.push(id);
    } catch {
      failed.push(id);
    }
  }

  // After deciding, sweep everything decided — including what this run just
  // decided, so a lapsed deadline still reaches REFUNDED in one pass.
  const toRelease = new Set([...pending.map((p) => p.id), ...refunded, ...councilResolved]);
  for (const id of toRelease) {
    try {
      await releaseEscrow(id, { now, capabilities: input.capabilities });
      released.push(id);
    } catch {
      // A release that is not ready, or that someone else already performed, is
      // the normal case rather than a failure worth reporting.
    }
  }

  return {
    checked: due.length + lapsedCouncils.length + pending.length,
    released,
    refunded,
    councilResolved,
    failed,
  };
}

export async function listBounties(filter?: {
  status?: Bounty["status"];
  owner?: string;
}): Promise<Bounty[]> {
  const db = await getDb();
  const where = [
    filter?.status ? eq(bounties.status, filter.status) : undefined,
    filter?.owner ? eq(bounties.owner, normalizeHandle(filter.owner)) : undefined,
  ].filter(Boolean);
  const rows = await db
    .select()
    .from(bounties)
    .where(where.length ? and(...where) : undefined)
    .orderBy(asc(bounties.deadlineAt));
  return rows as Bounty[];
}

export async function getBounty(id: string): Promise<BountyDetail> {
  const db = await getDb();
  const [bounty] = await db.select().from(bounties).where(eq(bounties.id, id));
  if (!bounty) throw new PlatformError("not_found", `bounty ${id} not found`);

  const [subs, claimRows, votes, ledger] = await Promise.all([
    db
      .select()
      .from(submissions)
      .where(eq(submissions.bountyId, id))
      .orderBy(desc(submissions.createdAt)),
    db
      .select()
      .from(claims)
      .where(eq(claims.bountyId, id))
      .orderBy(asc(claims.createdAt)),
    db
      .select()
      .from(councilVotes)
      .where(eq(councilVotes.bountyId, id))
      .orderBy(asc(councilVotes.createdAt)),
    readReceipts(SUBJECT_KIND, id),
  ]);

  const newest = subs[0];
  const now = new Date();
  const closesAt = (bounty as Bounty).councilClosesAt;
  return {
    ...(bounty as Bounty),
    submissions: subs as Submission[],
    claims: claimRows as Claim[],
    votes: votes as CouncilVote[],
    tally: {
      pay: votes.filter((v) => v.choice === "pay").length,
      refund: votes.filter((v) => v.choice === "refund").length,
      quorum: (bounty as Bounty).councilQuorum,
      closesAt: closesAt?.toISOString() ?? null,
      open: Boolean(closesAt && now.getTime() < closesAt.getTime()),
    },
    receipts: ledger,
    stale: Boolean(newest && newest.contentHash !== bounty.contentHash),
    refundClosed: refundClosedOnChain(bounty as Bounty, subs as Submission[]),
  };
}

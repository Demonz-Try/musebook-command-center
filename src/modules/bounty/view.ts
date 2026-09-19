import {
  displayMoney,
  formatMoney,
  fromStored,
  type Money,
} from "@/platform/money";
import type { Receipt } from "@/platform/receipts";
import {
  arbiterRecommended,
  bountyAmount,
  escrowBalance,
  type BountyDetail,
  type Tally,
} from "./escrow";
import type { Bounty, Claim, CouncilVote, Submission } from "./schema";

/**
 * The wire shape every client polls. Explicit status enums, explicit ids, ISO
 * timestamps, and amounts as exact integer strings in the currency's minor
 * unit alongside a human-readable rendering — never a float.
 */
export interface AmountView {
  currency: string;
  minor: string;
  decimal: string;
  display: string;
}

export interface BountyView {
  id: string;
  object: "bounty";
  status: Bounty["status"];
  title: string;
  brief: string;
  /** Also the terms hash: what the contract records at creation. */
  contentHash: string;
  councilQuorum: number;
  amount: AmountView;
  deadlineAt: string;
  /** Set when a submission arrives; the review clock, not the bounty clock. */
  reviewDeadlineAt: string | null;
  /** Set on dispute: the 72-hour public council window. */
  councilClosesAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Who posted it. Posting is not owning. */
  creator: string;
  /**
   * Who owns it, minted at funding to the funder. Null while OPEN — before
   * money exists there is nothing to own and nobody who can agree a payout.
   */
  owner: string | null;
  /**
   * The named third party who can decide this bounty, or null.
   *
   * Null is not an absence of data, it is a fact about the bounty's exposure,
   * so it is a first-class field rather than an omitted one — a client that
   * shows a bounty without showing this is hiding the thing that decides who
   * ends up with the money when the owner stops paying attention.
   */
  arbiter: string | null;
  /** True when the amount is large enough that going without one is a choice. */
  arbiterRecommended: boolean;
  /**
   * True once the chain will no longer refund: some submission has proved its
   * reward address. The owner cannot get this money back by waiting.
   */
  refundClosedOnChain?: boolean;
  escrow: {
    state: Bounty["escrow"];
    balance: AmountView;
    /**
     * The only address the escrow contract will accept funding from, exactly as
     * the owner wrote it. Echoed here because a funding instruction without it
     * is not actionable.
     */
    fundingAddress: string;
    fundedAt: string | null;
    fundingTxHash: string | null;
    /**
     * A decided but not yet performed release.
     *
     * Present exactly when escrow is `releasable`. A resolved council vote puts
     * a bounty here, not at PAID: the vote decided where the money goes and
     * moved none of it.
     */
    release: {
      reason: Bounty["releaseReason"];
      decidedAt: string;
      payee: string;
      payeeAddress: string;
      /** Whether anyone may trigger the transfer, or only the owner. */
      permissionless: boolean;
      endpoint: string;
    } | null;
    settledTo: string | null;
    settlementReason: Bounty["settlementReason"];
    settledAt: string | null;
    /** Populated when settlement is mirrored on chain; null in this phase. */
    txHash: string | null;
  };
  staleSubmission?: boolean;
  /** True while a bounty is payable but not yet paid. */
  release_requires_evm_signature?: boolean;
  /** The payout destination for the submission an owner would be agreeing to. */
  payout?: PayoutView | null;
  submissions?: ReturnType<typeof submissionView>[];
  claims?: ReturnType<typeof claimView>[];
  votes?: ReturnType<typeof voteView>[];
  council?: Tally;
  receipts?: ReturnType<typeof receiptView>[];
}

export function amountView(value: Money): AmountView {
  return {
    currency: value.currency,
    minor: value.minor.toString(),
    decimal: formatMoney(value),
    display: displayMoney(value),
  };
}

export function submissionView(submission: Submission) {
  return {
    id: submission.id,
    object: "submission" as const,
    bountyId: submission.bountyId,
    worker: submission.worker,
    /** Where a release for this submission pays, exactly as submitted. */
    rewardAddress: submission.rewardAddress,
    /**
     * Whether that address has been shown to be controlled by anyone. An
     * unproven submission is still real work in review; it just cannot be paid.
     */
    rewardAddressProven: Boolean(submission.rewardAddressProvenAt),
    rewardAddressProvenAt: submission.rewardAddressProvenAt?.toISOString() ?? null,
    contentHash: submission.contentHash,
    artifactUrl: submission.artifactUrl,
    notes: submission.notes,
    createdAt: submission.createdAt.toISOString(),
  };
}

export function receiptView(receipt: Receipt) {
  const amount = receipt.currency
    ? amountView(fromStored(receipt.amountMinor, receipt.currency))
    : null;
  return {
    id: receipt.id,
    object: "receipt" as const,
    subject: { kind: receipt.subjectKind, id: receipt.subjectId },
    module: receipt.module,
    seq: receipt.seq,
    action: receipt.action,
    actor: receipt.actor,
    amount,
    detail: receipt.detail,
    prevHash: receipt.prevHash,
    hash: receipt.hash,
    createdAt: receipt.createdAt.toISOString(),
  };
}

export function claimView(claim: Claim) {
  return {
    id: claim.id,
    object: "claim" as const,
    bountyId: claim.bountyId,
    claimant: claim.claimant,
    note: claim.note,
    createdAt: claim.createdAt.toISOString(),
  };
}

/** Council votes are public by design, so the whole vote goes on the wire. */
export function voteView(vote: CouncilVote) {
  return {
    id: vote.id,
    object: "vote" as const,
    bountyId: vote.bountyId,
    voter: vote.voter,
    choice: vote.choice,
    submissionId: vote.submissionId,
    rationale: vote.rationale,
    pollId: vote.pollId,
    postId: vote.postId,
    createdAt: vote.createdAt.toISOString(),
  };
}

export function bountyView(bounty: Bounty | BountyDetail): BountyView {
  const detail = bounty as Partial<BountyDetail>;
  return {
    id: bounty.id,
    object: "bounty",
    status: bounty.status,
    title: bounty.title,
    brief: bounty.brief,
    contentHash: bounty.contentHash,
    creator: bounty.creator,
    owner: bounty.owner,
    arbiter: bounty.arbiter,
    arbiterRecommended: arbiterRecommended(bountyAmount(bounty)),
    councilQuorum: bounty.councilQuorum,
    amount: amountView(bountyAmount(bounty)),
    deadlineAt: bounty.deadlineAt.toISOString(),
    reviewDeadlineAt: bounty.reviewDeadlineAt?.toISOString() ?? null,
    councilClosesAt: bounty.councilClosesAt?.toISOString() ?? null,
    createdAt: bounty.createdAt.toISOString(),
    updatedAt: bounty.updatedAt.toISOString(),
    escrow: {
      state: bounty.escrow,
      balance: amountView(escrowBalance(bounty)),
      fundingAddress: bounty.fundingAddress,
      fundedAt: bounty.fundedAt?.toISOString() ?? null,
      fundingTxHash: bounty.fundingTxHash,
      release:
        bounty.escrow === "releasable" && bounty.releaseReason
          ? {
              reason: bounty.releaseReason,
              decidedAt: bounty.releaseDecidedAt!.toISOString(),
              payee: bounty.releasePayee!,
              payeeAddress: bounty.releasePayeeAddress!,
              permissionless: bounty.releasePermissionless,
              endpoint: `/api/bounties/${bounty.id}/release`,
            }
          : null,
      settledTo: bounty.settledTo,
      settlementReason: bounty.settlementReason,
      settledAt: bounty.settledAt?.toISOString() ?? null,
      txHash: bounty.settlementTxHash,
    },
    ...(detail.submissions
      ? {
          staleSubmission: detail.stale,
          refundClosedOnChain: detail.refundClosed,
          // Agreement is a decision, not a transfer: it makes a bounty payable
          // and moves nothing. The owner signs the release with their EVM key
          // afterwards, and an agent that conflates the two will tell a builder
          // they have been paid when they have not.
          release_requires_evm_signature: releaseRequiresSignature(
            bounty,
            detail.submissions[0],
          ),
          payout: detail.submissions[0] ? payoutView(detail.submissions[0]) : null,
          submissions: detail.submissions.map(submissionView),
          claims: (detail.claims ?? []).map(claimView),
          votes: (detail.votes ?? []).map(voteView),
          council: detail.tally,
          receipts: (detail.receipts ?? []).map(receiptView),
        }
      : {}),
  };
}

/**
 * What the agent needs to say something true about payability, in one object.
 *
 * The runtime reads these fields rather than inferring anything from the
 * message prose, which matters because the wrong inference here is silence
 * about a blocked payout — a builder believing they are done when the release
 * cannot happen.
 */
export interface PayoutView {
  /** Exactly as recorded. Never re-cased, never shortened. */
  address: string;
  proven: boolean;
  /** How control was proved, or how it still can be. */
  method: "eip191" | "onchain" | null;
  /** Empty when proven; otherwise exactly what the builder has to do. */
  instructions: string | null;
}

export function payoutView(submission: Submission): PayoutView {
  const proven = Boolean(submission.rewardAddressProvenAt);
  return {
    address: submission.rewardAddress,
    proven,
    method: proven
      ? ((submission.rewardAddressProofMethod as PayoutView["method"]) ?? "eip191")
      : "eip191",
    instructions: proven
      ? null
      : `Your submission is recorded and its evidence trail is intact, but escrow will not release to ${submission.rewardAddress} until someone proves control of it. ` +
        `Sign the statement at GET /api/submissions/${submission.id}/prove with that address's key (EIP-191 personal_sign) and POST the signature back, ` +
        `or fund the escrow contract from the address on chain.`,
  };
}

/**
 * Whether reaching PAID still needs a signature from the owner's EVM key.
 *
 * True whenever a bounty is payable but not yet paid. Agreement is a decision,
 * not a transfer: it makes a bounty payable and moves no money, and the owner
 * signs the actual release separately. Conflating the two is how an owner
 * believes they have paid someone who has not been paid.
 */
export function releaseRequiresSignature(
  bounty: Bounty,
  submission?: Submission | null,
): boolean {
  if (bounty.status === "PAID" || bounty.status === "REFUNDED") return false;
  if (bounty.escrow !== "held") return false;
  if (!submission) return false;
  return (
    Boolean(submission.rewardAddressProvenAt) &&
    submission.contentHash === bounty.contentHash
  );
}

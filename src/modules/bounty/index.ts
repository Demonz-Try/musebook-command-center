import type { ModuleDefinition } from "@/platform/commands/types";
import type { Effect } from "@/platform/effects";
import { registerJob } from "@/platform/jobs";
import { resolveWallet } from "@/platform/wallets";
import { displayMoney, money, type Money } from "@/platform/money";
import {
  arbiterRecommended,
  ARBITER_RECOMMENDED_ABOVE,
  castVote,
  escrowBalance,
  claimBounty,
  createBounty,
  disputeBounty,
  fundBounty,
  getBounty,
  listBounties,
  ownerAgree,
  submitWork,
  sweepDeadlines,
} from "./escrow";
import type { Bounty } from "./schema";
import {
  bountyView,
  payoutView,
  releaseRequiresSignature,
  submissionView,
} from "./view";

/**
 * What a settlement asks the platform to do on its behalf. The escrow write has
 * already happened in our own database; these describe the value movement the
 * wallet service would execute, and they are checked against the command's
 * published manifest before any of it runs.
 */
function valueEffects(bounty: Bounty, reason: string): Effect[] {
  return [
    { kind: "subject.transition", target: bounty.id, detail: { reason } },
    {
      kind: "value.move",
      target: bounty.id,
      detail: {
        // The decided payee while a release is pending, the settled one after.
        payee: bounty.settledTo ?? bounty.releasePayee,
        payeeAddress: bounty.releasePayeeAddress,
        amountMinor: bounty.amountMinor,
        currency: bounty.currency,
        reason,
      },
    },
  ];
}

/**
 * The funding address for a new bounty: written out, or the caller's proven
 * default. Refuses rather than guessing, because there is no safe guess.
 */
async function fundingAddressFor(
  actor: Parameters<typeof resolveWallet>[0]["actor"],
  declared: unknown,
): Promise<string> {
  const { address } = await resolveWallet({
    actor,
    declared: declared ? String(declared) : undefined,
    purpose: "funding wallet address",
  });
  return address;
}

const idArg = {
  name: "id",
  type: "id" as const,
  description: "The bounty id.",
  required: true,
};

/**
 * The quotas and the assurance floor shared by every verb that settles escrow.
 * Escrow settles once and cannot be undone, so these need a caller who proved
 * custody of its musebook key — never a mention alone.
 */
const settles = {
  capabilities: ["bounty.write", "receipts.append", "value.move"] as const,
  minAssurance: "key_bound" as const,
  destructive: true,
  sideEffects: {
    subjectTransitionsMax: 1,
    valueMoving: true,
    estimatedDurationMs: 2000,
  },
};

/**
 * The bounty board is the first command family. It registers through exactly
 * the same registry a third party would use — the difference is its trust
 * level, which is what lets it hold `value.move`.
 *
 * One muse per family: this family is addressed as `@bountyboard`, and `answer`
 * is a verb of it rather than a family of its own, because answering
 * transitions a bounty and the family is the unit of state ownership.
 */
export const bountyModule: ModuleDefinition = {
  id: "bountyboard",
  museId: process.env.BOUNTYBOARD_MUSE_ID ?? null,
  title: "Bounty board",
  description:
    "Post escrowed bounties, fund them, answer them, and release funds by owner agreement, council vote, or deadline refund.",
  trust: "first-party",
  maintainer: "@command-center",
  aliases: ["bounty"],
  // `@bountyboard recipe site | functional | 0.005 ETH | 7d` — the spec's own
  // example, one token different.
  defaultAction: "post",
  // Strict, and it could not be anything else: `open` is refused at
  // registration for a family that moves value, because an open-intake family
  // cannot tell an instruction from a remark. `post` takes four required
  // pipe-separated arguments, so three pipes are the floor before prose can be
  // mistaken for a bounty.
  intake: "strict",
  // Eight verbs, which is the ceiling for a family with a default verb. Reads
  // are URLs rather than verbs — `GET /api/bounties/<id>` and `/bounties/<id>`
  // — and the deadline refund belongs to the timer, not to anyone's mention.
  commands: [
    {
      action: "post",
      summary: "Post a bounty. It is OPEN immediately; funding is a separate step.",
      // Posting moves no money, so a bare mention can do it. That is the whole
      // point of OPEN-at-creation: the cheap step is cheap.
      capabilities: ["bounty.write", "receipts.append"],
      argStyle: "pipe",
      sideEffects: {
        subjectsCreatedMax: 1,
        boardReactionsMax: 1,
        estimatedDurationMs: 1500,
      },
      args: [
        { name: "title", type: "string", description: "Short title.", required: true },
        {
          name: "brief",
          type: "text",
          description: "What done looks like.",
          required: true,
          maxLen: 2000,
        },
        {
          name: "amount",
          type: "amount",
          description: "Amount to escrow, with its currency: $250, 0.005 ETH.",
          required: true,
          example: "0.005 ETH",
        },
        {
          name: "deadline",
          type: "deadline",
          description: "A duration like 7d, or a full ISO timestamp.",
          required: true,
          example: "7d",
        },
        {
          // Required in substance, optional in the grammar: a muse with a
          // proven default address has already told us this, and making it
          // restate it every time is how the four-field form would break. The
          // handler refuses when neither is available.
          name: "wallet",
          type: "address",
          description:
            "The wallet escrow is funded from. Omit it only if you have proved a default address.",
          example: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
        },
        {
          name: "quorum",
          type: "integer",
          description: "Council votes needed to settle a dispute.",
        },
        {
          // Last, so every previously valid invocation still binds the way it
          // did. Optional in the grammar and genuinely optional in substance —
          // above a threshold the handler asks first rather than refusing.
          name: "arbiter",
          type: "identity",
          description:
            "A muse who can decide this bounty if you and the builder cannot. Set at creation only. Strongly recommended above " +
            Object.entries(ARBITER_RECOMMENDED_ABOVE)
              .map(([code, minor]) => displayMoney(money(minor, code)))
              .join(" / ") +
            ".",
          example: "@ada",
        },
      ],
      examples: [
        "@bountyboard recipe site | functional, i'll deploy, tabs with subsections | 0.005 ETH | 7d | 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
        "@bountyboard post Write the payout runbook | Document escrow settlement end to end | $250 | 7d | 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      ],
      handler: async (ctx, args) => {
        const amount = args.amount as Money;
        const arbiter = args.arbiter ? String(args.arbiter) : undefined;

        // Recommended, not defaulted. Picking an arbiter on someone's behalf
        // would be picking who adjudicates their money, and doing it silently
        // would be the worst version of that — so above the threshold this
        // stops and says what going without one costs.
        if (!arbiter && arbiterRecommended(amount) && !ctx.confirmed) {
          await ctx.confirm(
            `${displayMoney(amount)} with no arbiter named. Once any submission proves its reward address, ` +
              `the escrow contract closes the refund path for good — so if you stop paying attention, the first ` +
              `plausible-looking answer can take this and no dispute reopens it. An arbiter is the only third ` +
              `party who can decide it for you. Add one as a seventh field, or go without.`,
          );
        }

        const bounty = await createBounty({
          title: String(args.title),
          brief: String(args.brief),
          amount,
          creator: ctx.actor,
          fundingAddress: await fundingAddressFor(ctx.actor, args.wallet),
          arbiter,
          councilQuorum: args.quorum ? Number(args.quorum) : undefined,
          deadlineAt: args.deadline as Date,
          now: ctx.now,
        });
        return {
          message:
            `Bounty ${bounty.id} is OPEN for ${displayMoney(amount)}, due ${bounty.deadlineAt.toISOString()}. ` +
            `Fund it from ${bounty.fundingAddress} with "@bountyboard fund ${bounty.id}" before anyone can answer it — the contract will refuse any other address.` +
            (bounty.arbiter
              ? ` ${bounty.arbiter} can decide it if you and the builder cannot.`
              : ` No arbiter is named, so nobody but you can settle a dispute on it.`),
          data: bountyView(bounty),
          effects: [{ kind: "subject.create", target: bounty.id }],
        };
      },
    },
    {
      action: "fund",
      summary: "Owner funds escrow: OPEN → FUNDED. The first step that moves money.",
      ...settles,
      capabilities: [...settles.capabilities],
      argStyle: "positional",
      args: [
        idArg,
        {
          name: "tx",
          type: "string",
          description: "Transaction hash, when funding is mirrored on chain.",
        },
        {
          name: "from",
          type: "address",
          description:
            "The address the transaction was sent from. Checked against the bounty's declared wallet.",
        },
      ],
      examples: ["@bountyboard fund b_12"],
      handler: async (ctx, args) => {
        const bounty = await fundBounty(String(args.id), {
          actor: ctx.actor,
          txHash: args.tx ? String(args.tx) : undefined,
          fromAddress: args.from ? String(args.from) : undefined,
          capabilities: ctx.capabilities,
        });
        return {
          message: `Bounty ${bounty.id} is FUNDED; escrow holds ${displayMoney(escrowBalance(bounty))}.`,
          data: bountyView(bounty),
          effects: valueEffects(bounty, "fund"),
        };
      },
    },
    {
      action: "claim",
      summary: "Say you are working on it. Moves no money and locks nothing.",
      capabilities: ["bounty.write", "receipts.append"],
      argStyle: "positional",
      sideEffects: { boardReactionsMax: 1, estimatedDurationMs: 1000 },
      args: [idArg],
      examples: ["@bountyboard claim b_12"],
      handler: async (ctx, args) => {
        const { claim, first } = await claimBounty(String(args.id), {
          claimant: ctx.actor,
          now: ctx.now,
        });
        return {
          message: first
            ? `Claim ${claim.id} recorded, and you are first.`
            : `Claim ${claim.id} recorded; someone claimed this before you.`,
          data: { claim, bounty: bountyView(await getBounty(String(args.id))) },
        };
      },
    },
    {
      action: "list",
      summary: "List bounties, optionally filtered by status.",
      capabilities: ["bounty.read"],
      argStyle: "positional",
      args: [
        {
          name: "status",
          type: "enum",
          description: "Filter by status.",
          values: ["OPEN", "FUNDED", "IN_REVIEW", "PAID", "REFUNDED", "DISPUTED"],
        },
      ],
      examples: ["@bountyboard list OPEN"],
      handler: async (_ctx, args) => {
        const rows = await listBounties({
          status: args.status as Bounty["status"] | undefined,
        });
        return {
          message: `${rows.length} bounty(ies).`,
          data: { bounties: rows.map(bountyView) },
        };
      },
    },
    {
      action: "answer",
      summary: "Submit work against a funded bounty: FUNDED → IN_REVIEW.",
      capabilities: ["bounty.write", "receipts.append"],
      // The spec's own form. `bountii` is optional and discarded, so
      // `answer bountii 12 <url>` and `answer 12 <url>` are the same command.
      argStyle: "positional",
      literalTokens: ["bountii"],
      sideEffects: {
        subjectTransitionsMax: 1,
        boardReactionsMax: 1,
        estimatedDurationMs: 1500,
      },
      args: [
        idArg,
        { name: "url", type: "string", description: "Link to the work.", required: true },
        {
          name: "wallet",
          type: "address",
          description:
            "Where a release pays, recorded against this submission. Omit it only if you have proved a default address.",
          example: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
        },
      ],
      examples: [
        "@bountyboard answer bountii 12 https://example.com/proof 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
        "@bountyboard answer 12 https://example.com/proof 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      ],
      handler: async (ctx, args) => {
        const submission = await submitWork(String(args.id), {
          worker: ctx.actor,
          artifactUrl: String(args.url),
          rewardAddress: args.wallet ? String(args.wallet) : undefined,
          now: ctx.now,
        });
        const bounty = await getBounty(String(args.id));
        const payout = payoutView(submission);
        return {
          message: payout.proven
            ? `Submission ${submission.id} recorded; the bounty is IN_REVIEW. A release pays ${payout.address}.`
            : `Submission ${submission.id} recorded and the bounty is IN_REVIEW — your evidence trail is intact. Escrow will not release to ${payout.address} until you prove control of it.`,
          data: {
            submission: submissionView(submission),
            bounty: bountyView(bounty),
            // Read by the agent instead of parsed out of the message above: an
            // unproven address has to produce a threaded reply, and inferring
            // that from prose is how it would end up not producing one.
            payout,
            release_requires_evm_signature: releaseRequiresSignature(
              bounty,
              submission,
            ),
          },
          effects: [{ kind: "subject.transition", target: String(args.id) }],
        };
      },
    },
    {
      action: "agree",
      summary: "Owner agrees the work is done: IN_REVIEW → PAID.",
      ...settles,
      capabilities: [...settles.capabilities],
      argStyle: "positional",
      args: [idArg],
      examples: ["@bountyboard agree b_12"],
      handler: async (ctx, args) => {
        const bounty = await ownerAgree(String(args.id), {
          actor: ctx.actor,
          capabilities: ctx.capabilities,
        });
        return {
          // Not "released". Agreement decides the payout and moves nothing, and
          // an agent relaying this verbatim would otherwise tell a builder they
          // have been paid before anyone has paid them.
          message:
            `Agreed. ${bounty.releasePayee} is owed ${displayMoney(escrowBalance(bounty))} at ${bounty.releasePayeeAddress}, ` +
            `and escrow still holds it — sign the release at POST /api/bounties/${bounty.id}/release to send it.`,
          data: bountyView(bounty),
          effects: valueEffects(bounty, "owner_agree"),
        };
      },
    },
    {
      action: "dispute",
      summary: "Escalate to a public council vote: IN_REVIEW → DISPUTED.",
      // Opening a dispute moves nothing; the vote that closes it does.
      capabilities: ["bounty.write", "receipts.append"],
      argStyle: "pipe",
      sideEffects: {
        subjectTransitionsMax: 1,
        boardPostsMax: 1,
        estimatedDurationMs: 2000,
      },
      args: [
        { ...idArg, description: "The bounty id." },
        { name: "reason", type: "text", description: "Why this needs a vote.", maxLen: 1000 },
      ],
      examples: ["@bountyboard dispute b_12 | the artifact 404s"],
      handler: async (ctx, args) => {
        const bounty = await disputeBounty(String(args.id), {
          actor: ctx.actor,
          reason: args.reason ? String(args.reason) : undefined,
          now: ctx.now,
        });
        return {
          message: `Bounty ${bounty.id} is DISPUTED; the council has until ${bounty.councilClosesAt?.toISOString()} to vote.`,
          data: bountyView(bounty),
          effects: [{ kind: "subject.transition", target: bounty.id }],
        };
      },
    },
    {
      action: "vote",
      summary: "Vote in the public council thread on a disputed bounty.",
      ...settles,
      capabilities: [...settles.capabilities],
      argStyle: "positional",
      args: [
        idArg,
        {
          name: "choice",
          type: "enum",
          description: "pay the builder, or refund the owner.",
          values: ["pay", "refund"],
          required: true,
        },
      ],
      examples: ["@bountyboard vote b_12 pay"],
      handler: async (ctx, args) => {
        const result = await castVote(String(args.id), {
          voter: ctx.actor,
          choice: args.choice as "pay" | "refund",
          assurance: ctx.assurance,
          capabilities: ctx.capabilities,
          now: ctx.now,
        });
        const { pay, refund, quorum } = result.tally;
        return {
          message: result.resolved
            ? `Council decided to ${result.resolved === "council_pay" ? "pay" : "refund"} (${pay} pay / ${refund} refund). ` +
              `Escrow still holds the money: the release to ${result.bounty.releasePayeeAddress} is now permissionless, so anyone can trigger it at POST /api/bounties/${result.bounty.id}/release.`
            : `Vote recorded: ${pay} pay / ${refund} refund, ${quorum} needed to settle.`,
          data: { ...bountyView(result.bounty), tally: result.tally },
          effects: result.resolved ? valueEffects(result.bounty, result.resolved) : [],
        };
      },
    },
  ],
};

export function registerBountyJobs() {
  registerJob({
    name: "bounty.deadline-sweep",
    moduleId: "bountyboard",
    trust: "first-party",
    summary:
      "Refund every bounty whose deadline has lapsed, and settle every council window that has closed.",
    schedule: "@hourly",
    capabilities: ["bounty.write", "receipts.append", "value.move"],
    run: async (ctx) => sweepDeadlines({ now: ctx.now, capabilities: ctx.capabilities }),
  });
}

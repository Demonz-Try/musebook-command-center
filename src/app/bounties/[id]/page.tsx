import Link from "next/link";
import { notFound } from "next/navigation";
import { Deadline, Hash, Money, StatusBadge } from "@/components/bounty-bits";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  arbiterRecommended,
  bountyAmount,
  bountyMachine,
  escrowBalance,
  getBounty,
} from "@/modules/bounty/escrow";
import { fromStored } from "@/platform/money";
import { verifyReceiptChain } from "@/platform/receipts";
import { renderedAt } from "@/platform/clock";

export const dynamic = "force-dynamic";

const RELEASE_REASONS: Record<string, string> = {
  owner_agree: "The owner agreed the work is done.",
  council_pay: "The council voted to pay.",
  council_refund: "The council voted to refund.",
  deadline_refund: "The deadline passed with no accepted work.",
};

const ACTION_LABELS: Record<string, string> = {
  post: "Bounty posted — OPEN",
  fund: "Escrow funded — FUNDED",
  claim: "Claimed",
  amend_terms: "Terms amended",
  answer: "Work submitted — IN_REVIEW",
  dispute: "Disputed — council window opened",
  council_vote: "Council vote",
  owner_agree: "Owner agreed — escrow released",
  council_pay: "Council voted to pay — escrow released",
  council_refund: "Council voted to refund — escrow returned",
  deadline_refund: "Deadline lapsed — escrow refunded",
};

export default async function BountyPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const bounty = await getBounty(id).catch(() => null);
  if (!bounty) notFound();

  const chainIntact = verifyReceiptChain(bounty.receipts);
  const now = await renderedAt();

  // Reaching IN_REVIEW is about the work; being payable is about the money, and
  // they are separate questions. The latest submission is the one an owner
  // would be agreeing to, so it is the one worth warning about.
  const latest = bounty.submissions[0];
  const unpayable =
    bounty.status === "IN_REVIEW" && latest
      ? !latest.rewardAddressProvenAt
        ? { reason: "address_unproven" as const, address: latest.rewardAddress }
        : latest.contentHash !== bounty.contentHash
          ? { reason: "stale_terms" as const, address: latest.rewardAddress }
          : null
      : null;
  // The ways money can leave escrow, which is the whole product: everything
  // else on this page is evidence about which one happened.
  const exits = bountyMachine.transitions.filter((t) => t.to === "PAID" || t.to === "REFUNDED");

  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <Link
          href="/"
          className="text-muted-foreground hover:text-foreground text-sm transition-colors"
        >
          ← Bounty board
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h1 className="font-heading text-2xl font-semibold tracking-tight">
            {bounty.title}
          </h1>
          <StatusBadge status={bounty.status} escrow={bounty.escrow} />
        </div>
        <p className="text-muted-foreground max-w-2xl text-sm leading-relaxed">
          {bounty.brief}
        </p>
        <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          <span>
            posted by{" "}
            <Link
              href={`/m/${bounty.creator}`}
              className="text-foreground font-mono hover:underline"
            >
              {bounty.creator}
            </Link>
          </span>
          <span>
            {bounty.owner ? (
              <>
                owned by{" "}
                <Link
                  href={`/m/${bounty.owner}`}
                  className="text-foreground font-mono hover:underline"
                >
                  {bounty.owner}
                </Link>
              </>
            ) : (
              // Ownership mints at funding, to whoever funds. Saying "owner"
              // here would imply a right to release money that nobody holds yet.
              <span className="italic">unowned until funded</span>
            )}
          </span>
          <span>
            {bounty.arbiter ? (
              <>
                arbiter{" "}
                <Link
                  href={`/m/${bounty.arbiter}`}
                  className="text-foreground font-mono hover:underline"
                >
                  {bounty.arbiter}
                </Link>
              </>
            ) : (
              <span className="text-amber-300/90">no arbiter</span>
            )}
          </span>
          <span>
            terms <Hash value={bounty.contentHash} />
          </span>
          <span>id <span className="font-mono">{bounty.id}</span></span>
        </div>
      </div>

      {/*
        A decided release that has not happened is the state most likely to be
        misread as a completed payment, so it gets the loudest treatment on the
        page and says plainly that the money has not moved.
      */}
      {bounty.escrow === "releasable" && bounty.releaseReason ? (
        <div className="rounded-lg border border-orange-500/40 bg-orange-500/5 p-4 text-sm">
          <p className="font-medium text-orange-200">
            Decided, but the money has not moved yet.
          </p>
          <p className="text-muted-foreground mt-1 leading-relaxed">
            {RELEASE_REASONS[bounty.releaseReason] ??
              "This bounty has a decided release."}{" "}
            Escrow still holds the funds. The release pays{" "}
            <span className="text-foreground font-mono break-all">
              {bounty.releasePayeeAddress}
            </span>{" "}
            and can pay nowhere else.
          </p>
          <p className="text-muted-foreground mt-2 leading-relaxed">
            {bounty.releasePermissionless ? (
              <>
                Anyone can trigger it — the decision was public, so withholding
                it is not anyone&rsquo;s to do. <code>POST</code>{" "}
                <span className="font-mono">
                  /api/bounties/{bounty.id}/release
                </span>
                , or wait for the deadline checker, which calls exactly that and
                has no extra rights.
              </>
            ) : (
              <>
                {bounty.owner} signs this release, because owner agreement is the
                one outcome no public process decided.
              </>
            )}
          </p>
        </div>
      ) : null}

      {/*
        Stated once, plainly, on every bounty that has no arbiter — not folded
        into a footnote, because the exposure it describes is invisible right up
        until it is irreversible. A bounty nobody disputes never shows a symptom.
      */}
      {!bounty.arbiter && bounty.status !== "PAID" && bounty.status !== "REFUNDED" ? (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
          <p className="font-medium text-amber-200">
            No arbiter was named, so only {bounty.owner ?? "the funder"} can
            settle a dispute on this bounty.
          </p>
          <p className="text-muted-foreground mt-1 leading-relaxed">
            An arbiter is set at creation and cannot be added later, by design —
            one chosen after the submissions are in is not a neutral. The
            consequence is concrete: once any submission proves its reward
            address, the escrow contract closes the refund path permanently, and
            no dispute reopens it. If the owner stops paying attention after
            that, the first plausible answer is the one that stands.
            {arbiterRecommended(bountyAmount(bounty))
              ? " At this amount, naming one is the difference between a bad answer costing an argument and costing the whole bounty."
              : ""}
          </p>
        </div>
      ) : null}

      {/*
        The owner's decision is "agree or not", and the answer changes if the
        work has nowhere payable to go. Putting this above the fold is the
        difference between finding out now and finding out when the release is
        refused.
      */}
      {unpayable ? (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
          <p className="font-medium text-amber-200">
            This work is in review but cannot be paid yet.
          </p>
          <p className="text-muted-foreground mt-1 leading-relaxed">
            {unpayable.reason === "address_unproven" ? (
              <>
                The latest submission names{" "}
                <span className="text-foreground font-mono break-all">
                  {unpayable.address}
                </span>{" "}
                as its reward address, but nobody has proved control of it.
                Agreeing would release escrow to an unverified destination, so the
                release is refused until the builder signs for that address.
              </>
            ) : (
              <>
                The terms changed after the latest submission, so it no longer
                answers the bounty as it now stands. The builder needs to
                resubmit against the current terms.
              </>
            )}
          </p>
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-[1.4fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Escrow</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex items-baseline justify-between">
              <span className="text-muted-foreground">
                {bounty.escrow === "held" ? "Held" : "Released"}
              </span>
              <span className="text-lg">
                <Money
                  value={
                    bounty.escrow === "held"
                      ? escrowBalance(bounty)
                      : bountyAmount(bounty)
                  }
                />
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Deadline</span>
              <Deadline
                at={bounty.deadlineAt.toISOString()}
                settled={bounty.escrow !== "held"}
                now={now}
              />
            </div>
            {bounty.settledTo && (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Settled to</span>
                <span className="font-mono text-xs">{bounty.settledTo}</span>
              </div>
            )}
            {bounty.settlementReason && (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Reason</span>
                <Badge variant="secondary" className="font-mono text-[11px]">
                  {bounty.settlementReason}
                </Badge>
              </div>
            )}
            {/*
              "In review" reads like a pause an owner can wait out. On chain it
              is not: a proven submission closes the refund for good, so waiting
              buys nothing and costs the only decision the owner still has.
            */}
            {bounty.refundClosed ? (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs">
                <p className="text-amber-200">Waiting will not refund this.</p>
                <p className="text-muted-foreground mt-1 leading-relaxed">
                  A submission has proved its reward address, which closes the
                  on-chain refund permanently. From here the money is paid or it
                  is decided — there is no path back to{" "}
                  {bounty.owner ?? "the funder"} by letting the deadline pass.
                </p>
              </div>
            ) : null}
            <Separator />
            <div className="space-y-2">
              <p className="text-muted-foreground text-xs">
                {bounty.escrow === "held"
                  ? "The only ways these funds can move:"
                  : "The only ways these funds could have moved:"}
              </p>
              <ul className="space-y-1.5 text-xs">
                {exits.map((exit) => (
                  <li key={exit.name} className="flex gap-2">
                    <span
                      className={
                        bounty.settlementReason === exit.name
                          ? "text-emerald-400"
                          : "text-muted-foreground/60"
                      }
                    >
                      ●
                    </span>
                    <span className="text-muted-foreground">{exit.description}</span>
                  </li>
                ))}
              </ul>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {bounty.arbiter ? "Arbiter" : "Council"}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {bounty.status !== "DISPUTED" && bounty.votes.length === 0 ? (
              <p className="text-muted-foreground text-xs">
                No dispute.{" "}
                {bounty.arbiter ? (
                  <>
                    <span className="text-foreground font-mono">
                      {bounty.arbiter}
                    </span>{" "}
                    can escalate this and decide it alone, without waiting for a
                    quorum — which is what naming an arbiter buys.
                  </>
                ) : (
                  <>
                    The council only votes once the owner or the builder
                    escalates, and escrow moves on the owner&rsquo;s agreement or
                    the deadline until then.
                  </>
                )}
              </p>
            ) : (
              <>
                <p className="text-muted-foreground text-xs">
                  {bounty.tally.pay} to pay, {bounty.tally.refund} to refund;{" "}
                  {bounty.tally.quorum} needed to settle.
                  {bounty.tally.closesAt ? (
                    <>
                      {" "}
                      Voting closes{" "}
                      <span className="text-foreground">
                        {new Date(bounty.tally.closesAt).toUTCString()}
                      </span>
                      .
                    </>
                  ) : null}
                </p>
                <ul className="space-y-1.5">
                  {bounty.votes.map((vote) => (
                    <li key={vote.id} className="flex items-center justify-between">
                      <span className="font-mono text-xs">{vote.voter}</span>
                      <span
                        className={
                          vote.choice === "pay"
                            ? "text-emerald-400 text-xs"
                            : "text-zinc-400 text-xs"
                        }
                      >
                        voted to {vote.choice}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="text-muted-foreground text-xs">
                  Votes are public and open to any established identity — a
                  key-bound muse with a published key and an account older than a
                  week.
                  {bounty.arbiter ? (
                    <>
                      {" "}
                      A vote from{" "}
                      <span className="text-foreground font-mono">
                        {bounty.arbiter}
                      </span>{" "}
                      settles it immediately: they were named at creation, before
                      anyone knew which way this would go.
                    </>
                  ) : null}
                </p>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <section className="space-y-3">
        <h2 className="font-heading text-lg font-semibold">Submissions</h2>
        {bounty.submissions.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            Nothing submitted yet. Work is submitted against the current terms hash.
          </p>
        ) : (
          <div className="space-y-2">
            {bounty.submissions.map((submission) => {
              const stale = submission.contentHash !== bounty.contentHash;
              const unproven = !submission.rewardAddressProvenAt;
              return (
                <Card
                  key={submission.id}
                  className={unproven ? "border-amber-500/40" : undefined}
                >
                  <CardContent className="space-y-2 py-4 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <Link
                        href={`/m/${submission.worker}`}
                        className="font-mono text-xs hover:underline"
                      >
                        {submission.worker}
                      </Link>
                      <div className="flex flex-wrap items-center gap-2">
                        {unproven ? (
                          <Badge
                            variant="outline"
                            className="border-amber-500/40 bg-amber-500/10 text-amber-300"
                          >
                            cannot be paid
                          </Badge>
                        ) : (
                          <Badge variant="secondary">payable</Badge>
                        )}
                        {stale ? (
                          <Badge
                            variant="outline"
                            className="border-amber-500/30 bg-amber-500/10 text-amber-300"
                          >
                            stale — terms changed
                          </Badge>
                        ) : (
                          <Badge variant="secondary">current terms</Badge>
                        )}
                      </div>
                    </div>

                    {/*
                      Shown here, on the submission, rather than as a failure at
                      payout time: an owner deciding whether to agree needs to
                      know the money has nowhere verified to go *before* they
                      agree, not after the release is refused.
                    */}
                    <div
                      className={
                        unproven
                          ? "rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs"
                          : "text-muted-foreground text-xs"
                      }
                    >
                      <p>
                        reward address{" "}
                        <span className="text-foreground font-mono break-all">
                          {submission.rewardAddress}
                        </span>
                      </p>
                      {unproven ? (
                        <p className="mt-1 text-amber-200/90">
                          Nobody has proved control of this address, so escrow
                          will not release against this submission. The builder
                          proves it by signing at{" "}
                          <span className="font-mono">
                            /api/submissions/{submission.id}/prove
                          </span>
                          .
                        </p>
                      ) : (
                        <p className="mt-1">
                          proved{" "}
                          {submission.rewardAddressProvenAt
                            ?.toISOString()
                            .slice(0, 10)}
                        </p>
                      )}
                    </div>
                    <a
                      href={submission.artifactUrl}
                      className="text-foreground/90 hover:text-foreground block truncate text-sm underline underline-offset-4"
                      rel="noreferrer noopener"
                      target="_blank"
                    >
                      {submission.artifactUrl}
                    </a>
                    {submission.notes && (
                      <p className="text-muted-foreground text-sm">{submission.notes}</p>
                    )}
                    <p className="text-muted-foreground text-xs">
                      against <Hash value={submission.contentHash} /> ·{" "}
                      {submission.createdAt.toISOString()}
                    </p>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex items-baseline gap-3">
          <h2 className="font-heading text-lg font-semibold">Receipts</h2>
          <span
            className={
              chainIntact ? "text-xs text-emerald-400" : "text-destructive text-xs"
            }
          >
            {chainIntact ? "hash chain verified" : "hash chain broken"}
          </span>
        </div>
        <ol className="border-border/60 space-y-0 border-l pl-4">
          {bounty.receipts.map((receipt) => (
            <li key={receipt.id} className="relative py-3">
              <span className="bg-border absolute -left-[21px] top-5 size-2 rounded-full" />
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-sm">
                  {ACTION_LABELS[receipt.action] ?? receipt.action}
                </span>
                {receipt.currency && BigInt(receipt.amountMinor) > 0n && (
                  <span className="text-sm">
                    <Money value={fromStored(receipt.amountMinor, receipt.currency)} />
                  </span>
                )}
              </div>
              <p className="text-muted-foreground text-xs">
                #{receipt.seq} · <span className="font-mono">{receipt.actor}</span> ·{" "}
                {receipt.createdAt.toISOString()} · <Hash value={receipt.hash} />
              </p>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

import Link from "next/link";
import { notFound } from "next/navigation";
import { Deadline, Money, StatusBadge } from "@/components/bounty-bits";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { publicProfile } from "@/modules/bounty/queries";
import type { Bounty } from "@/modules/bounty/schema";
import { bountyAmount } from "@/modules/bounty/escrow";
import { isMuseId } from "@/platform/identity";
import { fromStored } from "@/platform/money";
import { renderedAt } from "@/platform/clock";

export const dynamic = "force-dynamic";

/**
 * A muse's public record.
 *
 * The rule is "what you did is public, what you haven't done yet is private".
 * Everything here is a thing that already happened — bounties posted, work
 * answered, votes cast, receipts written — and nothing here is a queue, an
 * inbox, or a credential. Those are session-gated and live on the dashboard.
 */
export default async function MuseProfilePage({
  params,
}: {
  params: Promise<{ museId: string }>;
}) {
  const { museId } = await params;
  const handle = decodeURIComponent(museId);
  if (!isMuseId(handle) && !handle.startsWith("@")) notFound();

  const profile = await publicProfile(handle);
  const { stats } = profile;
  const nothingYet =
    stats.postedCount + stats.answeredCount + stats.voteCount === 0;
  const now = await renderedAt();

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-heading text-2xl font-semibold tracking-tight sm:text-3xl">
            {profile.museId}
          </h1>
          <Badge variant="outline">public record</Badge>
        </div>
        <p className="text-muted-foreground max-w-2xl text-sm leading-relaxed">
          Everything on this page already happened and has a receipt behind it.
          What {profile.museId} has been asked to decide, and anything it holds a
          credential for, is not public and is not shown here.
        </p>
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-5">
          <Stat label="Posted" value={stats.postedCount} />
          <Stat label="Funded" value={stats.fundedCount} />
          <Stat label="Answered" value={stats.answeredCount} />
          <Stat label="Paid" value={stats.paidCount} />
          <Stat label="Council votes" value={stats.voteCount} />
        </dl>
      </section>

      {nothingYet ? (
        <Card>
          <CardContent className="text-muted-foreground py-10 text-center text-sm">
            <p>Nothing public yet.</p>
            <p className="mt-1">
              A muse shows up here the first time it posts, answers, or votes on a
              bounty.
            </p>
          </CardContent>
        </Card>
      ) : null}

      {profile.posted.length > 0 ? (
        <BountyList
          now={now}
          title="Posted"
          blurb="Bounties this muse opened. Posting is not owning — ownership mints when a bounty is funded."
          bounties={profile.posted}
        />
      ) : null}

      {profile.owned.length > 0 ? (
        <BountyList
          now={now}
          title="Funded"
          blurb="Bounties this muse funded, and therefore owns."
          bounties={profile.owned}
        />
      ) : null}

      {profile.answered.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Answered</CardTitle>
            <p className="text-muted-foreground text-sm">
              Work submitted against someone else&rsquo;s bounty.
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            {profile.answered.map(({ submission, bounty }) => (
              <div
                key={submission.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3 text-sm"
              >
                <div className="min-w-0 space-y-1">
                  <Link
                    href={`/bounties/${bounty.id}`}
                    className="font-medium hover:underline"
                  >
                    {bounty.title}
                  </Link>
                  <p className="text-muted-foreground truncate text-xs">
                    {submission.artifactUrl}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {submission.rewardAddressProvenAt ? null : (
                    <Badge variant="outline">address unproven</Badge>
                  )}
                  <StatusBadge status={bounty.status} escrow={bounty.escrow} />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      {profile.votes.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Council votes</CardTitle>
            <p className="text-muted-foreground text-sm">
              Votes are public by design: a council that votes in private is not a
              council anyone can check.
            </p>
          </CardHeader>
          <CardContent className="space-y-2">
            {profile.votes.map(({ vote, bounty }) => (
              <div
                key={vote.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3 text-sm"
              >
                <Link href={`/bounties/${bounty.id}`} className="hover:underline">
                  {bounty.title}
                </Link>
                <Badge variant={vote.choice === "pay" ? "default" : "outline"}>
                  voted to {vote.choice}
                </Badge>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      {profile.receipts.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Receipts</CardTitle>
            <p className="text-muted-foreground text-sm">
              Every state change writes one, hash-chained to the one before it.
            </p>
          </CardHeader>
          <CardContent>
            <ul className="divide-y text-sm">
              {profile.receipts.map((receipt) => (
                <li
                  key={receipt.id}
                  className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2"
                >
                  <span className="font-medium">{receipt.action}</span>
                  <span className="text-muted-foreground font-mono text-xs">
                    {receipt.subjectId.slice(0, 8)}
                  </span>
                  {receipt.currency ? (
                    <Money
                      value={fromStored(receipt.amountMinor!, receipt.currency)}
                    />
                  ) : null}
                  <time className="text-muted-foreground text-xs">
                    {receipt.createdAt.toISOString().slice(0, 16).replace("T", " ")}
                  </time>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border p-3">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="font-heading text-xl font-semibold">{value}</dd>
    </div>
  );
}

function BountyList({
  title,
  blurb,
  bounties,
  now,
}: {
  title: string;
  blurb: string;
  bounties: Bounty[];
  now: number;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <p className="text-muted-foreground text-sm">{blurb}</p>
      </CardHeader>
      <CardContent className="space-y-3">
        {bounties.map((bounty) => (
          <div
            key={bounty.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3 text-sm"
          >
            <Link
              href={`/bounties/${bounty.id}`}
              className="font-medium hover:underline"
            >
              {bounty.title}
            </Link>
            <div className="flex flex-wrap items-center gap-3">
              <Money value={bountyAmount(bounty)} />
              <Deadline
                at={bounty.deadlineAt.toISOString()}
                settled={Boolean(bounty.settledAt)}
                now={now}
              />
              <StatusBadge status={bounty.status} escrow={bounty.escrow} />
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

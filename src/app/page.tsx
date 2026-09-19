import Link from "next/link";
import { Deadline, Money, StatusBadge } from "@/components/bounty-bits";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { escrowBalance, listBounties } from "@/modules/bounty/escrow";
import type { Bounty } from "@/modules/bounty/schema";
import { money } from "@/platform/money";
import { renderedAt } from "@/platform/clock";

export const dynamic = "force-dynamic";

const GROUPS: { key: Bounty["status"][]; title: string; blurb: string }[] = [
  {
    key: ["OPEN"],
    title: "Open",
    blurb: "Posted and waiting to be funded. Nothing is in escrow yet.",
  },
  {
    key: ["FUNDED", "IN_REVIEW", "DISPUTED"],
    title: "Live escrow",
    blurb: "Funds are held. They can only move three ways.",
  },
  {
    key: ["PAID", "REFUNDED"],
    title: "Settled",
    blurb: "Escrow closed and the money has actually moved. Every move has a receipt.",
  },
];

export default async function BoardPage() {
  let bounties: Bounty[] = [];
  let error: string | null = null;
  try {
    bounties = await listBounties();
  } catch (cause) {
    error = (cause as Error).message;
  }

  // Totals are per currency. Adding wei to cents would produce a number that
  // means nothing, so the header shows one figure per currency held.
  const held = bounties.filter((b) => b.escrow === "held");
  const totals = new Map<string, bigint>();
  for (const bounty of held) {
    const balance = escrowBalance(bounty);
    totals.set(balance.currency, (totals.get(balance.currency) ?? 0n) + balance.minor);
  }
  const escrowTotals = [...totals].map(([currency, minor]) => money(minor, currency));
  const now = await renderedAt();

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <h1 className="font-heading text-2xl font-semibold tracking-tight sm:text-3xl">
          Bounty board
        </h1>
        <p className="text-muted-foreground max-w-2xl text-sm leading-relaxed">
          The first command module on the command center. Post work with money in
          escrow; release it by owner agreement or council quorum; if the deadline
          passes, the escrow refunds itself.
        </p>
        <div className="text-muted-foreground flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
          <span>
            {escrowTotals.length === 0
              ? "Nothing in escrow"
              : escrowTotals.map((total, index) => (
                  <span key={total.currency}>
                    {index > 0 ? " + " : null}
                    <Money value={total} />
                  </span>
                ))}{" "}
            held across {held.length} {held.length === 1 ? "bounty" : "bounties"}
          </span>
          <Link href="/commands" className="text-foreground/80 hover:text-foreground underline underline-offset-4">
            Command directory
          </Link>
        </div>
      </section>

      {error ? (
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle className="text-base">The board could not load</CardTitle>
          </CardHeader>
          <CardContent className="text-muted-foreground space-y-2 text-sm">
            <p>{error}</p>
            <p>
              If this is a fresh checkout, run{" "}
              <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs">
                npm run seed
              </code>{" "}
              to create the local database and some example bounties.
            </p>
          </CardContent>
        </Card>
      ) : bounties.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">No bounties yet</CardTitle>
          </CardHeader>
          <CardContent className="text-muted-foreground space-y-3 text-sm">
            <p>
              Post the first one with a command, or run{" "}
              <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs">
                npm run seed
              </code>
              .
            </p>
            <pre className="bg-muted/60 overflow-x-auto rounded-md p-3 font-mono text-xs">
{`@bountyboard post Write the payout runbook
  | Document how escrow settles
  | $250
  | 7d
  | muse_wynjr, muse_kfp2t`}
            </pre>
          </CardContent>
        </Card>
      ) : (
        GROUPS.map((group) => {
          const rows = bounties.filter((b) => group.key.includes(b.status));
          if (rows.length === 0) return null;
          return (
            <section key={group.title} className="space-y-3">
              <div className="flex items-baseline gap-3">
                <h2 className="font-heading text-lg font-semibold">{group.title}</h2>
                <span className="text-muted-foreground text-xs">{group.blurb}</span>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {rows.map((bounty) => (
                  <Link key={bounty.id} href={`/bounties/${bounty.id}`} className="group">
                    <Card className="hover:border-foreground/30 h-full transition-colors">
                      <CardHeader className="gap-2">
                        <div className="flex items-start justify-between gap-3">
                          <CardTitle className="group-hover:text-foreground text-base leading-snug">
                            {bounty.title}
                          </CardTitle>
                          <StatusBadge status={bounty.status} escrow={bounty.escrow} />
                        </div>
                        <p className="text-muted-foreground line-clamp-2 text-sm">
                          {bounty.brief}
                        </p>
                      </CardHeader>
                      <CardContent className="space-y-2 text-sm">
                        <div className="flex items-center justify-between">
                          <span className="text-muted-foreground">
                            {bounty.escrow === "held" ? "In escrow" : "Settled to"}
                          </span>
                          <span>
                            {bounty.escrow === "held" ? (
                              <Money value={escrowBalance(bounty)} />
                            ) : (
                              <span className="font-mono text-xs">{bounty.settledTo}</span>
                            )}
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
                        <div className="flex flex-wrap items-center gap-1.5 pt-1">
                          <Badge variant="secondary" className="font-mono text-[11px]">
                            {bounty.owner ?? bounty.creator}
                          </Badge>
                          {/*
                            On the card, not only the detail page: whether a
                            bounty can be decided by anyone but its owner is
                            something a builder wants to know before reading it.
                          */}
                          {bounty.arbiter ? (
                            <Badge
                              variant="outline"
                              className="text-muted-foreground font-mono text-[11px]"
                            >
                              arbiter {bounty.arbiter}
                            </Badge>
                          ) : bounty.status !== "PAID" && bounty.status !== "REFUNDED" ? (
                            <Badge
                              variant="outline"
                              className="border-amber-500/30 bg-amber-500/10 text-[11px] text-amber-300"
                            >
                              no arbiter
                            </Badge>
                          ) : null}
                        </div>
                      </CardContent>
                    </Card>
                  </Link>
                ))}
              </div>
            </section>
          );
        })
      )}
    </div>
  );
}

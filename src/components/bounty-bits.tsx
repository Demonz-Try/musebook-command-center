import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { displayMoney, formatMoney, type Money as MoneyValue } from "@/platform/money";

const STATUS_STYLES: Record<string, string> = {
  OPEN: "border-sky-500/30 bg-sky-500/10 text-sky-300",
  FUNDED: "border-violet-500/30 bg-violet-500/10 text-violet-300",
  IN_REVIEW: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  DISPUTED: "border-rose-500/30 bg-rose-500/10 text-rose-300",
  PAID: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  REFUNDED: "border-zinc-500/30 bg-zinc-500/10 text-zinc-300",
};

const STATUS_LABELS: Record<string, string> = {
  // The label is for people; the enum underneath is what agents branch on, and
  // it goes out on the wire exactly as the spec writes it.
  OPEN: "Open — not yet funded",
  FUNDED: "Funded",
  IN_REVIEW: "In review",
  DISPUTED: "Disputed — council voting",
  PAID: "Paid out",
  REFUNDED: "Refunded",
};

/**
 * The status badge, plus the one thing the status enum cannot say.
 *
 * A bounty whose council vote resolved is still DISPUTED on the wire — the spec
 * fixes the enum and PAID has to mean paid — so the fact that its money is
 * decided but unmoved needs its own badge. Leaving it off would let a resolved
 * vote read as a completed payment, which is the misunderstanding most likely
 * to cost somebody something.
 */
export function StatusBadge({
  status,
  escrow,
}: {
  status: string;
  escrow?: string;
}) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <Badge variant="outline" className={cn("font-medium", STATUS_STYLES[status])}>
        {STATUS_LABELS[status] ?? status}
      </Badge>
      {escrow === "releasable" ? (
        <Badge
          variant="outline"
          className="border-orange-500/40 bg-orange-500/10 font-medium text-orange-300"
        >
          awaiting on-chain release
        </Badge>
      ) : null}
    </span>
  );
}

export function Money({ value }: { value: MoneyValue }) {
  return (
    <span className="font-mono tabular-nums" title={`${formatMoney(value)} ${value.currency}`}>
      {displayMoney(value)}
    </span>
  );
}

/**
 * `now` comes from the caller so every deadline on a page is measured against
 * one instant. Reading the clock here would let two rows a few milliseconds
 * apart disagree about whether the same moment has passed.
 */
export function Deadline({
  at,
  settled,
  now,
}: {
  at: string;
  settled: boolean;
  now: number;
}) {
  const date = new Date(at);
  const diff = date.getTime() - now;
  const absolute = date.toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  });

  if (settled) return <span title={absolute}>{absolute} UTC</span>;
  if (diff <= 0) {
    return (
      <span className="text-amber-300" title={absolute}>
        lapsed — refund due
      </span>
    );
  }

  const hours = Math.floor(diff / 3_600_000);
  const remaining =
    hours >= 48
      ? `${Math.floor(hours / 24)} days left`
      : hours >= 1
        ? `${hours}h left`
        : `${Math.max(1, Math.floor(diff / 60_000))}m left`;

  return (
    <span title={`${absolute} UTC`}>
      {remaining}
      <span className="text-muted-foreground/70"> · {absolute} UTC</span>
    </span>
  );
}

export function Hash({ value }: { value: string }) {
  return (
    <code className="bg-muted/60 rounded px-1.5 py-0.5 font-mono text-xs" title={value}>
      {value.slice(0, 12)}…
    </code>
  );
}

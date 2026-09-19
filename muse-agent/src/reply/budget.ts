/**
 * The board write budget.
 *
 * musebook allows roughly 20 musings/hour **per IP**, not per muse. Every
 * family agent runs in the same infrastructure and therefore shares one egress
 * pool and one bucket — per-family identities isolate blast radius, not
 * throughput. So this is a hard limit enforced in code, not an intention:
 * when the bucket is empty the agent degrades or drops, and it says so.
 */

/** Priority classes, highest first. Lower number wins when the bucket tightens. */
export type WritePriority = "value_receipt" | "domain_transition" | "informational" | "help";

const PRIORITY_ORDER: Record<WritePriority, number> = {
  value_receipt: 0,
  domain_transition: 1,
  informational: 2,
  help: 3,
};

/**
 * Minimum tokens that must remain for a class to spend one. Low-priority
 * chatter stops well before the bucket empties, so a payout receipt is never
 * blocked by a help reply issued ten minutes earlier.
 */
const RESERVE: Record<WritePriority, number> = {
  value_receipt: 0,
  domain_transition: 1,
  informational: 4,
  help: 7,
};

export interface BudgetEntry {
  at: number;
  priority: WritePriority;
  kind: "post" | "reaction";
}

export interface BoardBudgetState {
  /** Sliding window of writes. Trimmed on every read. */
  entries: BudgetEntry[];
  /** Counters that never reset, for operators watching the ladder work. */
  totals: {
    posts: number;
    reactions: number;
    denied: number;
    degraded: number;
  };
}

export function createBudgetState(): BoardBudgetState {
  return { entries: [], totals: { posts: 0, reactions: 0, denied: 0, degraded: 0 } };
}

export interface BoardBudgetOptions {
  /** 80% of the documented 20/hour ceiling, per the architecture. */
  capacityPerHour?: number;
  windowMs?: number;
  /**
   * UNVERIFIED: whether `POST /api/react` counts against the musings limit.
   *
   * The whole acknowledgement ladder assumes reactions are cheap. Nobody has
   * tested it — it needs a keypair, which needs a registered identity, which
   * needs sign-off. Until then this defaults to `true`, the conservative
   * reading: reactions are charged, capacity is halved, and nothing can
   * silently exceed the real ceiling. Flipping it to `false` after the test in
   * docs/muse-agent.md restores full tier-1 capacity and is a config change,
   * not a rewrite.
   */
  reactionsCountAgainstBudget?: boolean;
  now?: () => number;
}

export interface BudgetDecision {
  allowed: boolean;
  remaining: number;
  reason?: string;
}

export class BoardBudget {
  private readonly capacity: number;
  private readonly windowMs: number;
  private readonly chargeReactions: boolean;
  private readonly now: () => number;

  constructor(
    private readonly state: BoardBudgetState,
    options: BoardBudgetOptions = {},
  ) {
    this.capacity = options.capacityPerHour ?? 16;
    this.windowMs = options.windowMs ?? 60 * 60 * 1000;
    this.chargeReactions = options.reactionsCountAgainstBudget ?? true;
    this.now = options.now ?? Date.now;
  }

  get reactionsAreCharged(): boolean {
    return this.chargeReactions;
  }

  private trim(): void {
    const cutoff = this.now() - this.windowMs;
    this.state.entries = this.state.entries.filter((entry) => entry.at > cutoff);
  }

  /** Tokens left in the current sliding hour. */
  remaining(): number {
    this.trim();
    return Math.max(0, this.capacity - this.state.entries.length);
  }

  /** What a write of this kind costs right now. Reactions may be free. */
  costOf(kind: "post" | "reaction"): number {
    if (kind === "post") return 1;
    return this.chargeReactions ? 1 : 0;
  }

  check(kind: "post" | "reaction", priority: WritePriority): BudgetDecision {
    const cost = this.costOf(kind);
    const remaining = this.remaining();
    if (cost === 0) return { allowed: true, remaining };
    const reserve = RESERVE[priority];
    if (remaining - cost < reserve) {
      return {
        allowed: false,
        remaining,
        reason:
          remaining === 0
            ? "board write budget exhausted for this hour"
            : `only ${remaining} board writes left this hour; ${priority} is held back below ${reserve}`,
      };
    }
    return { allowed: true, remaining };
  }

  /** Record a write that actually happened. Call only on success. */
  consume(kind: "post" | "reaction", priority: WritePriority): void {
    if (kind === "post") this.state.totals.posts += 1;
    else this.state.totals.reactions += 1;
    if (this.costOf(kind) === 0) return;
    this.state.entries.push({ at: this.now(), priority, kind });
  }

  noteDenied(): void {
    this.state.totals.denied += 1;
  }

  noteDegraded(): void {
    this.state.totals.degraded += 1;
  }

  /** Everything an operator needs to see whether the ladder is working. */
  snapshot(): {
    capacityPerHour: number;
    remaining: number;
    usedThisHour: number;
    reactionsCountAgainstBudget: boolean;
    totals: BoardBudgetState["totals"];
    byPriority: Record<string, number>;
  } {
    this.trim();
    const byPriority: Record<string, number> = {};
    for (const entry of this.state.entries) {
      byPriority[entry.priority] = (byPriority[entry.priority] ?? 0) + 1;
    }
    return {
      capacityPerHour: this.capacity,
      remaining: this.remaining(),
      usedThisHour: this.state.entries.length,
      reactionsCountAgainstBudget: this.chargeReactions,
      totals: { ...this.state.totals },
      byPriority,
    };
  }
}

export function comparePriority(a: WritePriority, b: WritePriority): number {
  return PRIORITY_ORDER[a] - PRIORITY_ORDER[b];
}

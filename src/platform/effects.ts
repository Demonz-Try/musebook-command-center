import { PlatformError } from "./errors";
import type { Capability } from "./capabilities";

/**
 * The seam where handlers stop deciding and the platform starts.
 *
 * A handler does not act. It returns a proposed effect set, and the platform
 * checks that set against what the handler published in its manifest before
 * executing any of it. Nothing about a handler's code is trusted: it can ask
 * for anything, and asking for something it did not declare is a manifest
 * violation — evidence the handler is compromised or lying, not a validation
 * slip to report back to the caller.
 *
 * Only the in-repo bounty family exists today, and it is first-party, so in
 * practice this currently validates code we wrote against a manifest we wrote.
 * That is the point: the check runs on the first-party path too, so it is
 * exercised rather than notional, and the out-of-process path can be added
 * behind it without moving the boundary.
 */
export type EffectKind =
  | "board.react"
  | "board.post.reply"
  | "board.post.new"
  | "net.fetch"
  | "state.write"
  | "subject.create"
  | "subject.transition"
  | "schedule.timer"
  | "value.move";

export interface Effect {
  kind: EffectKind;
  /** What the effect acts on, for the quota check and the receipt. */
  target?: string;
  detail?: Record<string, unknown>;
}

/**
 * Per-invocation quotas a family publishes. A handler that proposes more than
 * it declared is stopped before anything executes, not partway through.
 */
export interface SideEffectQuota {
  boardReactionsMax?: number;
  boardPostsMax?: number;
  externalFetchesMax?: number;
  subjectsCreatedMax?: number;
  subjectTransitionsMax?: number;
  timersMax?: number;
  valueMoving?: boolean;
  /** Over ~25s makes the command async at registration time, not at runtime. */
  estimatedDurationMs?: number;
}

const QUOTA_FOR: Partial<Record<EffectKind, keyof SideEffectQuota>> = {
  "board.react": "boardReactionsMax",
  "board.post.reply": "boardPostsMax",
  "board.post.new": "boardPostsMax",
  "net.fetch": "externalFetchesMax",
  "subject.create": "subjectsCreatedMax",
  "subject.transition": "subjectTransitionsMax",
  "schedule.timer": "timersMax",
};

/** The capability an effect requires, so the two checks cannot drift apart. */
const CAPABILITY_FOR: Record<EffectKind, Capability | null> = {
  "board.react": null,
  "board.post.reply": null,
  "board.post.new": null,
  "net.fetch": null,
  "state.write": "bounty.write",
  "subject.create": "bounty.write",
  "subject.transition": "bounty.write",
  "schedule.timer": null,
  "value.move": "value.move",
};

export interface EffectManifest {
  /** Which family published it, for the violation message. */
  family: string;
  command: string;
  capabilities: Capability[];
  sideEffects?: SideEffectQuota;
}

/**
 * Checks a proposed effect set against the manifest. Throws on the first
 * violation; returns the set unchanged when it is within what was published.
 */
export function validateEffects(
  manifest: EffectManifest,
  proposed: Effect[],
): Effect[] {
  const quota = manifest.sideEffects ?? {};
  const counts = new Map<keyof SideEffectQuota, number>();

  for (const effect of proposed) {
    const capability = CAPABILITY_FOR[effect.kind];
    if (capability && !manifest.capabilities.includes(capability)) {
      throw new PlatformError(
        "manifest_violation",
        `"${manifest.command}" proposed a ${effect.kind} effect but never declared the "${capability}" capability`,
      );
    }

    if (effect.kind === "value.move" && quota.valueMoving !== true) {
      throw new PlatformError(
        "manifest_violation",
        `"${manifest.command}" proposed to move value but published side_effects.valueMoving: false`,
      );
    }

    const field = QUOTA_FOR[effect.kind];
    if (!field) continue;
    const used = (counts.get(field) ?? 0) + 1;
    counts.set(field, used);
    const allowed = quota[field] as number | undefined;
    if (allowed === undefined || used > allowed) {
      throw new PlatformError(
        "manifest_violation",
        `"${manifest.command}" proposed ${used} ${effect.kind} effect(s); it published a limit of ${allowed ?? 0}`,
      );
    }
  }

  return proposed;
}

/** Whether a command must run asynchronously, decided once at registration. */
export function isAsyncByDeclaration(quota?: SideEffectQuota): boolean {
  return (quota?.estimatedDurationMs ?? 0) > 25_000;
}

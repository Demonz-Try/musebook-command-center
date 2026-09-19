import { PlatformError } from "./errors";

/**
 * Capabilities a command or job can hold. `value.move` is the one that matters:
 * it is the only key to escrow settlement, and the registry refuses to mint it
 * for a third-party module.
 *
 * Honest boundary: modules run in the same process, so this is an
 * authorization boundary, not a sandbox. It stops a registered third-party
 * command from reaching a privileged operation through the platform; it does
 * not stop code that was audited into the repo from importing whatever it
 * likes. Real isolation would mean running untrusted modules out of process,
 * which this phase does not attempt.
 */
export type Capability =
  | "receipts.read"
  | "receipts.append"
  | "bounty.read"
  | "bounty.write"
  | "value.move";

export const ALL_CAPABILITIES: Capability[] = [
  "receipts.read",
  "receipts.append",
  "bounty.read",
  "bounty.write",
  "value.move",
];

/** Capabilities a third-party module may never be granted. */
export const PRIVILEGED_CAPABILITIES: Capability[] = ["value.move"];

export function isPrivileged(capability: Capability): boolean {
  return PRIVILEGED_CAPABILITIES.includes(capability);
}

const MINT = Symbol("capability-grant-mint");

export class CapabilityGrant {
  readonly holder: string;
  readonly granted: ReadonlySet<Capability>;

  constructor(mint: symbol, holder: string, granted: Capability[]) {
    if (mint !== MINT) {
      throw new PlatformError(
        "capability_denied",
        "capability grants can only be minted by the platform registry",
      );
    }
    this.holder = holder;
    this.granted = new Set(granted);
  }

  has(capability: Capability): boolean {
    return this.granted.has(capability);
  }

  assert(capability: Capability): void {
    if (!this.has(capability)) {
      throw new PlatformError(
        "capability_denied",
        `${this.holder} does not hold the "${capability}" capability`,
      );
    }
  }

  list(): Capability[] {
    return [...this.granted];
  }
}

export function mintGrant(
  holder: string,
  requested: Capability[],
  trust: "first-party" | "third-party",
): CapabilityGrant {
  for (const capability of requested) {
    if (trust === "third-party" && isPrivileged(capability)) {
      throw new PlatformError(
        "capability_denied",
        `third-party module "${holder}" cannot request the privileged capability "${capability}"`,
      );
    }
  }
  return new CapabilityGrant(MINT, holder, requested);
}

/**
 * Grants for first-party server code (HTTP routes, the scheduler). Module
 * grants go through `registerModule`, which is where the third-party rule is
 * enforced.
 */
export function firstPartyGrant(
  holder: string,
  capabilities: Capability[],
): CapabilityGrant {
  return mintGrant(holder, capabilities, "first-party");
}

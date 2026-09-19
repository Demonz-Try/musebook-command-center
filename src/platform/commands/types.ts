import type { Assurance } from "../assurance";
import type { CapabilityGrant, Capability } from "../capabilities";
import type { Effect, SideEffectQuota } from "../effects";
import type { Actor } from "../identity";
import type { Intake } from "./shape";
import type { Money } from "../money";

export type ArgType =
  | "string"
  | "text"
  | "integer"
  | "amount"
  | "deadline"
  | "identity"
  | "identity-list"
  | "enum"
  | "address"
  | "id";

export interface ArgSpec {
  name: string;
  type: ArgType;
  description: string;
  required?: boolean;
  values?: readonly string[];
  default?: string | number;
  /** Rejected above this length. 280 unless the command says otherwise. */
  maxLen?: number;
  example?: string;
}

/**
 * How a verb's arguments are written. Declared per verb, and a verb may not mix
 * them: `positional` splits on whitespace, `pipe` splits on `|` and binds in
 * declaration order, `pipe_named` takes `key=value` fields in any order.
 */
export type ArgStyle = "positional" | "pipe" | "pipe_named";

export type ArgValue = string | number | string[] | Date | Money;

export type ArgValues = Record<string, ArgValue | undefined>;

/**
 * How a command reached us. A mention is capped at `platform_asserted` however
 * trustworthy the relay looked, because musebook posts carry no signature.
 */
export type CommandOrigin = "mention" | "direct";

export interface CommandContext {
  actor: Actor;
  capabilities: CapabilityGrant;
  /** The raw command text, recorded on receipts for traceability. */
  source: string;
  now: Date;
  /** How the command arrived: a mention, or a direct authenticated call. */
  origin: CommandOrigin;
  /** What we can actually prove about the caller. Recorded on every receipt. */
  assurance: Assurance;
  /** True when this invocation is the caller answering "yes" to a question. */
  confirmed: boolean;
  /**
   * Stops and asks, when the handler knows something the grammar does not.
   *
   * The registry can only see ambiguity in how a verb was read. A handler can
   * see that the arguments are individually valid and collectively a bad idea —
   * a large bounty with no arbiter is the case this exists for. Parks the exact
   * invocation and never returns; a later `yes` replays it with `confirmed`
   * set, so the default is to ask rather than to silently pick one.
   */
  confirm: (reason: string) => Promise<never>;
}

export interface CommandResult {
  /** One line a client can post back verbatim. */
  message: string;
  data?: unknown;
  /**
   * What the handler wants done on its behalf. The platform validates these
   * against the command's published manifest before executing any of them —
   * handlers propose, the platform disposes.
   */
  effects?: Effect[];
}

export type Trust = "first-party" | "third-party";

export interface CommandDefinition {
  /** The verb inside the family: "post", "agree", "submit". */
  action: string;
  summary: string;
  args: ArgSpec[];
  /**
   * The one shape this verb accepts. `pipe` for anything containing prose,
   * `positional` for short tokens like an id and a URL.
   */
  argStyle: ArgStyle;
  /**
   * Keywords matched and discarded before binding, so the spec's
   * `answer bountii 12 <url>` and `answer 12 <url>` parse identically.
   */
  literalTokens?: string[];
  /**
   * Overrides the arity the shape floor is computed from.
   *
   * The floor exists to tell a command from a sentence, and past a point extra
   * arguments buy no discrimination — three pipes already never occur in prose.
   * Lowering it is how a published grammar survives gaining a required
   * argument: without it, adding one would push every previously valid
   * invocation *below* the floor and make it silent, which is the worst
   * possible way to deprecate a shape. It may only lower, never below two.
   */
  shapeFloorArity?: number;
  capabilities: Capability[];
  /** Minimum assurance to run this at all. Defaults by capability. */
  minAssurance?: Assurance;
  /** Refuses to act on a mention alone; needs a key_bound confirmation. */
  destructive?: boolean;
  /** Published per-invocation quotas, checked against proposed effects. */
  sideEffects?: SideEffectQuota;
  handler: (ctx: CommandContext, args: ArgValues) => Promise<CommandResult>;
  examples?: string[];
}

/**
 * A command family. One family, one musebook identity: the mentioned muse
 * selects the family and the first word of the mention body selects the action
 * inside it. Adding a family means registering another muse, never extending
 * an existing one.
 */
export interface ModuleDefinition {
  /** Registry-unique family id, also the mention name: "bountyboard". */
  id: string;
  /**
   * The musebook identity that fronts this family. Null until the muse has
   * been registered on musebook — the family still works over the API, it just
   * cannot be addressed by mention yet.
   */
  museId: string | null;
  title: string;
  description: string;
  trust: Trust;
  maintainer: string;
  /** Extra names the family answers to, for renames and short forms. */
  aliases?: string[];
  /** Action used when the mention body names none: `@answers <url>`. */
  defaultAction?: string;
  /**
   * How this family decides what counts as a command addressed to it.
   * Defaults to `strict` when a default action is declared, `explicit`
   * otherwise. Validated at registration, not trusted as a convention.
   */
  intake?: Intake;
  commands: CommandDefinition[];
}

export interface RegisteredCommand extends CommandDefinition {
  family: string;
  museId: string | null;
  trust: Trust;
  /** "bountyboard post" — how the directory and the parser key it. */
  key: string;
  /** Resolved at registration, so it is catalog-visible rather than implicit. */
  minAssurance: Assurance;
  usage: string;
}

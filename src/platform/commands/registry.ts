import { atLeast, capAt, MENTION_CEILING, requireAssurance, type Assurance } from "../assurance";
import {
  isPrivileged,
  mintGrant,
  type CapabilityGrant,
} from "../capabilities";
import { validateEffects, type Effect, type EffectManifest } from "../effects";
import { PlatformError } from "../errors";
import type { Actor } from "../identity";
import { bindArgs, bindObject, usageFor } from "./args";
import { parkForConfirmation, runReserved } from "./reserved";
import {
  NotCommandShaped,
  RESERVED_VERBS,
  resolveShape,
  validateIntake,
  type Intake,
  type Resolution,
} from "./shape";

export { NotCommandShaped };
import { addressFor, matchAddress, renderCommand, type Addressable } from "./trigger";
import type {
  CommandResult,
  ModuleDefinition,
  RegisteredCommand,
} from "./types";

interface RegistryEntry {
  module: ModuleDefinition;
  command: RegisteredCommand;
  grant: CapabilityGrant;
  manifest: EffectManifest;
}

const entries = new Map<string, RegistryEntry>();
const modules = new Map<string, ModuleDefinition>();

function keyFor(family: string, action: string): string {
  return `${family} ${action}`;
}

/**
 * The floor for a command, derived from what it can do when it does not say.
 *
 * Anything holding `value.move` is `key_bound`: a mention can never authorize a
 * payout, because nothing about a mention is provable to a third party later.
 * Read-only commands sit at `unverified` so `help` works for anyone. Everything
 * else needs the platform to have asserted who is calling.
 */
function defaultAssurance(command: {
  capabilities: readonly string[];
  destructive?: boolean;
}): Assurance {
  if (command.capabilities.some((c) => isPrivileged(c as never))) return "key_bound";
  if (command.destructive) return "key_bound";
  const writes = command.capabilities.some((c) => c.endsWith(".write") || c.endsWith(".append"));
  return writes ? "platform_asserted" : "unverified";
}

/**
 * Registers a command family. Capability grants are minted here, which is where
 * a third-party module asking for a privileged capability is rejected —
 * registration fails loudly instead of the command failing later at runtime.
 */
export function registerModule(module: ModuleDefinition): void {
  if (modules.has(module.id)) {
    throw new PlatformError(
      "validation",
      `family "${module.id}" is already registered`,
    );
  }
  if (module.museId) {
    const clash = [...modules.values()].find((m) => m.museId === module.museId);
    if (clash) {
      throw new PlatformError(
        "validation",
        `muse ${module.museId} already fronts the "${clash.id}" family; one muse per family`,
      );
    }
  }

  const staged: RegistryEntry[] = [];
  for (const command of module.commands) {
    const key = keyFor(module.id, command.action);
    if (entries.has(key) || staged.some((s) => s.command.key === key)) {
      throw new PlatformError("validation", `"${key}" is declared twice`);
    }
    // Throws for a third-party family requesting `value.move`.
    const grant = mintGrant(key, command.capabilities, module.trust);
    const minAssurance = command.minAssurance ?? defaultAssurance(command);

    // A family cannot publish a value-moving command at less than key_bound,
    // however it declares itself.
    if (
      command.capabilities.some(isPrivileged) &&
      !atLeast(minAssurance, "key_bound")
    ) {
      throw new PlatformError(
        "validation",
        `"${key}" moves value, so it cannot declare minAssurance "${minAssurance}"`,
      );
    }

    staged.push({
      module,
      grant,
      manifest: {
        family: module.id,
        command: key,
        capabilities: command.capabilities,
        sideEffects: command.sideEffects,
      },
      command: {
        ...command,
        family: module.id,
        museId: module.museId,
        trust: module.trust,
        key,
        minAssurance,
        // Usage is derived on read, because the trigger syntax is configurable.
        get usage() {
          return usageFor(
            module.id,
            command.action,
            command.args,
            command.argStyle,
            command.literalTokens,
          );
        },
      },
    });
  }

  if (module.defaultAction && !staged.some((s) => s.command.action === module.defaultAction)) {
    throw new PlatformError(
      "validation",
      `family "${module.id}" names a default action "${module.defaultAction}" it does not declare`,
    );
  }

  for (const command of module.commands) {
    if (RESERVED_VERBS.includes(command.action.toLowerCase() as never)) {
      throw new PlatformError(
        "validation",
        `"${module.id}" declares the reserved verb "${command.action}"; help, stop, status, yes, no and cancel are answered by the platform on every family`,
      );
    }
  }

  // Intake is checked at registration rather than trusted as a convention,
  // because the thing it rules out — an open-intake family that can move money
  // — is exactly the thing nobody would notice until it had.
  try {
    validateIntake({
      family: module.id,
      intake: intakeFor(module),
      defaultAction: module.defaultAction,
      commands: module.commands,
    });
  } catch (error) {
    throw new PlatformError("validation", (error as Error).message);
  }

  modules.set(module.id, module);
  for (const entry of staged) entries.set(entry.command.key, entry);
}

/** `strict` is the default once a family declares a default verb. */
export function intakeFor(module: ModuleDefinition): Intake {
  return module.intake ?? (module.defaultAction ? "strict" : "explicit");
}

export function resetRegistry(): void {
  entries.clear();
  modules.clear();
}

export function listModules(): ModuleDefinition[] {
  return [...modules.values()];
}

export function listCommands(): RegisteredCommand[] {
  return [...entries.values()]
    .map((e) => e.command)
    .sort((a, b) => a.key.localeCompare(b.key));
}

export function findCommand(key: string): RegisteredCommand | undefined {
  return entries.get(key)?.command;
}

/** Every address the parser will answer to, for `matchAddress`. */
export function addressBook(): Addressable[] {
  return [...modules.values()].map((module) => ({
    family: module.id,
    museId: module.museId,
    aliases: module.aliases,
  }));
}

/** The muse that fronts a family, or null when it is API-only. */
export function museForFamily(family: string): string | null {
  return modules.get(family)?.museId ?? null;
}

/** Which family a muse id fronts, for routing an ingested mention. */
export function familyForMuse(museId: string): string | null {
  const match = [...modules.values()].find(
    (m) => m.museId?.toLowerCase() === museId.trim().toLowerCase(),
  );
  return match?.id ?? null;
}

export interface DispatchOutcome extends CommandResult {
  command: string;
  family: string;
  action: string;
  trust: string;
  /** Whether the address was proved by muse id or only matched a name. */
  addressedBy: "muse_id" | "name" | "direct";
  /** What we could prove about the caller when this ran. */
  assurance: Assurance;
  /** Effects the handler proposed and the platform allowed. */
  effects: Effect[];
  /** How the verb was arrived at: written, defaulted, or reserved. */
  resolution: Resolution;
  /** A leading token close enough to a declared verb to be a typo of it. */
  nearMiss?: string | null;
}

export interface DispatchContext {
  actor: Actor;
  now?: Date;
  /** How the command arrived. A mention is capped at `platform_asserted`. */
  origin?: "mention" | "direct";
  /** What the caller's credential proves. Defaults to a bare mention. */
  assurance?: Assurance;
  /** Set when the caller has already confirmed an ambiguous or risky verb. */
  confirmed?: boolean;
}

/** Parse a command string, validate its arguments, run its handler. */
export async function dispatch(
  input: string,
  ctx: DispatchContext,
): Promise<DispatchOutcome> {
  if (!input?.trim()) {
    throw new PlatformError("validation", "a command is required");
  }

  const address = matchAddress(input, addressBook());
  if (!address) {
    const known = [...modules.keys()].map(addressFor).join(", ");
    throw new PlatformError(
      "unknown_command",
      `no command family is addressed in "${input.trim().slice(0, 60)}". Address one of: ${known}`,
    );
  }

  const family = modules.get(address.family)!;
  const verbs = family.commands.map((c) => c.action);
  const shape = resolveShape(address.body, {
    intake: intakeFor(family),
    defaultAction: family.defaultAction,
    verbs,
    commands: family.commands,
  });

  // The silence rule. A candidate that is not command-shaped gets no ack, no
  // error and no receipt — the caller decides what to do with that, and for the
  // ingest path the answer is to say nothing at all.
  if (!shape.commandShaped) {
    throw new NotCommandShaped(family.id, address.body);
  }

  if (shape.resolution === "reserved") {
    return runReservedVerb(family, shape.verb!, shape.rest, ctx, input, address.matchedBy);
  }

  if (!shape.verb) {
    const fallback = family.commands.find((c) => c.action === family.defaultAction);
    throw new PlatformError(
      "unknown_command",
      `${addressFor(family.id)} has no "${firstToken(address.body)}" action. Try: ${verbs
        .sort()
        .join(", ")}` +
        (shape.nearMiss ? `. Did you mean "${shape.nearMiss}"?` : "") +
        (fallback ? `` : ``),
    );
  }

  const entry = entries.get(keyFor(family.id, shape.verb));
  if (!entry) {
    throw new PlatformError(
      "unknown_command",
      `${addressFor(family.id)} has no "${shape.verb}" action. Try: ${verbs.sort().join(", ")}`,
    );
  }

  return run(entry, shape.rest, ctx, input, address.matchedBy, {
    // A near-miss resolving to something irreversible counts as ambiguous: a
    // typo'd verb may still become a bounty title, but it can never silently
    // settle escrow.
    ambiguous: shape.resolution === "default" && Boolean(shape.nearMiss),
    resolution: shape.resolution,
    nearMiss: shape.nearMiss,
  });
}

function firstToken(body: string): string {
  return body.trim().split(/\s+/)[0] ?? "";
}

/**
 * The six reserved verbs, answered by the platform on behalf of every family.
 * `yes` releases a parked invocation, which is the only path by which a command
 * the platform declined to run immediately ever runs.
 */
async function runReservedVerb(
  module: ModuleDefinition,
  verb: string,
  rest: string,
  ctx: DispatchContext,
  source: string,
  addressedBy: "muse_id" | "name" | "direct",
): Promise<DispatchOutcome> {
  const now = ctx.now ?? new Date();
  const outcome = await runReserved(verb, {
    actor: ctx.actor,
    family: module.id,
    verbs: module.commands.map((c) => ({
      action: c.action,
      summary: c.summary,
      usage: usageFor(module.id, c.action, c.args, c.argStyle, c.literalTokens),
    })),
    now,
  });

  if (outcome.confirm) {
    const entry = entries.get(keyFor(outcome.confirm.family, outcome.confirm.action));
    if (!entry) {
      throw new PlatformError(
        "unknown_command",
        `the command you confirmed is no longer registered`,
      );
    }
    return run(entry, outcome.confirm.body, { ...ctx, confirmed: true }, source, addressedBy, {
      ambiguous: false,
      resolution: "exact",
      nearMiss: null,
    });
  }

  void rest;
  return {
    message: outcome.message,
    data: outcome.data,
    effects: [],
    command: renderCommand(module.id, verb),
    family: module.id,
    action: verb,
    trust: module.trust,
    addressedBy,
    assurance: ctx.assurance ?? "platform_asserted",
    resolution: "reserved",
    nearMiss: null,
  };
}

/**
 * Runs a command already resolved to a family and action. The HTTP command
 * route uses this when a client sends structured fields instead of a sentence,
 * so an agent never has to render a string only for us to re-parse it.
 */
export async function dispatchAction(
  family: string,
  action: string,
  body: string | Record<string, unknown>,
  ctx: DispatchContext,
): Promise<DispatchOutcome> {
  const entry = entries.get(keyFor(family, action.toLowerCase()));
  if (!entry) {
    throw new PlatformError(
      "unknown_command",
      `"${family} ${action}" is not a registered command`,
    );
  }
  const rendered =
    typeof body === "string" ? body : JSON.stringify(body);
  return run(
    entry,
    body,
    ctx,
    `${renderCommand(family, action)} ${rendered}`.trim(),
    "direct",
    { ambiguous: false, resolution: "exact", nearMiss: null },
  );
}

interface ResolutionInfo {
  ambiguous: boolean;
  resolution: Resolution;
  nearMiss: string | null;
}

async function run(
  entry: RegistryEntry,
  rest: string | Record<string, unknown>,
  ctx: DispatchContext,
  source: string,
  addressedBy: "muse_id" | "name" | "direct",
  read: ResolutionInfo,
): Promise<DispatchOutcome> {
  const now = ctx.now ?? new Date();
  const origin = ctx.origin ?? "mention";

  // A mention never rises above `platform_asserted`, however good the caller's
  // credentials are elsewhere. Enrollment proves the muse holds its key; it
  // does not prove the muse wrote this particular post, and a payout has to
  // rest on evidence we could show a third party later.
  const claimed = ctx.assurance ?? (origin === "mention" ? "platform_asserted" : "unverified");
  const assurance = origin === "mention" ? capAt(claimed, MENTION_CEILING) : claimed;

  requireAssurance(
    assurance,
    entry.command.minAssurance,
    renderCommand(entry.command.family, entry.command.action),
  );

  // Where one unverifiable mention would otherwise do something irreversible,
  // the platform asks rather than guesses. The mention initiates; the bound
  // identity authorizes.
  const risky = entry.command.destructive || entry.command.capabilities.some(isPrivileged);
  if (risky && read.ambiguous && !ctx.confirmed) {
    const parked = await parkForConfirmation({
      actor: ctx.actor,
      family: entry.command.family,
      action: entry.command.action,
      body: rest,
      source,
      reason: read.nearMiss
        ? `the leading token looks like a typo of "${read.nearMiss}"`
        : "the verb was inferred rather than written",
      assurance,
      origin,
    });
    throw new PlatformError(
      "confirmation_required",
      `"${entry.command.action}" was inferred rather than written` +
        (read.nearMiss ? ` and "${read.nearMiss}" is a close match` : "") +
        `, and this command is not reversible. Reply "yes" to run it as read, or "no" to drop it. Expires ${parked.expiresAt.toISOString()}.`,
    );
  }

  let args;
  try {
    args =
      typeof rest === "string"
        ? bindArgs(entry.command.args, rest, {
            style: entry.command.argStyle,
            literalTokens: entry.command.literalTokens,
            now,
          })
        : bindObject(entry.command.args, rest, now);
  } catch (error) {
    if (error instanceof PlatformError) {
      throw new PlatformError(
        error.code,
        `${error.message}\nusage: ${entry.command.usage}`,
      );
    }
    throw error;
  }

  const result = await entry.command.handler(
    {
      actor: ctx.actor,
      capabilities: atLeast(assurance, "key_bound")
        ? entry.grant
        : unprivileged(entry.grant),
      source,
      now,
      origin,
      assurance,
      confirmed: Boolean(ctx.confirmed),
      confirm: async (reason: string): Promise<never> => {
        const parked = await parkForConfirmation({
          actor: ctx.actor,
          family: entry.command.family,
          action: entry.command.action,
          body: rest,
          source,
          reason,
          assurance,
          origin,
        });
        throw new PlatformError(
          "confirmation_required",
          `${reason} ` +
            (origin === "mention"
              ? `Reply "yes" to go ahead anyway, or "no" to drop it.`
              : `Resend with {"confirmed": true} and a fresh Idempotency-Key — it is a different request, so it needs a different key.`) +
            ` Expires ${parked.expiresAt.toISOString()}.`,
        );
      },
    },
    args,
  );

  // Handlers propose, the platform disposes. The proposal is checked against
  // what this command published before any of it is executed.
  const effects = validateEffects(entry.manifest, result.effects ?? []);

  return {
    ...result,
    effects,
    command: renderCommand(entry.command.family, entry.command.action),
    family: entry.command.family,
    action: entry.command.action,
    trust: entry.module.trust,
    addressedBy,
    assurance,
    resolution: read.resolution,
    nearMiss: read.nearMiss,
  };
}

/** A copy of a grant with every privileged capability removed. */
function unprivileged(grant: CapabilityGrant): CapabilityGrant {
  return mintGrant(
    `${grant.holder}:unbound`,
    grant.list().filter((capability) => !isPrivileged(capability)),
    "first-party",
  );
}

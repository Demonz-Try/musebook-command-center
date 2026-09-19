import { PlatformError } from "./errors";

/**
 * Musebook identity. Everything the command center records is attributed to
 * either a muse handle (`@ada`) or a system actor (`system:deadline-checker`),
 * which is minted internally and can never be supplied by a caller.
 */
export type ActorKind = "muse" | "system";

export interface Actor {
  kind: ActorKind;
  /** Canonical string form: `@ada` or `system:deadline-checker`. */
  id: string;
}

const HANDLE = /^@?[a-z0-9][a-z0-9._-]{1,31}$/i;
const SYSTEM = /^system:[a-z0-9][a-z0-9.-]{1,47}$/;

/**
 * A musebook muse id. The protocol doc says `muse_` plus 10 characters, but the
 * live board disagrees — `muse_wynjr` is 5 — so this accepts the real range.
 */
const MUSE_ID = /^muse_[a-z0-9]{3,32}$/i;

export function isMuseId(input: string): boolean {
  return MUSE_ID.test(input?.trim() ?? "");
}

/**
 * Canonicalizes an identity. A `muse_…` id is the real musebook identity and is
 * kept verbatim; anything else is a local alias handle (`@ada`) used for muses
 * that only exist on this site.
 *
 * Display names are never accepted here on purpose: musebook display names are
 * not unique, so keying on one would let two muses collide.
 */
export function normalizeHandle(input: string): string {
  const trimmed = input?.trim();
  if (trimmed && isMuseId(trimmed)) return trimmed.toLowerCase();
  // `anon:<slug>` identities carry no public key and collide by name with real
  // muses, so they get their own code rather than a generic parse failure.
  if (trimmed?.toLowerCase().startsWith("anon:")) {
    throw new PlatformError(
      "unverified_counterparty",
      `"${trimmed}" is an anonymous musebook identity with no public key; it cannot be a counterparty here`,
    );
  }
  if (!trimmed || !HANDLE.test(trimmed)) {
    throw new PlatformError(
      "validation",
      `"${input}" is not an identity — expected a musebook id like muse_wynjr or a local handle like @ada`,
    );
  }
  return `@${trimmed.replace(/^@/, "").toLowerCase()}`;
}

export function muse(handle: string): Actor {
  return { kind: "muse", id: normalizeHandle(handle) };
}

/** System actors are minted by platform code only — never parsed from input. */
export function systemActor(name: string): Actor {
  const id = `system:${name}`;
  if (!SYSTEM.test(id)) {
    throw new PlatformError("validation", `invalid system actor name "${name}"`);
  }
  return { kind: "system", id };
}

export function isSystemActorId(id: string): boolean {
  return SYSTEM.test(id);
}

/** Parses an actor supplied by a caller. Callers may only be muses. */
export function parseCallerActor(input: string | null | undefined): Actor {
  const trimmed = input?.trim();
  if (!trimmed) {
    throw new PlatformError(
      "validation",
      "an actor is required (send an x-musebook-actor header or an actor field)",
    );
  }
  if (isSystemActorId(trimmed)) {
    throw new PlatformError("forbidden", "callers cannot act as a system actor");
  }
  return muse(trimmed);
}

export function sameActor(a: Actor | string, b: Actor | string): boolean {
  const idOf = (v: Actor | string) => (typeof v === "string" ? v : v.id);
  return idOf(a) === idOf(b);
}

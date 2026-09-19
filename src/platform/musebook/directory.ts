import { atLeast, explain, type Assurance } from "../assurance";
import { PlatformError } from "../errors";
import { isMuseId } from "../identity";

/**
 * The musebook identity directory, as far as we trust it.
 *
 * Two facts from the live board shape everything here. Display names are not
 * unique — 92 names are shared by more than one of the 930 muses — so nothing
 * is ever keyed on a name. And 40 `anon:<slug>` identities carry
 * `public_key: null` with `id_verified: false` while colliding by name with
 * real muses, so "looks like Ada" and "is Ada" are different questions.
 */
export interface MusebookIdentity {
  museId: string;
  displayName: string | null;
  publicKey: string | null;
  idVerified: boolean;
  /** When musebook says the account was registered, if it says. */
  createdAt: Date | null;
}

export type IdentityResolver = (museId: string) => Promise<MusebookIdentity | null>;

const BASE = process.env.MUSEBOOK_BASE_URL ?? "https://musebook.lol";

const live: IdentityResolver = async (museId) => {
  const url = `${BASE}/api/identity.json?muse_id=${encodeURIComponent(museId)}`;
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new PlatformError(
      "unverified_counterparty",
      `musebook identity lookup for ${museId} failed with ${response.status}; refusing to move value on an unverified counterparty`,
    );
  }
  const body = (await response.json()) as Record<string, unknown>;
  const muse = (body.muse ?? body) as Record<string, unknown>;
  const id = typeof muse.muse_id === "string" ? muse.muse_id : null;
  if (!id) return null;
  return {
    museId: id,
    displayName: typeof muse.name === "string" ? muse.name : null,
    publicKey: typeof muse.public_key === "string" ? muse.public_key : null,
    idVerified: muse.id_verified === true,
    createdAt: parseDate(muse.created_at ?? muse.joined_at),
  };
};

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

let resolver: IdentityResolver = live;
const cache = new Map<string, MusebookIdentity | null>();

export function setIdentityResolver(next: IdentityResolver): void {
  resolver = next;
  cache.clear();
}

export function resetIdentityResolver(): void {
  resolver = live;
  cache.clear();
}

export async function resolveIdentity(museId: string): Promise<MusebookIdentity | null> {
  const key = museId.trim().toLowerCase();
  if (cache.has(key)) return cache.get(key)!;
  const identity = await resolver(key);
  cache.set(key, identity);
  return identity;
}

/**
 * Gate for anything that can move value.
 *
 * A `muse_…` id must resolve in the directory and carry a public key — an
 * unkeyed identity cannot be held to anything, and paying one is
 * indistinguishable from paying whoever squatted the name. A local `@handle` is
 * an account on this site, which only exists because someone authenticated with
 * a key we issued, so it is already a keyed counterparty at our boundary.
 * Everything else, `anon:…` most of all, is refused.
 */
export async function assertKeyedCounterparty(
  id: string,
  role: string,
): Promise<void> {
  const value = id?.trim() ?? "";

  if (value.toLowerCase().startsWith("anon:")) {
    throw new PlatformError(
      "unverified_counterparty",
      `${role} "${value}" is an anonymous musebook identity with no public key; escrow will not pay one`,
    );
  }

  if (value.startsWith("@")) return;

  if (!isMuseId(value)) {
    throw new PlatformError(
      "unverified_counterparty",
      `${role} "${value}" is not an identity escrow can verify`,
    );
  }

  const identity = await resolveIdentity(value);
  if (!identity) {
    throw new PlatformError(
      "unverified_counterparty",
      `${role} ${value} does not resolve to a musebook identity`,
    );
  }
  if (!identity.publicKey) {
    throw new PlatformError(
      "unverified_counterparty",
      `${role} ${value} has no public key on musebook; escrow will not pay a keyless identity`,
    );
  }
}

/**
 * The spec's "one vote per established identity — no fresh throwaway accounts".
 *
 * There is no membership list to check against, because the council is a public
 * thread anyone established may vote in. Establishedness is the assurance
 * ladder doing anti-sybil work: a voter must have proved custody of a key
 * (`key_bound`), must still publish that key, and the account must be older
 * than the minimum age. The first two conditions alone exclude all 40 keyless
 * `anon:` identities; the third is what stops someone minting voters today to
 * swing a vote tonight.
 */
export const MIN_ACCOUNT_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface Established {
  museId: string;
  accountAgeMs: number | null;
}

export async function assertEstablished(
  id: string,
  assurance: Assurance,
  now: Date = new Date(),
): Promise<Established> {
  const value = id?.trim() ?? "";

  if (!atLeast(assurance, "key_bound")) {
    throw new PlatformError(
      "assurance_too_low",
      `voting needs key_bound assurance and this caller is ${assurance}: ${explain(assurance)}. ` +
        "A council vote moves money, so a vote has to be attributable to a key, " +
        "not to a post anyone could have written.",
    );
  }

  await assertKeyedCounterparty(value, "voter");

  // A local `@handle` has no musebook account to age, and a key we issued is
  // already the strongest claim we have about it.
  if (value.startsWith("@")) return { museId: value, accountAgeMs: null };

  const identity = await resolveIdentity(value);
  const createdAt = identity?.createdAt ?? null;
  if (!createdAt) {
    throw new PlatformError(
      "unverified_counterparty",
      `musebook does not say when ${value} registered, so it cannot be shown to be an established identity`,
    );
  }

  const accountAgeMs = now.getTime() - createdAt.getTime();
  if (accountAgeMs < MIN_ACCOUNT_AGE_MS) {
    const days = Math.floor(MIN_ACCOUNT_AGE_MS / 86_400_000);
    throw new PlatformError(
      "not_established",
      `${value} registered ${Math.max(0, Math.floor(accountAgeMs / 86_400_000))} day(s) ago; a council vote needs an account at least ${days} days old`,
    );
  }

  return { museId: value, accountAgeMs };
}

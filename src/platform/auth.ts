import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import type { Assurance } from "./assurance";
import { apiKeys, type ApiKey } from "./db/schema";
import { deployContext } from "./deploy";
import { PlatformError } from "./errors";
import { sha256 } from "./hash";
import { muse, type Actor } from "./identity";

const KEY_PREFIX = "mb_live_";

export interface IssuedKey {
  id: string;
  muse: string;
  label: string;
  /** Shown exactly once — only its hash is stored. */
  key: string;
  prefix: string;
  assurance: Assurance;
  boundVia: string;
  scope: KeyScope;
  family: string | null;
}

export interface IssueOptions {
  label?: string;
  /**
   * Defaults to `platform_asserted`. Only `completeEnrollment` passes
   * `key_bound`, and only after an ed25519 signature has verified against the
   * key musebook publishes — which is the whole point of the level.
   *
   * Operator scripts (`npm run issue-key`, the seeder) may pass it too. That is
   * not a loophole so much as an admission: anyone who can run a script against
   * the database can already write the row by hand. It is recorded as
   * `boundVia: "operator"` so a receipt never claims a proof we did not see.
   */
  assurance?: Assurance;
  boundVia?: string;
  /**
   * `family` issues the token an agent runtime carries. Such a token is not a
   * more powerful key, it is a differently shaped one: it may only reach its
   * own family, it must name the muse it forwards for, and whatever it
   * forwards is capped at `platform_asserted` — because a router repeating
   * what it read on musebook is exactly as provable as the mention was.
   */
  scope?: KeyScope;
  family?: string;
}

export type KeyScope = "muse" | "family";

export async function issueApiKey(
  handle: string,
  options: IssueOptions | string = {},
): Promise<IssuedKey> {
  const opts = typeof options === "string" ? { label: options } : options;
  const scope: KeyScope = opts.scope ?? "muse";
  if (scope === "family" && !opts.family) {
    throw new PlatformError(
      "validation",
      "a family-scoped key must name the family it may dispatch to",
    );
  }
  if (scope === "family" && opts.assurance === "key_bound") {
    // A router cannot prove a mention. Minting a key_bound family token would
    // make every forwarded post as good as a signature, which is the one thing
    // the ladder exists to prevent.
    throw new PlatformError(
      "validation",
      "a family token cannot be key_bound; what it forwards is only ever platform_asserted",
    );
  }
  const actor = muse(handle);
  const key = `${KEY_PREFIX}${randomBytes(24).toString("hex")}`;
  const db = await getDb();
  const [row] = await db
    .insert(apiKeys)
    .values({
      id: randomUUID(),
      muse: actor.id,
      label: opts.label ?? "default",
      prefix: key.slice(0, KEY_PREFIX.length + 6),
      keyHash: sha256(key),
      assurance: opts.assurance ?? "platform_asserted",
      boundVia: opts.boundVia ?? "operator",
      scope,
      family: opts.family ?? null,
      context: deployContext(),
    })
    .returning();
  return {
    id: row.id,
    muse: row.muse,
    label: row.label,
    key,
    prefix: row.prefix,
    assurance: row.assurance,
    boundVia: row.boundVia,
    scope: row.scope as KeyScope,
    family: row.family,
  };
}

export async function revokeApiKey(id: string): Promise<void> {
  const db = await getDb();
  await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, id));
}

export async function listApiKeys(handle: string): Promise<ApiKey[]> {
  const db = await getDb();
  const rows = await db.select().from(apiKeys).where(eq(apiKeys.muse, muse(handle).id));
  return rows as ApiKey[];
}

function bearerFrom(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) {
    throw new PlatformError(
      "unauthorized",
      "send your API key as `Authorization: Bearer <key>` — never in the URL",
    );
  }
  return match[1].trim();
}

export interface Caller {
  actor: Actor;
  /** What the key proves, which is the ceiling on what the caller may do. */
  assurance: Assurance;
  boundVia: string;
  keyId: string;
  scope: KeyScope;
  /** Set only for a family token: the one family it may dispatch to. */
  family: string | null;
}

/**
 * Resolves the caller from their API key. This is the only way a request
 * acquires an identity: nothing reads an actor from the body or a URL.
 */
export async function authenticate(request: Request): Promise<Caller> {
  const key = bearerFrom(request);
  const db = await getDb();
  const [row] = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, sha256(key)))
    .limit(1);

  if (!row || !constantTimeEqual(row.keyHash, sha256(key))) {
    throw new PlatformError("unauthorized", "unknown API key");
  }
  if (row.revokedAt) {
    throw new PlatformError("unauthorized", "this API key has been revoked");
  }
  const here = deployContext();
  if (row.context !== here) {
    throw new PlatformError(
      "unauthorized",
      `this API key was issued for the ${row.context} deploy and this is ${here}. ` +
        `Preview databases are forked from production, so production keys are ` +
        `present here but deliberately do not work — issue a key against this deploy.`,
    );
  }

  await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, row.id));
  return {
    actor: muse(row.muse),
    assurance: row.assurance,
    boundVia: row.boundVia,
    keyId: row.id,
    scope: row.scope as KeyScope,
    family: row.family,
  };
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * The deadline checker authenticates with a shared secret rather than a muse
 * key, because it acts as the platform, not as any muse.
 */
export function authenticateScheduler(request: Request): void {
  const expected = process.env.SCHEDULER_SECRET;
  if (!expected) {
    // No secret configured (local dev): the endpoint is still only reachable
    // from the same deployment, and it can only trigger the refund path.
    return;
  }
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match || !constantTimeEqual(match[1].trim(), expected)) {
    throw new PlatformError("unauthorized", "invalid scheduler credentials");
  }
}

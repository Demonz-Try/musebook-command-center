import type { PgAsyncDatabase, PgAsyncTransaction } from "drizzle-orm/pg-core";
import * as platform from "@/platform/db/schema";
import * as bounty from "@/modules/bounty/schema";
import * as answer from "@/modules/answer/schema";

export const schema = { ...platform, ...bounty, ...answer };
export type Schema = typeof schema;

/**
 * Drizzle parameterizes these on its query-result and relations types, which
 * differ between the Netlify Postgres driver and PGlite. We deliberately do not
 * pin either: the point of this alias is that every caller works against both,
 * so naming one driver's types here would defeat it.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export type Db = PgAsyncDatabase<any, Schema, any>;
export type Tx = PgAsyncTransaction<any, Schema, any>;
/* eslint-enable @typescript-eslint/no-explicit-any */

let dbPromise: Promise<Db> | null = null;

/**
 * Netlify Database (Postgres) in any Netlify context; PGlite — Postgres
 * compiled to WASM, same SQL and same transaction semantics — when no Netlify
 * database is attached, so the app runs locally and in CI with no credentials.
 */
async function connect(): Promise<Db> {
  if (process.env.NETLIFY_DB_URL) {
    const { drizzle } = await import("drizzle-orm/netlify-db");
    return drizzle({ schema }) as unknown as Db;
  }

  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const dataDir = process.env.PGLITE_DATA_DIR ?? ".data/pglite";
  if (!dataDir.startsWith("memory://")) {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(dataDir, { recursive: true });
  }
  const client = new PGlite(dataDir);
  const db = drizzle({ client, schema }) as unknown as Db;
  const { applyLocalMigrations } = await import("./migrate-local");
  await applyLocalMigrations(db);
  return db;
}

export function getDb(): Promise<Db> {
  dbPromise ??= connect();
  return dbPromise;
}

export function resetDbForTests() {
  dbPromise = null;
}

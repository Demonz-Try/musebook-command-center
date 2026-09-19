import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { sql } from "drizzle-orm";
import type { Db } from "./index";

const MIGRATIONS_DIR = path.join(
  process.cwd(),
  "netlify",
  "database",
  "migrations",
);

async function migrationFiles(): Promise<{ name: string; file: string }[]> {
  const entries = await readdir(MIGRATIONS_DIR).catch(() => []);
  const found: { name: string; file: string }[] = [];
  for (const entry of entries.sort()) {
    const full = path.join(MIGRATIONS_DIR, entry);
    if (entry.endsWith(".sql")) {
      found.push({ name: entry.replace(/\.sql$/, ""), file: full });
      continue;
    }
    const info = await stat(full).catch(() => null);
    if (info?.isDirectory()) {
      const nested = path.join(full, "migration.sql");
      if (await stat(nested).then(() => true, () => false)) {
        found.push({ name: entry, file: nested });
      }
    }
  }
  return found;
}

/**
 * Applies migration files to the local development database. Hosted Netlify
 * databases have their migrations applied by the deploy, never by app code.
 */
export async function applyLocalMigrations(db: Db) {
  await db.execute(
    sql`create table if not exists __local_migrations (name text primary key, applied_at timestamptz not null default now())`,
  );
  const applied = new Set(
    (
      (await db.execute(
        sql`select name from __local_migrations`,
      )) as unknown as { rows: { name: string }[] }
    ).rows.map((r) => r.name),
  );

  for (const migration of await migrationFiles()) {
    if (applied.has(migration.name)) continue;
    const body = await readFile(migration.file, "utf8");
    for (const statement of body.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed) await db.execute(sql.raw(trimmed));
    }
    await db.execute(
      sql`insert into __local_migrations (name) values (${migration.name})`,
    );
  }
}

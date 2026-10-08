import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

export type Sql = postgres.Sql;
export type Tx = postgres.TransactionSql;

const MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "migrations",
);

export function connect(databaseUrl: string): Sql {
  return postgres(databaseUrl, { onnotice: () => {} });
}

/**
 * Applies migrations/NNN_*.sql in order, each in its own transaction, and
 * records them in schema_migrations. An advisory lock keeps two processes
 * starting at once from racing.
 */
export async function migrate(sql: Sql): Promise<string[]> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d+_.*\.sql$/.test(name))
    .sort();

  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('knowledge-chatroom:migrate'))`;
    await tx`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`;
    const done = new Set(
      (await tx<{ name: string }[]>`SELECT name FROM schema_migrations`).map(
        (row) => row.name,
      ),
    );

    const applied: string[] = [];
    for (const name of files) {
      if (done.has(name)) continue;
      await tx.unsafe(readFileSync(path.join(MIGRATIONS_DIR, name), "utf8"));
      await tx`INSERT INTO schema_migrations (name) VALUES (${name})`;
      applied.push(name);
    }
    return applied;
  });
}

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

/**
 * The database role a signed-in user's queries run as. Row-level security
 * policies (migrations/004_row_security.sql) apply to it, so even a bug in the
 * app's own checks can't read or change another person's files or nodes.
 */
export const APP_ROLE = "knowledge_user";

/**
 * Gives APP_ROLE what the file and node services need, when this connection
 * may use it (004_row_security.sql creates it if it can). Returns whether
 * row-level security is in force for signed-in users' queries.
 */
export async function prepareRowSecurity(sql: Sql): Promise<boolean> {
  return sql.begin(async (tx) => {
    // Same lock as migrate(): two processes granting at once can collide.
    await tx`SELECT pg_advisory_xact_lock(hashtext('knowledge-chatroom:migrate'))`;
    const [row] = await tx<{ ok: boolean }[]>`
      SELECT r.oid IS NOT NULL AND (me.rolsuper OR pg_has_role(current_user, r.oid, 'MEMBER')) AS ok
      FROM pg_roles me LEFT JOIN pg_roles r ON r.rolname = ${APP_ROLE}
      WHERE me.rolname = current_user`;
    if (!row?.ok) return false;
    const [{ schema }] = await tx<{ schema: string }[]>`SELECT current_schema() AS schema`;
    const role = APP_ROLE;
    await tx.unsafe(`GRANT USAGE ON SCHEMA "${schema.replace(/"/g, '""')}" TO ${role}`);
    await tx.unsafe(`GRANT SELECT ON workspaces, node_types, blobs, nodes, files, file_versions TO ${role}`);
    await tx.unsafe(`GRANT INSERT ON blobs, nodes, files, file_versions, audit_log TO ${role}`);
    // UPDATE also covers the row locks (FOR SHARE / FOR UPDATE) the services take.
    await tx.unsafe(`GRANT UPDATE ON nodes, files TO ${role}`);
    await tx.unsafe(`GRANT USAGE ON SEQUENCE audit_log_id_seq TO ${role}`);
    return true;
  }) as Promise<boolean>;
}

/**
 * `tx` usable where code expects a whole connection: its own transactions
 * become savepoints inside `tx`, so they share its role and settings.
 */
export function inTransaction(tx: Tx): Sql {
  return new Proxy(tx, {
    get(target, prop, receiver) {
      if (prop === "begin") {
        return (fn: (tx: Tx) => unknown) => target.savepoint((sp) => fn(sp as Tx));
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as unknown as Sql;
}

/**
 * Runs `fn` in one transaction as APP_ROLE for `userId`, so the row-level
 * security policies decide what it can see and change.
 */
export function asUser<T>(sql: Sql, userId: string, fn: (db: Sql) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL ROLE ${APP_ROLE}`);
    await tx`SELECT set_config('app.user_id', ${userId}, true)`;
    return fn(inTransaction(tx));
  }) as Promise<T>;
}

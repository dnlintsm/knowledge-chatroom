import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { APP_ROLE, asUser, migrate, prepareRowSecurity, type Sql, type Tx } from "./db";

describe("db", () => {
  test("migrate uses tx.file instead of tx.unsafe", async () => {
    const fileCalls: string[] = [];
    const unsafeCalls: string[] = [];

    const fakeTx = ((first: unknown, ..._rest: unknown[]) => {
      if (Array.isArray(first)) {
        const sqlText = (first as unknown as TemplateStringsArray).join("?");
        if (sqlText.includes("SELECT name FROM schema_migrations")) {
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      }
      return first;
    }) as unknown as Tx;

    fakeTx.file = ((filePath: string) => {
      fileCalls.push(filePath);
      return Promise.resolve([]);
    }) as unknown as typeof fakeTx.file;

    fakeTx.unsafe = ((query: string) => {
      unsafeCalls.push(query);
      return Promise.resolve([]);
    }) as unknown as typeof fakeTx.unsafe;

    const fakeSql = {
      begin: async <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => {
        return fn(fakeTx);
      },
    } as unknown as Sql;

    const applied = await migrate(fakeSql);

    assert.ok(applied.length > 0, "should have found migration files to apply");
    assert.equal(fileCalls.length, applied.length, "should call tx.file for each migration");
    assert.equal(unsafeCalls.length, 0, "should not call tx.unsafe for any migration");
    assert.ok(fileCalls.every((p) => p.endsWith(".sql")), "all file calls should target .sql files");
  });

  test("prepareRowSecurity uses parameterized identifiers without tx.unsafe", async () => {
    const unsafeCalls: string[] = [];
    const templateQueries: string[] = [];

    const fakeTx = ((first: unknown, ..._rest: unknown[]) => {
      if (Array.isArray(first)) {
        const sqlText = (first as unknown as TemplateStringsArray).join("?");
        templateQueries.push(sqlText);

        if (sqlText.includes("FROM pg_roles me")) {
          return Promise.resolve([{ ok: true }]);
        }
        if (sqlText.includes("SELECT current_schema()")) {
          return Promise.resolve([{ schema: "public" }]);
        }
        return Promise.resolve([]);
      }
      return `"${String(first)}"`;
    }) as unknown as Tx;

    fakeTx.unsafe = ((query: string) => {
      unsafeCalls.push(query);
      return Promise.resolve([]);
    }) as unknown as typeof fakeTx.unsafe;

    const fakeSql = {
      begin: async <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => {
        return fn(fakeTx);
      },
    } as unknown as Sql;

    const success = await prepareRowSecurity(fakeSql);
    assert.equal(success, true);
    assert.equal(unsafeCalls.length, 0, "prepareRowSecurity should not call tx.unsafe");
    assert.ok(
      templateQueries.some((q) => q.includes("GRANT USAGE ON SCHEMA ? TO ?")),
      "should grant schema usage using tagged templates",
    );
  });

  test("asUser sets local role using parameterized identifier without tx.unsafe", async () => {
    const unsafeCalls: string[] = [];
    const templateQueries: string[] = [];

    const fakeTx = ((first: unknown, ..._rest: unknown[]) => {
      if (Array.isArray(first)) {
        templateQueries.push((first as unknown as TemplateStringsArray).join("?"));
        return Promise.resolve([]);
      }
      return `"${String(first)}"`;
    }) as unknown as Tx;

    fakeTx.unsafe = ((query: string) => {
      unsafeCalls.push(query);
      return Promise.resolve([]);
    }) as unknown as typeof fakeTx.unsafe;

    fakeTx.savepoint = (async (fn: (tx: Tx) => unknown) => {
      return fn(fakeTx);
    }) as unknown as typeof fakeTx.savepoint;

    const fakeSql = {
      begin: async <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => {
        return fn(fakeTx);
      },
    } as unknown as Sql;

    let executedInsideUser = false;
    await asUser(fakeSql, "user_123", async () => {
      executedInsideUser = true;
    });

    assert.equal(executedInsideUser, true);
    assert.equal(unsafeCalls.length, 0, "asUser should not call tx.unsafe");
    assert.ok(
      templateQueries.some((q) => q.includes("SET LOCAL ROLE ?")),
      "should set local role using template literal",
    );
    assert.equal(APP_ROLE, "knowledge_user");
  });
});

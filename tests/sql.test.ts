import { expect, test } from "bun:test";
import { openSql } from "../server/db";
import { TenantDb, TenantStatementError } from "../server/tenant-db";
import { migrate } from "../server/migrations";

test("rolls back an async transaction when its callback fails", async () => {
  const sql = await openSql(":memory:");
  try {
    await sql.run("CREATE TABLE sample(value TEXT)");
    await expect(sql.tx(async tx => {
      await tx.run("INSERT INTO sample VALUES(?)", ["discard"]);
      throw new Error("abort transaction");
    })).rejects.toThrow("abort transaction");
    expect(await sql.all("SELECT * FROM sample")).toEqual([]);
  } finally { await sql.close(); }
});

test("queues unrelated statements outside a suspended transaction", async () => {
  const sql = await openSql(":memory:");
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  try {
    await sql.run("CREATE TABLE sample(value TEXT)");
    const transaction = sql.tx(async tx => {
      await tx.run("INSERT INTO sample VALUES(?)", ["discard"]);
      entered.resolve();
      await release.promise;
      throw new Error("abort transaction");
    });
    const outcome = transaction.then(() => null, (error: unknown) => error);
    await entered.promise;
    const outside = sql.run("INSERT INTO sample VALUES(?)", ["keep"]);
    release.resolve();
    expect(await outcome).toEqual(new Error("abort transaction"));
    await outside;
    expect(await sql.all("SELECT value FROM sample")).toEqual([{ value: "keep" }]);
  } finally { await sql.close(); }
});

test("binds tenant identity and rejects an unscoped statement", async () => {
  const sql = await openSql(":memory:");
  try {
    await migrate(sql);
    const a = new TenantDb(sql, "a");
    const b = new TenantDb(sql, "b");
    await a.run("INSERT INTO narration_auto(id,data,updated_at,user_id) VALUES(1,?,?,?)", ["{}", "2026-01-01"]);
    expect(await b.all("SELECT data FROM narration_auto WHERE user_id=?", [])).toEqual([]);
    expect(await a.all("SELECT data FROM narration_auto WHERE user_id=?", [])).toEqual([{ data: "{}" }]);
    expect(() => b.all("SELECT data FROM narration_auto", [])).toThrow("user_id");
  } finally { await sql.close(); }
});

test.each([
  "SELECT data FROM narration_auto WHERE user_id=? AND data=?",
  "INSERT INTO narration_auto(user_id,updated_at,id,data) VALUES(?,?,1,'{}')",
])("rejects a caller-controlled tenant placeholder in %s", async statement => {
  // Given: B's appended identity would bind after A's caller-controlled identity.
  const sql = await openSql(":memory:");
  try {
    await migrate(sql);
    const b = new TenantDb(sql, "b");
    // When/Then: reject the statement before either reading or writing another account.
    await expect((async () => b.run(statement, ["a"]))()).rejects.toBeInstanceOf(TenantStatementError);
  } finally { await sql.close(); }
});

import { Database } from "bun:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createClient as webClient } from "@libsql/client/web";
import type { Client, Transaction } from "@libsql/client";

export type SqlValue = string | number | bigint | null | Uint8Array;
export type Statement = { readonly sql: string; readonly args?: readonly SqlValue[] };
export type RunResult = { readonly changes: number; readonly lastId: string | null };
export interface Sql {
  get<T = unknown>(sql: string, args?: readonly SqlValue[]): Promise<T | null>;
  all<T = unknown>(sql: string, args?: readonly SqlValue[]): Promise<T[]>;
  run(sql: string, args?: readonly SqlValue[]): Promise<RunResult>;
  batch(statements: readonly Statement[]): Promise<void>;
  /**
   * Await every operation started in this callback. Do not launch background work here:
   * it inherits the transaction context and SQL access fails after commit or rollback.
   * Start background jobs only after awaiting tx() from the caller's outer context.
   */
  tx<T>(fn: (sql: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
interface Driver {
  get(sql: string, args: readonly SqlValue[]): Promise<unknown | null>;
  all(sql: string, args: readonly SqlValue[]): Promise<unknown[]>;
  run(sql: string, args: readonly SqlValue[]): Promise<RunResult>;
  begin(): Promise<Driver>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  close(): void;
}
class SqliteDriver implements Driver {
  constructor(private readonly db: Database) {}
  async get(sql: string, args: readonly SqlValue[]) { return this.db.query(sql).get(...args); }
  async all(sql: string, args: readonly SqlValue[]) { return this.db.query(sql).all(...args); }
  async run(sql: string, args: readonly SqlValue[]) {
    const result = this.db.query(sql).run(...args);
    return { changes: result.changes, lastId: String(result.lastInsertRowid) };
  }
  async begin() { this.db.exec("BEGIN IMMEDIATE"); return this; }
  async commit() { this.db.exec("COMMIT"); }
  async rollback() { this.db.exec("ROLLBACK"); }
  close() { this.db.close(); }
}
class LibsqlDriver implements Driver {
  constructor(private readonly client: Client, private readonly transaction?: Transaction) {}
  private execute(sql: string, args: readonly SqlValue[]) {
    return (this.transaction ?? this.client).execute({ sql, args: [...args] });
  }
  async get(sql: string, args: readonly SqlValue[]) { return (await this.execute(sql, args)).rows[0] ?? null; }
  async all(sql: string, args: readonly SqlValue[]) { return [...(await this.execute(sql, args)).rows]; }
  async run(sql: string, args: readonly SqlValue[]) {
    const result = await this.execute(sql, args);
    return { changes: result.rowsAffected, lastId: result.lastInsertRowid?.toString() ?? null };
  }
  async begin() { return new LibsqlDriver(this.client, await this.client.transaction("write")); }
  async commit() { await this.transaction?.commit(); }
  async rollback() { await this.transaction?.rollback(); }
  close() { if (this.transaction) this.transaction.close(); else this.client.close(); }
}
class TransactionClosed extends Error {
  constructor() { super("SQL transaction has already ended"); }
}
/** Serializes the connection, not only transactions: unrelated awaits cannot join another request's transaction. */
class Connection implements Sql {
  private tail: Promise<void> = Promise.resolve();
  private readonly context = new AsyncLocalStorage<{ driver: Driver; active: boolean }>();
  constructor(private readonly driver: Driver) {}
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
  private access<T>(work: (driver: Driver) => Promise<T>) {
    const current = this.context.getStore();
    if (current) {
      if (!current.active) throw new TransactionClosed();
      return work(current.driver);
    }
    return this.exclusive(() => work(this.driver));
  }
  // Like the driver's query<T>, the generic is a caller contract; application rows are parsed with Zod.
  get<T = unknown>(sql: string, args?: readonly SqlValue[]): Promise<T | null>;
  get(sql: string, args: readonly SqlValue[] = []): Promise<unknown | null> {
    return this.access(driver => driver.get(sql, args));
  }
  all<T = unknown>(sql: string, args?: readonly SqlValue[]): Promise<T[]>;
  all(sql: string, args: readonly SqlValue[] = []): Promise<unknown[]> {
    return this.access(driver => driver.all(sql, args));
  }
  run(sql: string, args: readonly SqlValue[] = []) { return this.access(driver => driver.run(sql, args)); }
  async batch(statements: readonly Statement[]) {
    await this.tx(async tx => { for (const statement of statements) await tx.run(statement.sql, statement.args); });
  }
  tx<T>(fn: (sql: Sql) => Promise<T>): Promise<T> {
    const current = this.context.getStore();
    if (current) {
      if (!current.active) throw new TransactionClosed();
      return fn(this);
    }
    return this.exclusive(async () => {
      const driver = await this.driver.begin();
      const context = { driver, active: true };
      try {
        const result = await this.context.run(context, () => fn(this));
        await driver.commit();
        return result;
      } catch (error) {
        await driver.rollback();
        throw error;
      } finally {
        context.active = false;
        if (driver !== this.driver) driver.close();
      }
    });
  }
  async close() { await this.exclusive(async () => this.driver.close()); }
}
/** Explicit adapter entry point lets the exact libSQL implementation run against a local file in tests. */
export async function openLibsql(url: string, authToken?: string): Promise<Sql> {
  const config = { url, ...(authToken === undefined ? {} : { authToken }) };
  const client = url.startsWith("file:") ? (await import("@libsql/client")).createClient(config) : webClient(config);
  const sql = new Connection(new LibsqlDriver(client));
  await sql.run("PRAGMA foreign_keys=ON");
  return sql;
}
export async function openSql(url: string, authToken?: string): Promise<Sql> {
  if (/^(libsql|https?):/.test(url)) return openLibsql(url, authToken);
  const path = url.startsWith("file:") ? decodeURIComponent(url.replace(/^file:(\/\/)?/, "")) : url;
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON");
  return new Connection(new SqliteDriver(db));
}

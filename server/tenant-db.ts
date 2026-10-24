import type { Sql, SqlValue } from "./db";

export class TenantStatementError extends Error {
  constructor() { super("Tenant SQL must contain a bound user_id"); }
}
/** The final positional parameter belongs to this account, never to a caller-supplied identity. */
export class TenantDb {
  constructor(readonly sql: Sql, readonly userId: string) {}
  private args(statement: string, args: readonly SqlValue[]) {
    if (!/\buser_id\b/.test(statement) || !statement.includes("?")) throw new TenantStatementError();
    return [...args, this.userId];
  }
  get<T = unknown>(statement: string, args: readonly SqlValue[] = []) {
    return this.sql.get<T>(statement, this.args(statement, args));
  }
  all<T = unknown>(statement: string, args: readonly SqlValue[] = []) {
    return this.sql.all<T>(statement, this.args(statement, args));
  }
  run(statement: string, args: readonly SqlValue[] = []) {
    return this.sql.run(statement, this.args(statement, args));
  }
  tx<T>(fn: (db: TenantDb) => Promise<T>) { return this.sql.tx(() => fn(this)); }
}

import type { Sql, SqlValue } from "./db";

export class TenantStatementError extends Error {
  constructor() { super("Tenant SQL must bind user_id to its final positional parameter"); }
}
/** SQL comments and string contents cannot supply identifiers or parameter markers. */
export function sqlTokens(statement: string): string[] {
  const tokens = statement.match(/--[^\r\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|\?\d*|[:@$][\w]+|[a-z_]\w*|[^\s]/gi) ?? [];
  return tokens.filter(token => !token.startsWith("--") && !token.startsWith("/*")).map(token => {
    if (/^(?:"[a-z_]\w*"|`[a-z_]\w*`|\[[a-z_]\w*\])$/i.test(token)) return token.slice(1, -1).toLowerCase();
    return token.toLowerCase();
  });
}

/** Supported tenant statements bind an outer WHERE predicate or the final INSERT column/value. */
export function hasFinalTenantBinding(tokens: readonly string[]): boolean {
  const last = tokens.lastIndexOf("?");
  if (last < 0 || tokens.some(token => /^(?:\?\d|[:@$])/.test(token))) return false;
  if (tokens[0] === "insert") {
    const columnsStart = tokens.indexOf("(");
    const columnsEnd = tokens.indexOf(")", columnsStart);
    const columns = tokens.slice(columnsStart + 1, columnsEnd).filter(token => token !== ",");
    if (columns.at(-1) !== "user_id" || columns.filter(token => token === "user_id").length !== 1 ||
      tokens[columnsEnd + 1] !== "values" || tokens[columnsEnd + 2] !== "(") return false;
    let depth = 0;
    let count = 1;
    let start = columnsEnd + 3;
    for (let i = start; i < tokens.length; i++) {
      const token = tokens[i];
      if (token === "(") depth++;
      else if (token === ")") {
        if (depth === 0) return count === columns.length && start === last && i === start + 1;
        depth--;
      } else if (token === "," && depth === 0) { count++; start = i + 1; }
    }
    return false;
  }
  if (!["select", "update", "delete"].includes(tokens[0] ?? "")) return false;
  let depth = 0;
  let subquery = -1;
  let where = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "(") depth++;
    else if (token === ")") { depth--; if (depth < subquery) subquery = -1; }
    else if (token === "select" && depth > 0 && subquery < 0) subquery = depth;
    else if (token === "where" && depth === 0) where = true;
    if (where && subquery < 0 && token === "user_id" && tokens[i + 1] === "=" && i + 2 === last &&
      tokens[i - 2] !== "excluded") return true;
  }
  return false;
}

/** The final positional parameter belongs to this account, never to a caller-supplied identity. */
export class TenantDb {
  constructor(readonly sql: Sql, readonly userId: string) {}
  private args(statement: string, args: readonly SqlValue[]) {
    if (!hasFinalTenantBinding(sqlTokens(statement))) throw new TenantStatementError();
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

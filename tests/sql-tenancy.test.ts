import { expect, test } from "bun:test";
import { join } from "node:path";
import * as ts from "typescript";
import { TABLES } from "../server/schema";
import { hasFinalTenantBinding, sqlTokens } from "../server/tenant-db";

const controlQueries = new Map([
  ["principalByToken", "SELECT user_id,id,source FROM principals WHERE token_hash=? AND revoked_at IS NULL"],
  ["sessionByHash", "SELECT user_id,hash,principal_id,csrf,expires_at,created_at FROM sessions WHERE hash=? AND expires_at>?"],
  ["shareByCode", "SELECT user_id,code,record_id,created_at FROM shares WHERE code=?"],
  ["inviteByHash", "SELECT user_id,agent FROM agent_invites WHERE code_hash=? AND expires_at>?"],
  ["narrationCount", "SELECT count(*) AS count FROM narration_runs WHERE started_at>=?"],
]);
const tenantTables = new Set(Object.keys(TABLES));
const tableKeywords = new Set(["from", "join", "update", "into"]);
const dynamic = "__dynamic_sql__";

function sqlText(node: ts.Node): string {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map(span => dynamic + span.literal.text).join("");
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) return sqlText(node.left) + sqlText(node.right);
  if (ts.isParenthesizedExpression(node)) return sqlText(node.expression);
  return dynamic;
}

function lintSql(source: string, relative = "probe.ts") {
  const violations: string[] = [];
  const file = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node) ||
      (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)) {
      const sql = sqlText(node);
      const tokens = sqlTokens(sql);
      const tables = tokens.flatMap((token, i) => {
        if (!tableKeywords.has(token)) return [];
        const start = tokens[i + 1] === "(" ? i + 2 : i + 1;
        return tokens[start + 1] === "."
          ? [tokens[start] ?? "", tokens[start + 2] ?? ""] : [tokens[start] ?? ""];
      });
      const computed = tables.some(table => table.includes(dynamic));
      if (computed || tables.some(table => tenantTables.has(table))) {
        let parent: ts.Node | undefined = node.parent;
        while (parent && !ts.isMethodDeclaration(parent)) parent = parent.parent;
        const method = parent && ts.isMethodDeclaration(parent) ? parent.name.getText(file) : "";
        const allowed = relative === "control-db.ts" && controlQueries.get(method) === sql;
        const migration = computed && relative === "migrations.ts";
        if (!allowed && !migration && (computed || !hasFinalTenantBinding(tokens))) {
          const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
          violations.push(`${relative}:${line}: ${computed ? "dynamic SQL table outside migrations" : "tenant SQL lacks final bound user_id"}`);
        }
      }
      // Inspect a concatenation as one expression, not independent string fragments.
      if (ts.isBinaryExpression(node)) return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return violations;
}

test("every tenant SQL statement carries user_id outside named capability queries", async () => {
  // Given: the actual server source, including every nested string and template.
  const violations: string[] = [];
  for await (const relative of new Bun.Glob("**/*.ts").scan({ cwd: join(import.meta.dir, "../server") })) {
    const source = await Bun.file(join(import.meta.dir, "../server", relative)).text();
    // When: a statement reaches a tenant table, inspect its own query, not neighboring SQL.
    violations.push(...lintSql(source, relative));
  }
  // Then: additions and missing predicates cannot silently escape the suite.
  expect(violations).toEqual([]);
});

test.each([
  "SELECT * FROM records WHERE user_id=? AND id=?",
  "INSERT INTO records(user_id,id) VALUES(?,?)",
  "SELECT * FROM records WHERE id=? /* user_id=? */",
  "SELECT * FROM records WHERE id=? -- user_id=?",
  "SELECT 'user_id=?' FROM records WHERE id=?",
  "SELECT * FROM records WHERE records.user_id=other.user_id AND id=?",
  "INSERT INTO records(id) VALUES(?) ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id",
  "UPDATE records SET user_id=? WHERE id='other'",
  "SELECT * FROM records WHERE EXISTS(SELECT 1 FROM trash WHERE user_id=?)",
])("lint rejects an unbound or mis-ordered tenant in %s", sql => {
  // Given/When: inspect an actual query expression with a misleading tenant reference.
  const violations = lintSql(`db.run(${JSON.stringify(sql)});`);
  // Then: the source guard must reject it, independent of database parameter-count errors.
  expect(violations.length).toBeGreaterThan(0);
});

test.each([
  "SELECT '?' FROM records WHERE id=? AND user_id=? /* ? */",
  "SELECT * FROM records r WHERE r.id=? AND (r.user_id=?)",
  "SELECT * FROM records WHERE id IN (SELECT id FROM trash WHERE trash.user_id=records.user_id) AND user_id=?",
  "INSERT INTO records(id,data,user_id) VALUES(?,json_object('literal','?'),?) ON CONFLICT(user_id,id) DO UPDATE SET data=excluded.data",
  "INSERT INTO push_subscriptions(endpoint,user_id) VALUES(?,?) ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id",
])("lint accepts the final tenant binding in %s", sql => {
  // Given/When: inspect supported SQL with literal markers, nested expressions or an upsert.
  const violations = lintSql(`db.run(${JSON.stringify(sql)});`);
  // Then: only executable parameter markers determine the identity's position.
  expect(violations).toEqual([]);
});

test("limits dynamic-table exemptions to migrations", () => {
  // Given: the migration's computed table copy, not an account-scoped content query.
  const source = "sql.run(`INSERT INTO ${table}(user_id) SELECT 'local' FROM legacy_${table}`);";
  // When/Then: only the migration file may perform it.
  expect(lintSql(source, "migrations.ts")).toEqual([]);
  expect(lintSql(source, "records.ts").length).toBeGreaterThan(0);
});

test.each([
  "`SELECT * FROM ${table} WHERE user_id=?`",
  '"SELECT * FROM " + table + " WHERE user_id=?"',
  '"SELECT * FROM rec" + suffix + " WHERE user_id=?"',
  "`DELETE FROM legacy_${table} WHERE user_id=?`",
  "`SELECT * FROM \"${table}\" WHERE user_id=?`",
  "`SELECT * FROM ${schema}.records WHERE user_id=?`",
  '"SELECT * FROM " + schema + ".records WHERE user_id=?"',
  "`SELECT * FROM (${table}) WHERE user_id=?`",
])("lint rejects a dynamic table outside migrations: %s", expression => {
  // Given/When: a computed table name must not hide the tenant table from inspection.
  const violations = lintSql(`db.run(${expression});`);
  // Then: fail even when a plausible tenant predicate follows the unknown table.
  expect(violations.length).toBeGreaterThan(0);
});

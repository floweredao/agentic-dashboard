import { expect, test } from "bun:test";
import { join } from "node:path";
import * as ts from "typescript";
import { TABLES } from "../server/schema";

const controlQueries = new Map([
  ["principalByToken", "SELECT user_id,id,source FROM principals WHERE token_hash=? AND revoked_at IS NULL"],
  ["sessionByHash", "SELECT user_id,hash,principal_id,csrf,expires_at FROM sessions WHERE hash=? AND expires_at>?"],
  ["shareByCode", "SELECT user_id,code,record_id,created_at FROM shares WHERE code=?"],
  ["inviteByHash", "SELECT user_id,agent FROM agent_invites WHERE code_hash=? AND expires_at>?"],
  ["narrationCount", "SELECT count(*) AS count FROM narration_runs WHERE started_at>=?"],
]);
const tenantTable = new RegExp(`\\b(?:FROM|JOIN|UPDATE|INTO)\\s+(?:${Object.keys(TABLES).join("|")})\\b`, "i");
const statement = /\b(?:SELECT|INSERT|UPDATE|DELETE)\b/i;

test("every tenant SQL statement carries user_id outside named capability queries", async () => {
  // Given: the actual server source, including every nested string and template.
  const violations: string[] = [];
  for await (const relative of new Bun.Glob("**/*.ts").scan({ cwd: join(import.meta.dir, "../server") })) {
    const source = await Bun.file(join(import.meta.dir, "../server", relative)).text();
    const file = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true);
    // When: a statement reaches a tenant table, inspect its own query, not neighboring SQL.
    const visit = (node: ts.Node) => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
        const sql = ts.isTemplateExpression(node) ? node.getText(file) : node.text;
        if (statement.test(sql) && tenantTable.test(sql)) {
          let parent: ts.Node | undefined = node.parent;
          while (parent && !ts.isMethodDeclaration(parent)) parent = parent.parent;
          const method = parent && ts.isMethodDeclaration(parent) ? parent.name.getText(file) : "";
          const allowed = relative === "control-db.ts" && controlQueries.get(method) === sql;
          if (!allowed && !/\buser_id\b/.test(sql)) {
            const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
            violations.push(`${relative}:${line}: tenant SQL lacks user_id`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  // Then: additions and missing predicates cannot silently escape the suite.
  expect(violations).toEqual([]);
});

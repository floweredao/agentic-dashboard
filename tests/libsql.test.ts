import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLibsql } from "../server/db";
import { migrate } from "../server/migrations";
import { TenantDb } from "../server/tenant-db";
import { Store } from "../server/store";
import { Agents } from "../server/agents";
import { RecordInputSchema } from "../shared/contracts";

const backends = ["file", ...(process.env["LIBSQL_TEST_URL"] ? ["server"] : [])];
for (const backend of backends) {
  test(`libSQL ${backend} preserves tenant CRUD, rollback and affected counts`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "tenant-libsql-"));
    const sql = await openLibsql(backend === "file" ? `file:${join(dir, "test.sqlite")}` : process.env["LIBSQL_TEST_URL"] ?? "");
    try {
      await migrate(sql);
      const a = new Store(new TenantDb(sql, `a-${crypto.randomUUID()}`), Date.now);
      const b = new Store(new TenantDb(sql, `b-${crypto.randomUUID()}`), Date.now);
      await new Agents(a).add("writer");
      await new Agents(b).add("writer");
      const input = RecordInputSchema.parse({ kind: "note", title: "Only A", body: "private", tags: ["test"] });
      const saved = await a.create({ id: "writer", source: "writer" }, "same-request", input, input);
      await expect(b.get(saved.record.id)).rejects.toMatchObject({ status: 404 });
      const own = await b.create({ id: "writer", source: "writer" }, "same-request", input, input);
      expect(own.record.id).not.toBe(saved.record.id);
      await expect(sql.tx(async () => {
        await a.patch(saved.record.id, { expectedVersion: 1, changes: { title: "Discard" } });
        throw new Error("rollback");
      })).rejects.toThrow("rollback");
      expect((await a.get(saved.record.id)).title).toBe("Only A");
      expect((await a.db.run("UPDATE records SET data=data WHERE id=? AND user_id=?", [saved.record.id])).changes).toBe(1);
      await a.delete(saved.record.id, 1);
      expect((await a.trashList()).length).toBe(1);
      expect((await a.restore(saved.record.id)).version).toBe(2);
      expect((await b.get(own.record.id)).version).toBe(1);
    } finally { await sql.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}

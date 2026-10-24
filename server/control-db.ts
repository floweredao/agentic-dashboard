import { z } from "zod";
import { SourceSchema } from "../shared/contracts";
import type { Sql } from "./db";

const principal = z.object({ user_id: z.string(), id: z.string(), source: SourceSchema });
const session = z.object({ user_id: z.string(), hash: z.string(), principal_id: z.string(), csrf: z.string(), expires_at: z.number() });
const share = z.object({ user_id: z.string(), code: z.string(), record_id: z.string(), created_at: z.string() });
const invite = z.object({ user_id: z.string(), agent: z.string() });

/** Global capability resolution only. Tenant content queries belong to TenantDb, never here. */
export class ControlDb {
  constructor(private readonly sql: Sql) {}
  async principalByToken(hash: string) {
    const row = await this.sql.get("SELECT user_id,id,source FROM principals WHERE token_hash=? AND revoked_at IS NULL", [hash]);
    return row ? principal.parse(row) : null;
  }
  async sessionByHash(hash: string, now: number) {
    const row = await this.sql.get("SELECT user_id,hash,principal_id,csrf,expires_at FROM sessions WHERE hash=? AND expires_at>?", [hash, now]);
    return row ? session.parse(row) : null;
  }
  async shareByCode(code: string) {
    const row = await this.sql.get("SELECT user_id,code,record_id,created_at FROM shares WHERE code=?", [code]);
    return row ? share.parse(row) : null;
  }
  async inviteByHash(hash: string, now: number) {
    const row = await this.sql.get("SELECT user_id,agent FROM agent_invites WHERE code_hash=? AND expires_at>?", [hash, now]);
    return row ? invite.parse(row) : null;
  }
  async narrationCount(since: string) {
    return z.object({ count: z.number() }).parse(await this.sql.get("SELECT count(*) AS count FROM narration_runs WHERE started_at>=?", [since])).count;
  }
  async users() {
    return (await this.sql.all("SELECT id FROM users WHERE deleted_at IS NULL ORDER BY id")).map(row => z.object({ id: z.string() }).parse(row).id);
  }
  async createUser(id: string, timestamp: string) {
    await this.sql.run("INSERT INTO users(id,created_at) VALUES(?,?)", [id, timestamp]);
  }
}

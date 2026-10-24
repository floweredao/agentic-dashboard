import { z } from "zod";
import { SourceSchema } from "../shared/contracts";
import type { Sql } from "./db";
import { ApiError } from "./errors";

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
  async startOAuth(hash: string, expires: number) {
    await this.sql.run("DELETE FROM oauth_transactions WHERE expires_at<=?", [expires - 600000]);
    await this.sql.run("INSERT INTO oauth_transactions(tx_hash,expires_at) VALUES(?,?)", [hash, expires]);
  }
  async consumeOAuth(hash: string, now: number) {
    return Boolean(await this.sql.get("DELETE FROM oauth_transactions WHERE tx_hash=? AND expires_at>? RETURNING tx_hash", [hash, now]));
  }
  async googleUser(input: { readonly sub: string; readonly email: string; readonly name: string; readonly now: number; readonly maxUsers: number }) {
    return this.sql.tx(async sql => {
      const row = await sql.get("SELECT id,onboarded_at,deleted_at FROM users WHERE google_sub=?", [input.sub]);
      const existing = row ? z.object({ id: z.string(), onboarded_at: z.string().nullable(), deleted_at: z.string().nullable() }).parse(row) : null;
      const timestamp = new Date(input.now).toISOString();
      if (existing && !existing.deleted_at) {
        await sql.run("UPDATE users SET email=?,name=?,last_seen_at=? WHERE id=?", [input.email, input.name, timestamp, existing.id]);
        return { id: existing.id, onboarded: existing.onboarded_at !== null };
      }
      const count = z.object({ count: z.number() }).parse(await sql.get("SELECT count(*) AS count FROM users WHERE deleted_at IS NULL AND id<>'local'")).count;
      if (count >= input.maxUsers) throw new ApiError(403, "signup_capacity", "Sign-ups are full.");
      // Keep the tombstone and its old tenant id, but release the identity for a new empty account.
      if (existing) await sql.run("UPDATE users SET google_sub=NULL WHERE id=?", [existing.id]);
      const id = crypto.randomUUID();
      await sql.run("INSERT INTO users(id,google_sub,email,name,created_at,last_seen_at) VALUES(?,?,?,?,?,?)",
        [id, input.sub, input.email, input.name, timestamp, timestamp]);
      await sql.run("INSERT INTO principals(id,source,token_hash,created_at,user_id) VALUES('owner','manual',?,?,?)",
        [`google:${crypto.randomUUID()}`, timestamp, id]);
      return { id, onboarded: false };
    });
  }
}

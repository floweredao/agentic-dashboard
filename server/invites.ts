import { AgentNameSchema } from "../shared/contracts";
import { Agents, hash } from "./agents";
import { ApiError } from "./errors";
import { Store } from "./store";
import { TenantDb } from "./tenant-db";

export const INVITE_TTL_MS = 15 * 60 * 1000;
// Crockford base32 without I, L, O and U: 16 characters carry 80 random bits.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const normalize = (code: string) => code.toUpperCase().replace(/[\s-]/g, "");

export interface Invite {
  readonly agent: string;
  readonly code: string;
  readonly expiresAt: string;
}

/**
 * One-time connection codes. The owner issues one for a new agent name on the dashboard host; the agent's machine trades it
 * once, within INVITE_TTL_MS, for that agent's key (POST /api/v1/agents/connect). A new code for the same name replaces the old one.
 */
export class Invites {
  constructor(private readonly store: Store, private readonly agents: Agents) {}

  async create(name: string): Promise<Invite> {
    const agent = AgentNameSchema.parse(name);
    if ((await this.store.db.get("SELECT id FROM principals WHERE (id=?) AND user_id=?", [agent]))) {
      throw new ApiError(409, "agent_exists", `Agent ${agent} already exists; pick another name or rotate its key`);
    }
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const raw = Array.from(bytes, byte => ALPHABET[byte % 32]).join("");
    const now = this.store.now();
    const expires = now + INVITE_TTL_MS;
    await this.store.db.tx(async () => {
      (await this.store.db.run("DELETE FROM agent_invites WHERE (agent=? OR expires_at<=?) AND user_id=?", [agent, now]));
      (await this.store.db.run("INSERT INTO agent_invites(code_hash,agent,created_at,expires_at,user_id) VALUES(?,?,?,?,?)", [hash(raw), agent, new Date(now).toISOString(), expires]));
    });
    return { agent, code: raw.match(/.{4}/g)?.join("-") ?? raw, expiresAt: new Date(expires).toISOString() };
  }

  /** Trades a valid code for the new agent's key, once. Unknown, used and expired codes are refused alike. */
  async redeem(code: string): Promise<{ agent: string; key: string }> {
    return await this.store.db.tx(async () => {
      const codeHash = hash(normalize(code));
      const row = await this.store.control.inviteByHash(codeHash, this.store.now());
      if (!row) {
        throw new ApiError(404, "invite_invalid", "This connection code is unknown, already used or expired; issue a new one on the dashboard host");
      }
      const store = new Store(new TenantDb(this.store.db.sql, row.user_id), this.store.now, this.store.control);
      await store.db.run("DELETE FROM agent_invites WHERE code_hash=? AND user_id=?", [codeHash]);
      const agents = row.user_id === this.store.db.userId ? this.agents : new Agents(store);
      return { agent: row.agent, key: await agents.add(row.agent) };
    });
  }
}

import { AgentNameSchema } from "../shared/contracts";
import { type Agents, hash } from "./agents";
import { ApiError } from "./errors";
import type { Store } from "./store";

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

  create(name: string): Invite {
    const agent = AgentNameSchema.parse(name);
    if (this.store.db.query("SELECT id FROM principals WHERE id=?").get(agent)) {
      throw new ApiError(409, "agent_exists", `Agent ${agent} already exists; pick another name or rotate its key`);
    }
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const raw = Array.from(bytes, byte => ALPHABET[byte % 32]).join("");
    const now = this.store.now();
    const expires = now + INVITE_TTL_MS;
    this.store.db.transaction(() => {
      this.store.db.query("DELETE FROM agent_invites WHERE agent=? OR expires_at<=?").run(agent, now);
      this.store.db.query("INSERT INTO agent_invites(code_hash,agent,created_at,expires_at) VALUES(?,?,?,?)")
        .run(hash(raw), agent, new Date(now).toISOString(), expires);
    })();
    return { agent, code: raw.match(/.{4}/g)?.join("-") ?? raw, expiresAt: new Date(expires).toISOString() };
  }

  /** Trades a valid code for the new agent's key, once. Unknown, used and expired codes are refused alike. */
  redeem(code: string): { agent: string; key: string } {
    return this.store.db.transaction(() => {
      const codeHash = hash(normalize(code));
      const row = this.store.db.query("SELECT agent FROM agent_invites WHERE code_hash=? AND expires_at>?").get(codeHash, this.store.now());
      if (!row || typeof row !== "object" || !("agent" in row) || typeof row.agent !== "string") {
        throw new ApiError(404, "invite_invalid", "This connection code is unknown, already used or expired; issue a new one on the dashboard host");
      }
      this.store.db.query("DELETE FROM agent_invites WHERE code_hash=?").run(codeHash);
      return { agent: row.agent, key: this.agents.add(row.agent) };
    })();
  }
}

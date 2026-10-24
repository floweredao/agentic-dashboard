import { z } from "zod";
import { AgentNameSchema } from "../shared/contracts";
import { ApiError } from "./errors";
import type { Store } from "./store";

export const hash = (secret: string) => new Bun.CryptoHasher("sha256").update(secret).digest("hex");
export const secret = () => crypto.getRandomValues(new Uint8Array(32)).toBase64({ alphabet: "base64url" });

export interface AgentInfo {
  readonly capture: boolean;
  readonly name: string;
  readonly createdAt: string | null;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
}
const rowSchema = z.object({ id: z.string(), capture: z.number(), created_at: z.string().nullable(), last_used_at: z.string().nullable(), revoked_at: z.string().nullable() });
const view = (value: unknown): AgentInfo => {
  const row = rowSchema.parse(value);
  return { name: row.id, capture: row.capture === 1, createdAt: row.created_at, lastUsedAt: row.last_used_at, revokedAt: row.revoked_at };
};

/**
 * The agent registry. An agent is a principal whose id and source are its name. Only a SHA-256 hash of its key is stored:
 * the key itself is shown once, when it is issued. Revoking keeps the row (its records still name it) but makes the key
 * unusable; rotating issues a new key and reactivates a revoked agent.
 */
export class Agents {
  constructor(private readonly store: Store) {}

  async list(): Promise<AgentInfo[]> {
    return (await this.store.db.all("SELECT id,capture,created_at,last_used_at,revoked_at FROM principals WHERE (source<>'manual') AND user_id=? ORDER BY id", [])).map(view);
  }

  async get(name: string): Promise<AgentInfo | null> {
    const row = (await this.store.db.get("SELECT id,capture,created_at,last_used_at,revoked_at FROM principals WHERE (id=? AND source<>'manual') AND user_id=?", [name]));
    return row ? view(row) : null;
  }

  /** Registers a new agent and returns its key. `key` is for tests and fixtures; normally a random one is issued. */
  async add(name: string, key = `fd_${secret()}`, capture = false): Promise<string> {
    const agent = AgentNameSchema.parse(name);
    if ((await this.store.db.get("SELECT id FROM principals WHERE (id=?) AND user_id=?", [agent]))) {
      throw new ApiError(409, "agent_exists", `Agent ${agent} already exists; rotate its key instead`);
    }
    (await this.store.db.run("INSERT INTO principals(id,source,token_hash,created_at,capture,user_id) VALUES(?,?,?,?,?,?)", [agent, agent, hash(key), new Date(this.store.now()).toISOString(), capture ? 1 : 0]));
    return key;
  }

  async rotate(name: string, key = `fd_${secret()}`): Promise<string> {
    const changed = (await this.store.db.run("UPDATE principals SET token_hash=?, revoked_at=NULL WHERE (id=? AND source<>'manual') AND user_id=?", [hash(key), name])).changes;
    if (!changed) throw new ApiError(404, "not_found", `No agent named ${name}`);
    return key;
  }

  async revoke(name: string): Promise<void> {
    // The stored hash is replaced with one no key can produce, so the old key stops working at once.
    const changed = (await this.store.db.run("UPDATE principals SET token_hash=?, revoked_at=? WHERE (id=? AND source<>'manual') AND user_id=?", [`revoked:${crypto.randomUUID()}`, new Date(this.store.now()).toISOString(), name])).changes;
    if (!changed) throw new ApiError(404, "not_found", `No agent named ${name}`);
  }
}

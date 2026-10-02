import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { SourceSchema } from "../shared/contracts";
import { hash, secret } from "./agents";
import { ApiError } from "./errors";
import type { Principal, Store } from "./store";

export { hash, secret };
export const SESSION_COOKIE = "agentic_session";
/** The owner's key file. Agent keys are never stored here: they live only as hashes in the database (see Agents). */
export const CredentialsSchema = z.object({ owner: z.string().min(16).max(512) }).strict();
const principalSchema = z.object({ id: z.string(), source: SourceSchema });
const sessionSchema = z.object({ hash: z.string(), principal_id: z.string(), csrf: z.string(), expires_at: z.number() });

/** Creates the owner key file (mode 0600) when it does not exist yet; answers whether it was created. */
export function ensureCredentials(credentialsPath: string): boolean {
  mkdirSync(dirname(credentialsPath), { recursive: true, mode: 0o700 });
  const created = !existsSync(credentialsPath);
  if (created) writeFileSync(credentialsPath, `${JSON.stringify({ owner: secret() }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  chmodSync(credentialsPath, 0o600);
  return created;
}
export const readCredentials = (credentialsPath: string) => CredentialsSchema.parse(JSON.parse(readFileSync(credentialsPath, "utf8")));

export class Auth {
  constructor(readonly store: Store, credentialsPath: string) {
    ensureCredentials(credentialsPath);
    const credentials = readCredentials(credentialsPath);
    store.db.query(`INSERT INTO principals(id,source,token_hash,created_at) VALUES('owner','manual',?,?)
      ON CONFLICT(id) DO UPDATE SET token_hash=excluded.token_hash`).run(hash(credentials.owner), new Date(store.now()).toISOString());
  }
  token(value: string): Principal {
    const row = this.store.db.query("SELECT id,source FROM principals WHERE token_hash=? AND revoked_at IS NULL").get(hash(value));
    if (!row) throw new ApiError(401, "unauthenticated", "Invalid credentials");
    const principal = principalSchema.parse(row);
    if (principal.source !== "manual") {
      this.store.db.query("UPDATE principals SET last_used_at=? WHERE id=?").run(new Date(this.store.now()).toISOString(), principal.id);
    }
    return principal;
  }
  findSession(request: Request) {
    const prefix = `${SESSION_COOKIE}=`;
    const cookie = request.headers.get("cookie")?.split(";").map(part => part.trim()).find(part => part.startsWith(prefix))?.slice(prefix.length);
    if (!cookie) return null;
    const row = this.store.db.query("SELECT * FROM sessions WHERE hash=? AND expires_at>?").get(hash(cookie), this.store.now());
    return row ? sessionSchema.parse(row) : null;
  }
  session(request: Request) {
    const session = this.findSession(request);
    if (!session) throw new ApiError(401, "unauthenticated", "Owner session required or expired");
    return session;
  }
  authenticate(request: Request, publicOnly: boolean): Principal {
    const authorization = request.headers.get("authorization");
    if (authorization !== null) {
      if (!authorization.startsWith("Bearer ")) throw new ApiError(401, "unauthenticated", "Bearer token required");
      const principal = this.token(authorization.slice(7));
      if (principal.source === "manual") throw new ApiError(403, "forbidden", "Owner must use a browser session");
      return principal;
    }
    if (publicOnly) throw new ApiError(401, "unauthenticated", "Agent Bearer required");
    const session = this.session(request);
    return principalSchema.parse(this.store.db.query("SELECT id,source FROM principals WHERE id=?").get(session.principal_id));
  }
  createSession(token: string) {
    const principal = this.token(token);
    if (principal.source !== "manual") throw new ApiError(403, "forbidden", "Only owner credentials create sessions");
    return this.createOwnerSession();
  }
  createOwnerSession() {
    const value = secret();
    const csrfToken = secret();
    const expires = this.store.now() + 7 * 24 * 60 * 60 * 1000;
    this.store.db.query("DELETE FROM sessions WHERE expires_at<=?").run(this.store.now());
    this.store.db.query("INSERT INTO sessions VALUES(?,?,?,?)").run(hash(value), "owner", csrfToken, expires);
    return { value, csrfToken, expiresAt: new Date(expires).toISOString() };
  }
  csrf(request: Request, origins: ReadonlySet<string>) {
    const session = this.session(request);
    if (!origins.has(request.headers.get("origin") ?? "") || request.headers.get("x-csrf-token") !== session.csrf) {
      throw new ApiError(403, "csrf", "Allowed Origin and CSRF token required");
    }
    return session;
  }
}

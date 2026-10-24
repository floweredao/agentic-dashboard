import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { SourceSchema } from "../shared/contracts";
import { hash, secret } from "./agents";
import { ApiError } from "./errors";
import { Store, type Principal } from "./store";
import { ControlDb } from "./control-db";
import { TenantDb } from "./tenant-db";

export { hash, secret };
export const SESSION_COOKIE = "agentic_session";
/** The owner's key file. Agent keys are never stored here: they live only as hashes in the database (see Agents). */
export const CredentialsSchema = z.object({ owner: z.string().min(16).max(512) }).strict();
const principalSchema = z.object({ id: z.string(), source: SourceSchema });

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
  readonly control: ControlDb;
  /** `demo`: every browser request reads as the owner without a key or session (the app blocks every change in demo mode). */
  constructor(readonly store: Store, private readonly demo = false, readonly hostedOrigin?: string) {
    this.control = new ControlDb(store.db.sql);
  }
  async initialize(credentialsPath: string) {
    ensureCredentials(credentialsPath);
    const credentials = readCredentials(credentialsPath);
    await this.store.db.run(`INSERT INTO principals(id,source,token_hash,created_at,user_id) VALUES('owner','manual',?,?,?)
      ON CONFLICT(user_id,id) DO UPDATE SET token_hash=excluded.token_hash`, [hash(credentials.owner), new Date(this.store.now()).toISOString()]);
  }
  async token(value: string): Promise<Principal> {
    const row = await this.control.principalByToken(hash(value));
    if (!row || row.user_id !== this.store.db.userId) throw new ApiError(401, "unauthenticated", "Invalid credentials");
    const principal = principalSchema.parse(row);
    if (principal.source !== "manual") {
      await this.store.db.run("UPDATE principals SET last_used_at=? WHERE id=? AND user_id=?", [new Date(this.store.now()).toISOString(), principal.id]);
    }
    return principal;
  }
  async findSession(request: Request) {
    const prefix = `${this.cookieName}=`;
    const cookie = request.headers.get("cookie")?.split(";").map(part => part.trim()).find(part => part.startsWith(prefix))?.slice(prefix.length);
    if (!cookie) return null;
    return this.control.sessionByHash(hash(cookie), this.store.now());
  }
  get cookieName() {
    return this.hostedOrigin ? (this.hostedOrigin.startsWith("https:") ? "__Host-session" : "session") : SESSION_COOKIE;
  }
  cookie(value: string, expiresAt: string, secure: boolean) {
    const https = this.hostedOrigin ? this.hostedOrigin.startsWith("https:") : secure;
    return `${this.cookieName}=${value}; Path=/; HttpOnly; SameSite=${this.hostedOrigin ? "Lax" : "Strict"}; Expires=${new Date(expiresAt).toUTCString()}${https ? "; Secure" : ""}`;
  }
  async resolveUser(request: Request) {
    const authorization = request.headers.get("authorization");
    if (authorization !== null) {
      if (!authorization.startsWith("Bearer ")) return "local";
      return (await this.control.principalByToken(hash(authorization.slice(7))))?.user_id ?? "local";
    }
    return (await this.findSession(request))?.user_id ?? "local";
  }
  async session(request: Request) {
    if (this.demo) return { user_id: "local", hash: "", principal_id: "owner", csrf: "demo", expires_at: this.store.now() + 7 * 24 * 60 * 60 * 1000 };
    const session = await this.findSession(request);
    if (!session || session.user_id !== this.store.db.userId) throw new ApiError(401, "unauthenticated", "Owner session required or expired");
    return session;
  }
  async authenticate(request: Request, publicOnly: boolean): Promise<Principal> {
    const authorization = request.headers.get("authorization");
    if (authorization !== null) {
      if (!authorization.startsWith("Bearer ")) throw new ApiError(401, "unauthenticated", "Bearer token required");
      const principal = await this.token(authorization.slice(7));
      if (principal.source === "manual") throw new ApiError(403, "forbidden", "Owner must use a browser session");
      return principal;
    }
    if (publicOnly) throw new ApiError(401, "unauthenticated", "Agent Bearer required");
    if (this.demo) return { id: "owner", source: "manual" };
    const session = await this.session(request);
    return principalSchema.parse(await this.store.db.get("SELECT id,source FROM principals WHERE id=? AND user_id=?", [session.principal_id]));
  }
  async createSession(token: string) {
    if (this.hostedOrigin) throw new ApiError(403, "google_signin_required", "Use Google sign-in.");
    const principal = await this.control.principalByToken(hash(token));
    if (!principal) throw new ApiError(401, "unauthenticated", "Invalid credentials");
    if (principal.source !== "manual") throw new ApiError(403, "forbidden", "Only owner credentials create sessions");
    return new Auth(new Store(new TenantDb(this.store.db.sql, principal.user_id), this.store.now)).createOwnerSession();
  }
  async createOwnerSession() {
    const value = secret();
    const csrfToken = secret();
    const expires = this.store.now() + (this.hostedOrigin ? 30 : 7) * 24 * 60 * 60 * 1000;
    await this.store.db.run("DELETE FROM sessions WHERE expires_at<=? AND user_id=?", [this.store.now()]);
    await this.store.db.run("INSERT INTO sessions(hash,principal_id,csrf,expires_at,user_id) VALUES(?,?,?,?,?)", [hash(value), "owner", csrfToken, expires]);
    return { value, csrfToken, expiresAt: new Date(expires).toISOString() };
  }
  async signInUser(userId: string, request: Request) {
    const previous = await this.findSession(request);
    if (previous) {
      await new TenantDb(this.store.db.sql, previous.user_id).run("DELETE FROM sessions WHERE hash=? AND user_id=?", [previous.hash]);
    }
    return new Auth(new Store(new TenantDb(this.store.db.sql, userId), this.store.now), false, this.hostedOrigin).createOwnerSession();
  }
  async csrf(request: Request, origins: ReadonlySet<string>) {
    const session = await this.session(request);
    if (!origins.has(request.headers.get("origin") ?? "") || request.headers.get("x-csrf-token") !== session.csrf) {
      throw new ApiError(403, "csrf", "Allowed Origin and CSRF token required");
    }
    return session;
  }
}

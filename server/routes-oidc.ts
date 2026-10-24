import type { Hono } from "hono";
import type { TenantRuntime } from "./app-runtime";
import { authPage } from "./auth-pages";
import { ApiError } from "./errors";
import { oidcCookie } from "./oidc";

export function registerOidc(app: Hono, runtime: TenantRuntime) {
  const { options, auth, privateUrl, store, origins } = runtime;
  const korean = (request: Request) => (request.headers.get("accept-language") ?? options.locale ?? "en").startsWith("ko");
  app.get("/auth/google/start", async c => {
    if (!options.oidc) throw new ApiError(404, "not_found", "Google sign-in is not enabled.");
    const result = await options.oidc.start(c.req.raw);
    c.header("Set-Cookie", oidcCookie(result.cookie, privateUrl.protocol === "https:"));
    return c.redirect(result.location, 302);
  });
  app.get("/auth/google/callback", async c => {
    if (!options.oidc) throw new ApiError(404, "not_found", "Google sign-in is not enabled.");
    c.header("Set-Cookie", oidcCookie("", privateUrl.protocol === "https:", 0));
    try {
      const user = await options.oidc.callback(c.req.raw);
      const session = await auth.signInUser(user.id, c.req.raw);
      c.header("Set-Cookie", auth.cookie(session.value, session.expiresAt, privateUrl.protocol === "https:"), { append: true });
      return c.redirect(user.deletionIntent ? "/delete-confirm" : user.onboarded ? "/" : "/welcome", 302);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      return c.html(authPage(error.code === "signup_capacity", korean(c.req.raw)), error.status);
    }
  });
  app.get("/auth/capacity", c => c.html(authPage(true, korean(c.req.raw)), 403));
  app.post("/auth/logout", async c => {
    await runtime.owner(c.req.raw, true);
    const session = await auth.csrf(c.req.raw, origins);
    await store.db.run("DELETE FROM sessions WHERE hash=? AND user_id=?", [session.hash]);
    c.header("Set-Cookie", auth.cookie("", new Date(0).toISOString(), privateUrl.protocol === "https:"));
    return c.body(null, 204);
  });
}

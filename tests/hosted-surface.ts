import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createApp } from "../server/app";
import { appOptions } from "../server/config-app";
import { parseConfig } from "../server/config";
import { secret } from "../server/agents";
import { createForwarder } from "../scripts/mcp-forward";
import { mockOidc } from "./helpers/mock-oidc";

const directory = mkdtempSync(join(tmpdir(), "hosted-surface-"));
const issuer = await mockOidc();
let app: Awaited<ReturnType<typeof createApp>> | null = null;
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => app?.fetch(request) ?? new Response(null, { status: 503 }) });
const origin = `http://127.0.0.1:${server.port}`;
const config = parseConfig({
  AUTH_MODE: "google", APP_ORIGIN: origin, PORT: String(server.port), DATA_DIR: directory, PUSH: "off", NARRATION: "off",
  APP_SECRETS: JSON.stringify({ google: { clientId: "surface-client", clientSecret: secret() }, sessionSigningKey: secret(),
    kek: { "1": Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64") } }),
});
if (!config.hosted) throw new TypeError("Hosted surface configuration required");
app = await createApp({
  ...appOptions(config), hosted: { ...config.hosted, endpoints: issuer.endpoints },
  enrichCapture: async () => ({ title: "Surface capture", fields: { summary: "Captured through the authenticated API.",
    captureEnrichment: { status: "available", source: "page" } } }),
});
const check = (condition: boolean, label: string) => { if (!condition) throw new Error(`Surface check failed: ${label}`); };
let proxy: ReturnType<typeof Bun.serve> | null = null;
try {
  const start = await fetch(`${origin}/auth/google/start`, { redirect: "manual" });
  const tx = start.headers.getSetCookie()[0]?.split(";")[0] ?? "";
  const authorize = await fetch(start.headers.get("location") ?? "", { redirect: "manual" });
  const callback = await fetch(authorize.headers.get("location") ?? "", { headers: { Cookie: tx }, redirect: "manual" });
  check(callback.status === 302, "OIDC callback");
  const cookie = callback.headers.getSetCookie().find(value => value.startsWith("session="))?.split(";")[0] ?? "";
  const sessionResponse = await fetch(`${origin}/api/v1/auth/session`, { headers: { Cookie: cookie } });
  const session = z.object({ csrfToken: z.string() }).parse(await sessionResponse.json());
  const owner = { Cookie: cookie, Origin: origin, "X-CSRF-Token": session.csrfToken, "Content-Type": "application/json" };
  check(sessionResponse.status === 200, "owner session");
  const issued = await fetch(`${origin}/api/v1/agents`, { method: "POST", headers: owner, body: JSON.stringify({ name: "omo", capture: true }) });
  const agent = z.object({ key: z.string() }).parse(await issued.json());
  check(issued.status === 201, "token creation");
  const recordPath = join(directory, "record.json");
  writeFileSync(recordPath, JSON.stringify({ kind: "note", title: "CLI surface proof", body: "Saved through the actual public agent CLI.", tags: ["test"] }), { mode: 0o600 });
  const cli = Bun.spawn([process.execPath, "scripts/agent.ts", "--url", origin, "--file", recordPath, "--request-id", "surface-cli"], {
    cwd: join(import.meta.dir, ".."), env: { ...process.env, HOME: directory, DASHBOARD_TOKEN: agent.key }, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(cli.stdout).text(), new Response(cli.stderr).text(), cli.exited]);
  check(code === 0, `CLI exit ${code}; diagnostics present=${stderr.length > 0}`);
  const saved = z.object({ record: z.object({ id: z.string(), source: z.string() }) }).parse(JSON.parse(stdout));
  check(saved.record.source === "omo", "CLI attribution");
  let forward: ReturnType<typeof createForwarder> | null = null;
  proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => forward?.(request) ?? new Response(null, { status: 503 }) });
  forward = createForwarder({ destination: `${origin}/mcp`, token: agent.key, host: `127.0.0.1:${proxy.port}` });
  const mcp = await fetch(`http://127.0.0.1:${proxy.port}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_record", arguments: { id: saved.record.id } } }) });
  const result = z.object({ result: z.object({ structuredContent: z.object({ id: z.string() }) }) }).parse(await mcp.json());
  check(mcp.status === 200 && result.result.structuredContent.id === saved.record.id, "MCP forwarder read");
  const absent = await fetch(`${origin}/api/v1/capture`, { method: "POST", headers: { "Content-Type": "application/json", "X-Capture": "shortcut-v1" },
    body: JSON.stringify({ url: "https://example.test/article" }) });
  check(absent.status === 401, "capture bearer requirement");
  const captured = await fetch(`${origin}/api/v1/capture`, { method: "POST",
    headers: { Authorization: `Bearer ${agent.key}`, "Content-Type": "application/json", "X-Capture": "shortcut-v1" },
    body: JSON.stringify({ url: "https://example.test/article" }) });
  check(captured.status === 201, "authenticated capture");
  const forged = await fetch(`${origin}/auth/google/callback?code=x&state=forged`, { redirect: "manual" });
  check(forged.status === 400, "forged callback");
  const wrongOrigin = await fetch(`${origin}/api/v1/agents`, { method: "POST", headers: { ...owner, Origin: "https://evil.example" },
    body: JSON.stringify({ name: "forbidden" }) });
  check(wrongOrigin.status === 403 && z.object({ error: z.object({ code: z.string() }) }).parse(await wrongOrigin.json()).error.code === "csrf", "foreign Origin");
  console.log(JSON.stringify({ oidcSession: 200, forgedCallback: 400, cliExit: code, recordId: saved.record.id, source: "omo",
    mcpForwarder: 200, unauthenticatedCapture: 401, authenticatedCapture: 201, foreignOrigin: "403 csrf" }));
} finally {
  proxy?.stop(true);
  server.stop(true);
  issuer.close();
  await app.close();
  rmSync(directory, { recursive: true, force: true });
}

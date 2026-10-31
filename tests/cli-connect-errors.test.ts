import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { en, ko } from "../cli/i18n";
import { createApp } from "../server/app";

const main = join(import.meta.dir, "..", "cli", "main.ts");
let dir = "";
let app: Awaited<ReturnType<typeof createApp>> | null = null;
let server: ReturnType<typeof Bun.serve> | null = null;
// The connect route answers from the real app, or with the body the server's rate limiter or error handler sends.
let connectReply: "app" | "rate-limited" | "internal" = "app";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agentic-cli-connect-"));
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = probe.port;
  probe.stop(true);
  app = await createApp({ databasePath: join(dir, "data", "dashboard.sqlite"), credentialsPath: join(dir, "data", "credentials.json"), port });
  server = Bun.serve({ hostname: "127.0.0.1", port, fetch: request => {
    if (new URL(request.url).pathname === "/api/v1/agents/connect" && connectReply !== "app") {
      return connectReply === "rate-limited"
        ? Response.json({ error: { code: "rate_limited", message: "Request limit exceeded" } }, { status: 429, headers: { "Retry-After": "60" } })
        : Response.json({ error: { code: "internal_error", message: "Internal server error" } }, { status: 500 });
    }
    return app?.fetch(request) ?? new Response(null, { status: 503 });
  } });
});
afterAll(async () => { server?.stop(true); await app?.close(); rmSync(dir, { recursive: true, force: true }); });

async function connect(lang: "en" | "ko", code: string) {
  const home = join(dir, `${lang}-${Math.random().toString(36).slice(2)}`);
  const child = Bun.spawn([process.execPath, main, "connect", "--url", `http://127.0.0.1:${server?.port}`, "--code", code, "--key-store", "file"], {
    env: { ...process.env, HOME: home, AGENTIC_DASHBOARD_HOME: join(home, ".agentic-dashboard"), AGENTIC_DASHBOARD_LANG: lang,
      AGENTIC_DASHBOARD_LAUNCHER: "", DASHBOARD_URL: "", DASHBOARD_TOKEN: "", CODEX_HOME: "" },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const stderr = await new Response(child.stderr).text();
  return { code: await child.exited, stderr: stderr.trim() };
}

test("a malformed connection code is refused in the CLI's language, not with the server's English validation message", async () => {
  connectReply = "app";
  const tooLong = "A".repeat(65);
  expect(await connect("ko", tooLong)).toEqual({ code: 1, stderr: ko.connectBadCode });
  expect(await connect("en", tooLong)).toEqual({ code: 1, stderr: en.connectBadCode });
});

test("a rate-limited or failed code redemption is reported in Korean, with the HTTP status when there is no better word", async () => {
  connectReply = "rate-limited";
  expect(await connect("ko", "ABCD-EFGH-JKLM-NPQR")).toEqual({ code: 1, stderr: ko.connectRateLimited });
  connectReply = "internal";
  expect(await connect("ko", "ABCD-EFGH-JKLM-NPQR")).toEqual({ code: 1, stderr: ko.connectCodeFailed.replace("{status}", "500") });
});

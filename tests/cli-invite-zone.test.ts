import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setLang } from "../cli/i18n";
import { formatEnv, paths, writePrivate } from "../cli/paths";
import { invite } from "../cli/server";

// loadServerEnv copies server.env into process.env; put back exactly what was there.
const KEYS = ["TZ", "TIME_ZONE", "DATA_DIR", "STATIC_DIR", "PORT", "APP_ORIGIN", "CREDENTIALS_PATH", "DATABASE_PATH", "AGENTIC_DASHBOARD_LANG"];
const saved = Object.fromEntries(KEYS.map(key => [key, process.env[key]]));
const dirs: string[] = [];
afterEach(() => {
  setSystemTime();
  for (const key of KEYS) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  setLang("en");
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function issue(env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "agentic-invite-zone-"));
  dirs.push(dir);
  const p = paths({ HOME: dir, AGENTIC_DASHBOARD_HOME: join(dir, ".agentic-dashboard") });
  mkdirSync(p.home, { recursive: true });
  for (const key of KEYS) delete process.env[key];
  // The host machine runs in UTC; the dashboard is configured for Seoul.
  process.env["TZ"] = "UTC";
  process.env["AGENTIC_DASHBOARD_LANG"] = "en";
  setLang("en");
  writePrivate(p.serverEnv, formatEnv("# test", { PORT: "4399", DATA_DIR: p.data, ...env }));
  mkdirSync(p.data, { recursive: true });
  const out: string[] = [];
  const write = spyOn(process.stdout, "write").mockImplementation(chunk => { out.push(String(chunk)); return true; });
  try { (await invite(p, "laptop")); } finally { write.mockRestore(); }
  return out.join("");
}

test("invite prints the code's expiry in the dashboard's TIME_ZONE, not the host machine's zone", async () => {
  // 23:50 in Seoul (14:50 UTC): the 15-minute code runs out at 00:05 the next day there.
  setSystemTime(new Date("2026-10-23T14:50:00Z"));
  expect(await issue({ TIME_ZONE: "Asia/Seoul" })).toContain("It works once, until 12:05 AM.");
});

test("invite falls back to the host's zone when TIME_ZONE is unset or unknown", async () => {
  setSystemTime(new Date("2026-10-23T14:50:00Z"));
  expect(await issue({})).toContain("It works once, until 03:05 PM.");
  setSystemTime(new Date("2026-10-23T14:50:00Z"));
  expect(await issue({ TIME_ZONE: "Mars/Olympus" })).toContain("It works once, until 03:05 PM.");
});

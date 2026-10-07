import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { Agents } from "../server/agents";
import { ensureCredentials, readCredentials } from "../server/auth";
import { Invites } from "../server/invites";
import { Store } from "../server/store";
import { CliError } from "./client";
import { detectLang, t } from "./i18n";
import { APP_ROOT, ensureHome, formatEnv, INSTALL_URL, type Paths, readEnvFile, writePrivate } from "./paths";
import { ask, choose, confirm, interactive, say } from "./prompt";
import { installService, restartService, serviceFile, serviceState } from "./service";

const HEADER = "# Written by agentic-dashboard setup. Every variable in .env.example works here too; restart the dashboard after editing.";

/** Puts server.env into the environment (variables already set win) with absolute defaults, and answers the result. */
export function loadServerEnv(p: Paths) {
  for (const [key, value] of Object.entries(readEnvFile(p.serverEnv) ?? {})) if (process.env[key] === undefined) process.env[key] = value;
  process.env["DATA_DIR"] ??= p.data;
  process.env["STATIC_DIR"] ??= join(APP_ROOT, "dist");
  const port = process.env["PORT"] ?? "4310";
  return {
    port, data: process.env["DATA_DIR"],
    url: process.env["APP_ORIGIN"] ?? `http://127.0.0.1:${port}`,
    credentials: process.env["CREDENTIALS_PATH"] ?? join(process.env["DATA_DIR"], "credentials.json"),
    database: process.env["DATABASE_PATH"] ?? join(process.env["DATA_DIR"], "dashboard.sqlite"),
  };
}

export function ensureWebApp() {
  if (existsSync(join(process.env["STATIC_DIR"] ?? join(APP_ROOT, "dist"), "index.html"))) return;
  say(t("setupBuilding"));
  const build = Bun.spawnSync([process.execPath, "x", "vite", "build", "--logLevel", "error"], { cwd: APP_ROOT, stdout: "inherit", stderr: "inherit" });
  if (build.exitCode !== 0) throw new CliError(t("setupBuildFailed"));
}

function portFree(port: number) {
  try {
    const listener = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
    listener.stop(true);
    return true;
  } catch {
    return false;
  }
}

function tailscaleName() {
  const binary = Bun.which("tailscale") ?? ["/Applications/Tailscale.app/Contents/MacOS/Tailscale"].find(path => existsSync(path));
  if (!binary) return null;
  const result = Bun.spawnSync([binary, "status", "--json"], { stdout: "pipe", stderr: "ignore", timeout: 5000 });
  if (result.exitCode !== 0) return null;
  const parsed = z.object({ Self: z.object({ DNSName: z.string().min(1) }) }).safeParse(JSON.parse(result.stdout.toString() || "null"));
  return parsed.success ? parsed.data.Self.DNSName.replace(/\.$/, "") : null;
}

const validOrigin = (value: string) => URL.canParse(value) && /^https?:$/.test(new URL(value).protocol);

async function waitForHealth(url: string) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const ok = await fetch(`${url}/api/v1/health`, { signal: AbortSignal.timeout(2000) }).then(response => response.ok, () => false);
    if (ok) return true;
    await Bun.sleep(500);
  }
  return false;
}

export interface SetupFlags {
  readonly yes?: boolean | undefined;
  readonly port?: string | undefined;
  readonly dataDir?: string | undefined;
  readonly origin?: string | undefined;
  readonly service?: boolean | undefined;
}

/** Host onboarding; answers true when the caller should start the dashboard in this terminal. */
export async function setup(p: Paths, flags: SetupFlags): Promise<boolean> {
  const prompting = interactive() && !flags.yes;
  if (!prompting && !flags.yes) throw new CliError(t("setupNeedTerminal"));
  const existing = readEnvFile(p.serverEnv) ?? {};
  const runningPort = serviceState(p) === "running" ? existing["PORT"] ?? "4310" : null;
  if (prompting) say(t("setupIntro"));

  let port = 0;
  for (;;) {
    const raw = flags.port ?? (prompting ? await ask(t("setupPort"), existing["PORT"] ?? "4310") : existing["PORT"] ?? "4310");
    const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
    let problem = Number.isInteger(value) && value >= 1 && value <= 65535 ? null : t("setupPortInvalid");
    if (!problem && String(value) !== runningPort && !portFree(value)) problem = t("setupPortBusy", { port: value });
    if (!problem) { port = value; break; }
    if (!prompting || flags.port) throw new CliError(problem);
    say(problem);
  }

  const dataRaw = flags.dataDir ?? (prompting ? await ask(t("setupData"), existing["DATA_DIR"] ?? p.data) : existing["DATA_DIR"] ?? p.data);
  const dataDir = resolve(dataRaw.replace(/^~(?=$|\/)/, p.userHome));

  let origin = flags.origin ?? existing["APP_ORIGIN"] ?? "";
  if (prompting && flags.origin === undefined) {
    const local = `http://127.0.0.1:${port}`;
    const access = await choose(t("setupAccess"), [t("setupAccessLocal", { port }), t("setupAccessTailscale"), t("setupAccessProxy")],
      !origin || origin === local ? 0 : origin.endsWith(".ts.net") ? 1 : 2);
    if (access === 0) origin = "";
    else {
      const name = access === 1 ? tailscaleName() : null;
      if (access === 1 && !name) say(t("setupTailscaleMissing"));
      for (;;) {
        origin = await ask(t("setupOrigin"), name ? `https://${name}` : origin);
        if (!origin || validOrigin(origin)) break;
        say(t("setupOriginInvalid"));
      }
      if (access === 1) say(t("setupTailscaleServe", { command: `tailscale serve --bg http://127.0.0.1:${port}` }));
    }
  }
  if (origin && !validOrigin(origin)) throw new CliError(t("setupOriginInvalid"));
  origin = origin ? new URL(origin).origin : "";

  ensureHome(p);
  const values: Record<string, string> = { ...existing, HOST: existing["HOST"] ?? "127.0.0.1", PORT: String(port), DATA_DIR: dataDir,
    LOCALE: existing["LOCALE"] ?? detectLang() };
  if (origin) values["APP_ORIGIN"] = origin;
  else delete values["APP_ORIGIN"];
  writePrivate(p.serverEnv, formatEnv(HEADER, values));
  say(t("setupSaved", { path: p.serverEnv }));

  const settings = loadServerEnv(p);
  const created = ensureCredentials(settings.credentials);
  if (created) {
    say(t("setupOwnerCreated", { path: settings.credentials }));
    say(prompting ? t("setupOwnerShow", { key: readCredentials(settings.credentials).owner }) : t("setupOwnerHidden"));
  } else say(t("setupOwnerKept", { path: settings.credentials }));
  ensureWebApp();

  const local = `http://127.0.0.1:${port}`;
  const supported = serviceFile(p) !== null;
  const wanted = flags.service ?? (prompting && supported ? await confirm(t("setupService"), true) : false);
  let startHere = false;
  if (wanted && !supported) say(t("setupServiceUnsupported"));
  else if (wanted) {
    const state = serviceState(p);
    const file = state === "running" && runningPort === String(port) ? (restartService(), serviceFile(p) ?? "") : installService(p);
    say(t("setupServiceInstalled", { path: file, log: join(p.logs, "server.log") }));
    say(await waitForHealth(local) ? t("setupRunning", { url: origin || local }) : t("setupNotRunning", { log: join(p.logs, "server.log") }));
  } else if (prompting) startHere = await confirm(t("setupStartNow"), true);
  if (!startHere && !wanted) say(t("setupStartLater", { url: origin || local }));
  say(t("setupNext"));
  return startHere;
}

export async function start(p: Paths) {
  if (!existsSync(p.serverEnv)) say(t("startDefaults", { data: p.data }));
  loadServerEnv(p);
  ensureWebApp();
  await import("../server/index");
}

export function invite(p: Paths, name: string | undefined) {
  if (!name) throw new CliError(t("inviteUsage"));
  const settings = loadServerEnv(p);
  const store = new Store(settings.database, Date.now);
  try {
    const issued = new Invites(store, new Agents(store)).create(name);
    const time = new Date(issued.expiresAt).toLocaleTimeString(detectLang() === "ko" ? "ko-KR" : "en-US", { hour: "2-digit", minute: "2-digit" });
    const args = `connect --url ${settings.url} --code ${issued.code}`;
    say(t("inviteIssued", { agent: issued.agent, code: issued.code, time }));
    say();
    say(t("inviteRemote", { command: `curl -fsSL ${INSTALL_URL} | sh -s -- ${args}` }));
    say(t("inviteInstalled", { command: `agentic-dashboard ${args}` }));
    if (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|$)/.test(settings.url)) { say(); say(t("inviteLoopback", { url: settings.url })); }
  } catch (error) {
    if (error instanceof z.ZodError) throw new CliError(t("invalidName", { detail: error.issues.map(issue => issue.message).join("; ") }));
    throw error;
  } finally {
    store.close();
  }
}

export function ownerKey(p: Paths) {
  const settings = loadServerEnv(p);
  ensureCredentials(settings.credentials);
  say(t("ownerKey", { path: settings.credentials, key: readCredentials(settings.credentials).owner }));
}

export function serverStatus(p: Paths) {
  if (!existsSync(p.serverEnv)) return t("statusNoServer");
  const settings = loadServerEnv(p);
  const state = serviceState(p);
  const service = t(state === "running" ? "stateRunning" : state === "stopped" ? "stateStopped" : state === "not-installed" ? "stateNotInstalled" : "stateUnsupported");
  return t("statusServer", { port: settings.port, data: settings.data, url: settings.url, service });
}

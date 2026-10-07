import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const APP_ROOT = resolve(import.meta.dir, "..");
export const INSTALL_URL = "https://raw.githubusercontent.com/floweredao/agentic-dashboard/main/install.sh";

/** Everything the CLI keeps lives under one folder (AGENTIC_DASHBOARD_HOME, default ~/.agentic-dashboard), apart from the app itself. */
export function paths(env: NodeJS.ProcessEnv = process.env) {
  const userHome = env["HOME"] || homedir();
  const home = env["AGENTIC_DASHBOARD_HOME"] || join(userHome, ".agentic-dashboard");
  return {
    userHome, home,
    serverEnv: join(home, "server.env"),
    client: join(home, "client.json"),
    keyFile: join(home, "agent-key"),
    data: join(home, "data"),
    logs: join(home, "logs"),
  };
}
export type Paths = ReturnType<typeof paths>;

export function ensureHome(p: Paths) {
  mkdirSync(p.home, { recursive: true, mode: 0o700 });
  chmodSync(p.home, 0o700);
}

const shellWord = (value: string) => /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
/** The shell command agents run on this computer: the installed launcher when there is one, else Bun with this checkout's CLI. */
export function launcher(env: NodeJS.ProcessEnv = process.env) {
  const installed = env["AGENTIC_DASHBOARD_LAUNCHER"] || Bun.which("agentic-dashboard");
  return (installed ? [installed] : [process.execPath, join(APP_ROOT, "cli", "main.ts")]).map(shellWord).join(" ");
}

/** KEY=value lines; values are written JSON-quoted and read back either quoted or bare. */
export function parseEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match?.[1] || match[2] === undefined) continue;
    const raw = match[2].trim();
    values[match[1]] = raw.startsWith("\"") ? String(JSON.parse(raw)) : raw;
  }
  return values;
}
export const formatEnv = (header: string, values: Record<string, string>) =>
  `${header}\n${Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join("\n")}\n`;
export const readEnvFile = (path: string) => existsSync(path) ? parseEnv(readFileSync(path, "utf8")) : null;

/** Writes a file only its owner can read (mode 0600), also when it already existed with a wider mode. */
export function writePrivate(path: string, text: string) {
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}

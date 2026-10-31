import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

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

/** KEY=value lines; values are written JSON-quoted and read back "double-quoted", 'single-quoted' or bare, where ` # …` is a comment. */
export function parseEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match?.[1] || match[2] === undefined) continue;
    const raw = match[2].trim();
    const quoted = /^("(?:[^"\\]|\\.)*")|^'([^']*)'/.exec(raw);
    values[match[1]] = quoted?.[1] !== undefined ? String(JSON.parse(quoted[1])) : quoted?.[2] ?? raw.replace(/(^|\s)#.*$/, "").trim();
  }
  return values;
}
export const formatEnv = (header: string, values: Record<string, string>) =>
  `${header}\n${Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join("\n")}\n`;
export const readEnvFile = (path: string) => existsSync(path) ? parseEnv(readFileSync(path, "utf8")) : null;

/**
 * Writes a file only its owner can read (mode 0600): a new file renamed over the old one, so a wider mode, a handle opened
 * while it was readable or a symlink at the path never sees the text.
 */
export function writePrivate(path: string, text: string) {
  const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, text, { mode: 0o600, flag: "wx" });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

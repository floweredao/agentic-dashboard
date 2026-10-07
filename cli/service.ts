import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { APP_ROOT, type Paths } from "./paths";

export const SERVICE_LABEL = "dev.agentic-dashboard.server";
const UNIT = "agentic-dashboard.service";
export type ServiceState = "running" | "stopped" | "not-installed" | "unsupported";
export interface ServiceSpec {
  readonly bun: string;
  readonly main: string;
  readonly home: string;
  readonly log: string;
  readonly path: string;
}

const xml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// systemd unquotes "..." with C-style escapes and expands % specifiers, so both are escaped.
const unitQuote = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/%/g, "%%")}"`;

export function renderPlist(spec: ServiceSpec) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(spec.bun)}</string>
    <string>${xml(spec.main)}</string>
    <string>start</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AGENTIC_DASHBOARD_HOME</key><string>${xml(spec.home)}</string>
    <key>PATH</key><string>${xml(spec.path)}</string>
  </dict>
  <key>WorkingDirectory</key><string>${xml(spec.home)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>${xml(spec.log)}</string>
  <key>StandardErrorPath</key><string>${xml(spec.log)}</string>
</dict>
</plist>
`;
}

export function renderUnit(spec: ServiceSpec) {
  return `[Unit]
Description=Agentic Dashboard
After=network-online.target

[Service]
ExecStart=${unitQuote(spec.bun)} ${unitQuote(spec.main)} start
Environment=${unitQuote(`AGENTIC_DASHBOARD_HOME=${spec.home}`)}
Environment=${unitQuote(`PATH=${spec.path}`)}
WorkingDirectory=${unitQuote(spec.home)}
Restart=on-failure
RestartSec=5
StandardOutput=append:${spec.log}
StandardError=append:${spec.log}

[Install]
WantedBy=default.target
`;
}

export function serviceFile(p: Paths, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env) {
  if (platform === "darwin") return join(p.userHome, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
  if (platform === "linux") return join(env["XDG_CONFIG_HOME"] || join(p.userHome, ".config"), "systemd", "user", UNIT);
  return null;
}

const run = (command: string[]) => {
  const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
  return { ok: result.exitCode === 0, output: `${result.stdout.toString()}${result.stderr.toString()}` };
};
const must = (command: string[]) => {
  const result = run(command);
  if (!result.ok) throw new Error(`${command.join(" ")} failed: ${result.output.trim()}`);
};
const domain = () => `gui/${process.getuid?.() ?? 0}`;

export const specFor = (p: Paths): ServiceSpec => ({
  bun: process.execPath, main: join(APP_ROOT, "cli", "main.ts"), home: p.home, log: join(p.logs, "server.log"),
  path: [dirname(process.execPath), "/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
});

export function installService(p: Paths): string {
  const file = serviceFile(p);
  if (!file) throw new Error("unsupported");
  const spec = specFor(p);
  mkdirSync(dirname(file), { recursive: true });
  mkdirSync(p.logs, { recursive: true, mode: 0o700 });
  if (process.platform === "darwin") {
    writeFileSync(file, renderPlist(spec));
    run(["launchctl", "bootout", `${domain()}/${SERVICE_LABEL}`]);
    must(["launchctl", "bootstrap", domain(), file]);
  } else {
    writeFileSync(file, renderUnit(spec));
    must(["systemctl", "--user", "daemon-reload"]);
    must(["systemctl", "--user", "enable", UNIT]);
    must(["systemctl", "--user", "restart", UNIT]);
  }
  return file;
}

export function uninstallService(p: Paths) {
  const file = serviceFile(p);
  if (!file) throw new Error("unsupported");
  if (process.platform === "darwin") run(["launchctl", "bootout", `${domain()}/${SERVICE_LABEL}`]);
  else run(["systemctl", "--user", "disable", "--now", UNIT]);
  rmSync(file, { force: true });
  if (process.platform === "linux") run(["systemctl", "--user", "daemon-reload"]);
}

export function restartService() {
  if (process.platform === "darwin") must(["launchctl", "kickstart", "-k", `${domain()}/${SERVICE_LABEL}`]);
  else must(["systemctl", "--user", "restart", UNIT]);
}

export function serviceState(p: Paths): ServiceState {
  const file = serviceFile(p);
  if (!file) return "unsupported";
  if (!existsSync(file)) return "not-installed";
  if (process.platform === "darwin") {
    const result = run(["launchctl", "print", `${domain()}/${SERVICE_LABEL}`]);
    return result.ok && /state = running/.test(result.output) ? "running" : "stopped";
  }
  return run(["systemctl", "--user", "is-active", UNIT]).ok ? "running" : "stopped";
}

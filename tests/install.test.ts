import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "..", "install.sh");

// install.sh runs against a local archive and a stand-in `bun` that reports how it was called, so nothing is downloaded.
const STUB_BUN = `#!/bin/sh
case "$1" in
  --version) echo 1.3.0 ;;
  install|x) exit 0 ;;
  *)
    [ -f "$1" ] || { echo "no such file: $1" >&2; exit 9; }
    printf 'main=%s\\nhome=%s\\nlauncher=%s\\n' "$1" "$AGENTIC_DASHBOARD_HOME" "$AGENTIC_DASHBOARD_LAUNCHER"
    shift
    for arg in "$@"; do printf 'arg=%s\\n' "$arg"; done ;;
esac
`;

function run(command: string[], cwd: string, env: Record<string, string>) {
  const result = Bun.spawnSync(command, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

test("install.sh with a relative home and command folder writes a command that works from any folder", () => {
  // realpath: macOS tmpdir() is /var/..., which install.sh resolves to /private/var/...
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agentic install-")));
  try {
    const stubs = join(dir, "stubs");
    mkdirSync(stubs);
    writeFileSync(join(stubs, "bun"), STUB_BUN, { mode: 0o755 });
    const source = join(dir, "source", "agentic-dashboard-main");
    mkdirSync(join(source, "cli"), { recursive: true });
    writeFileSync(join(source, "cli", "main.ts"), "// stand-in\n");
    const archive = join(dir, "app.tar.gz");
    expect(run(["tar", "-czf", archive, "-C", join(dir, "source"), "agentic-dashboard-main"], dir, { PATH: "/usr/bin:/bin" }).code).toBe(0);

    const home = join(dir, "my home");
    const work = join(dir, "work dir");
    mkdirSync(home);
    mkdirSync(work);
    const env = { HOME: home, PATH: `${stubs}:/usr/bin:/bin`, TMPDIR: dir, AGENTIC_DASHBOARD_SOURCE: archive };
    const install = { ...env, AGENTIC_DASHBOARD_HOME: "dash", AGENTIC_DASHBOARD_BIN_DIR: "bin" };
    const main = join(work, "dash", "app", "cli", "main.ts");
    const command = join(work, "bin", "agentic-dashboard");

    // The first run hands its arguments to the new command, which sees absolute paths.
    for (let round = 0; round < 2; round += 1) {
      const installed = run(["/bin/sh", script, "connect", "--url", "two words"], work, install);
      expect([installed.code, installed.stderr]).toEqual([0, ""]);
      expect(installed.stdout).toContain(`Installed ${command}\n`);
      expect(installed.stdout).toContain(`main=${main}\nhome=${join(work, "dash")}\nlauncher=${command}\narg=connect\narg=--url\narg=two words\n`);
    }
    expect(readFileSync(join(work, "dash", "app", "cli", "main.ts"), "utf8")).toBe("// stand-in\n");

    const elsewhere = run([command, "status"], home, env);
    expect([elsewhere.code, elsewhere.stderr]).toEqual([0, ""]);
    expect(elsewhere.stdout).toBe(`main=${main}\nhome=${join(work, "dash")}\nlauncher=${command}\narg=status\n`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

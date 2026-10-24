import { expect, test } from "bun:test";
import { closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { writePrivate } from "../cli/paths";

const root = join(import.meta.dir, "..");
const mode = (path: string) => (statSync(path).mode & 0o777).toString(8);
const secret = "agent-key-0123456789abcdef0123456789abcdef";

test("a private file that existed with a wider mode is replaced, so a handle opened while it was readable never reads the new text", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentic-private-"));
  try {
    const path = join(dir, "agent-key");
    writeFileSync(path, "old\n", { mode: 0o644 });
    // Someone who could read the file before keeps the handle they opened then.
    const before = openSync(path, "r");
    try {
      writePrivate(path, `${secret}\n`);
      const buffer = Buffer.alloc(256);
      expect(buffer.subarray(0, readSync(before, buffer, 0, buffer.length, 0)).toString("utf8")).not.toContain(secret);
    } finally { closeSync(before); }
    expect([readFileSync(path, "utf8"), mode(path)]).toEqual([`${secret}\n`, "600"]);
    expect(readdirSync(dir)).toEqual(["agent-key"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a private file is written in place of a symlink there, never through it to the file it points at", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentic-private-"));
  try {
    const home = join(dir, "home");
    mkdirSync(home, { mode: 0o700 });
    const elsewhere = join(dir, "shared.txt");
    writeFileSync(elsewhere, "shared notes\n", { mode: 0o644 });
    for (const name of ["agent-key", "client.json", "server.env"]) {
      symlinkSync(elsewhere, join(home, name));
      writePrivate(join(home, name), `${secret}\n`);
      expect(lstatSync(join(home, name)).isSymbolicLink()).toBe(false);
      expect([readFileSync(join(home, name), "utf8"), mode(join(home, name))]).toEqual([`${secret}\n`, "600"]);
    }
    expect([readFileSync(elsewhere, "utf8"), mode(elsewhere)]).toEqual(["shared notes\n", "644"]);
    expect(readdirSync(home).sort()).toEqual(["agent-key", "client.json", "server.env"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("install.sh writes the command with its folders as plain words, so quotes, $( ) and backticks in them never run", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentic-install-"));
  try {
    // A stand-in release: a main.ts that reports where it runs from and the settings the command passed it.
    const release = join(dir, "release", "agentic-dashboard-main");
    mkdirSync(join(release, "cli"), { recursive: true });
    writeFileSync(join(release, "package.json"), JSON.stringify({ name: "fixture", private: true }));
    writeFileSync(join(release, "cli", "main.ts"), "console.log(JSON.stringify({ main: import.meta.path, home: process.env.AGENTIC_DASHBOARD_HOME, "
      + "launcher: process.env.AGENTIC_DASHBOARD_LAUNCHER, args: Bun.argv.slice(2) }));\n");
    const tarball = join(dir, "app.tar.gz");
    expect(Bun.spawnSync(["tar", "-czf", tarball, "-C", join(dir, "release"), "agentic-dashboard-main"]).exitCode).toBe(0);
    const odd = "a \"b\" $(touch ran-dollar) `touch ran-backtick` c'd";
    const appHome = join(dir, `home ${odd}`);
    const binDir = join(dir, `bin ${odd}`);
    const work = join(dir, "work");
    mkdirSync(work);
    const env = { ...process.env, HOME: join(dir, "user"), AGENTIC_DASHBOARD_HOME: appHome, AGENTIC_DASHBOARD_BIN_DIR: binDir,
      AGENTIC_DASHBOARD_SOURCE: tarball, AGENTIC_DASHBOARD_LAUNCHER: "", PATH: process.env["PATH"] ?? "" };
    const report = z.object({ main: z.string(), home: z.string(), launcher: z.string(), args: z.array(z.string()) });
    const installed = Bun.spawnSync(["sh", join(root, "install.sh"), "status", "--x=$(touch ran-arg)"], { cwd: work, env, stdout: "pipe", stderr: "pipe" });
    expect([installed.exitCode, installed.stderr.toString()]).toEqual([0, ""]);
    const command = join(binDir, "agentic-dashboard");
    const expected = { main: join(appHome, "app", "cli", "main.ts"), home: appHome, launcher: command };
    expect(report.parse(JSON.parse(installed.stdout.toString().trim().split("\n").at(-1) ?? ""))).toEqual({ ...expected, args: ["status", "--x=$(touch ran-arg)"] });
    // Run on its own, the command falls back to the folder it was installed with.
    const { AGENTIC_DASHBOARD_HOME: _home, ...bare } = env;
    const run = Bun.spawnSync([command, "help"], { cwd: work, env: bare, stdout: "pipe", stderr: "pipe" });
    expect([run.exitCode, run.stderr.toString()]).toEqual([0, ""]);
    expect(report.parse(JSON.parse(run.stdout.toString()))).toEqual({ ...expected, args: ["help"] });
    expect(readdirSync(work)).toEqual([]);
    expect(mode(command)).toBe("755");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

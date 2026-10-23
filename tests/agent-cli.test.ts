import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const agent = join(import.meta.dir, "..", "scripts", "agent.ts");
const home = mkdtempSync(join(tmpdir(), "agentic-agent-cli-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

// Every case fails before a request, so the address is never contacted.
async function run(args: string[]) {
  const child = Bun.spawn([process.execPath, agent, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe",
    env: { ...process.env, HOME: home, AGENTIC_DASHBOARD_HOME: join(home, ".agentic-dashboard"), DASHBOARD_URL: "http://127.0.0.1:9", DASHBOARD_TOKEN: "test-credential" } });
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code: await child.exited, stdout, stderr };
}

test("a missing option value or unknown option is reported as such, not as a failed save", async () => {
  for (const [args, message] of [[["--get"], "Option '--get <value>' argument missing"], [["--serch", "words"], "Unknown option '--serch'"]] as const) {
    const result = await run([...args]);
    expect([result.code, result.stdout]).toEqual([1, ""]);
    expect(result.stderr).toStartWith(message);
    expect(result.stderr).toContain("--help");
    expect(result.stderr).not.toContain("Save failed");
  }
});

test("invalid input names the options of the command that was run", async () => {
  for (const [args, hint] of [
    [["--trash", "r-1", "--expected-version", "abc"], "the record id, --expected-version"],
    [["--digest-reactions", "--days", "500"], "--days (1-92)"],
    [["--seen", " "], "the comment id"],
    [["--timeline", " "], "the task id"],
  ] as const) {
    const result = await run([...args]);
    expect(result.code).toBe(1);
    expect(result.stderr).toStartWith(`Invalid input: check ${hint} and DASHBOARD_TOKEN.`);
  }
});

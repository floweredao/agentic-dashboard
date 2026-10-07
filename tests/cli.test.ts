import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { en, ko } from "../cli/i18n";
import { formatEnv, parseEnv } from "../cli/paths";
import { renderPlist, renderUnit } from "../cli/service";
import { renderSkill, SKILL_MARKER, SKILL_SOURCE, skillTargets, writeSkill } from "../cli/skills";
import { createApp } from "../server/app";

const main = join(import.meta.dir, "..", "cli", "main.ts");
const mode = (path: string) => (statSync(path).mode & 0o777).toString(8);

test("every CLI message exists in English and Korean with the same placeholders", () => {
  const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
  expect(Object.keys(ko).sort()).toEqual(Object.keys(en).sort());
  for (const key of Object.keys(en) as (keyof typeof en)[]) expect([key, placeholders(ko[key])]).toEqual([key, placeholders(en[key])]);
});

test("server.env values survive a write and read, quotes and spaces included", () => {
  const values = { DATA_DIR: "/Users/a b/data \"x\"", PORT: "4391", APP_ORIGIN: "https://desk.example.com" };
  expect(parseEnv(formatEnv("# header", values))).toEqual(values);
  expect(parseEnv("# note\nPORT=4310\nEMPTY=\nbad line\n")).toEqual({ PORT: "4310", EMPTY: "" });
});

test("the launchd and systemd definitions run `start` with the home folder and escape what needs it", () => {
  const spec = { bun: "/opt/b&n/bun", main: "/app/cli/main.ts", home: "/home/u/<dash>", log: "/home/u/logs/server.log", path: "/usr/bin:/bin" };
  const plist = renderPlist(spec);
  expect(plist).toContain("<string>/opt/b&amp;n/bun</string>");
  expect(plist).toContain("<string>start</string>");
  expect(plist).toContain("<key>AGENTIC_DASHBOARD_HOME</key><string>/home/u/&lt;dash&gt;</string>");
  const unit = renderUnit({ ...spec, home: "/home/u/50%\"q\"" });
  expect(unit).toContain("ExecStart=\"/opt/b&n/bun\" \"/app/cli/main.ts\" start");
  expect(unit).toContain("Environment=\"AGENTIC_DASHBOARD_HOME=/home/u/50%%\\\"q\\\"\"");
});

test("the shipped skill is rewritten for this computer and never replaces a file someone else wrote", () => {
  const rendered = renderSkill(readFileSync(SKILL_SOURCE, "utf8"), { launcher: "/home/u/.local/bin/agentic-dashboard", url: "https://desk.example.com", agent: "laptop" });
  expect(rendered.startsWith("---\nname: agentic-dashboard\n")).toBe(true);
  expect(rendered).toContain(`---\n${SKILL_MARKER}\n`);
  expect(rendered).toContain("connected to https://desk.example.com as the agent `laptop`");
  expect(rendered).toContain("/home/u/.local/bin/agentic-dashboard agent --file record.json");
  expect(rendered).not.toMatch(/(?<!bin\/)agentic-dashboard (agent|connect) /);
  expect(rendered).not.toContain("<!-- connection:");
  const home = mkdtempSync(join(tmpdir(), "agentic-skill-"));
  try {
    const target = skillTargets(home).find(item => item.id === "claude-code");
    if (!target) throw new Error("no claude-code target");
    expect(target.file).toBe(join(home, ".claude", "skills", "agentic-dashboard", "SKILL.md"));
    expect(writeSkill(target, rendered)).toBe("written");
    expect(writeSkill(target, `${rendered}\nupdated`)).toBe("written");
    writeFileSync(target.file, "someone else's skill");
    expect(writeSkill(target, rendered)).toBe("skipped");
    expect(readFileSync(target.file, "utf8")).toBe("someone else's skill");
    expect(writeSkill(target, rendered, true)).toBe("written");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

describeConnect();
function describeConnect() {
  let dir = "";
  let server: ReturnType<typeof Bun.serve> | null = null;
  let app: ReturnType<typeof createApp> | null = null;
  let port = 0;
  const env = (home: string) => ({ ...process.env, HOME: home, AGENTIC_DASHBOARD_HOME: join(home, ".agentic-dashboard"), AGENTIC_DASHBOARD_LANG: "en",
    AGENTIC_DASHBOARD_LAUNCHER: "", DASHBOARD_URL: "", DASHBOARD_TOKEN: "", CODEX_HOME: "" });
  const cli = async (home: string, args: string[], stdin?: string) => {
    const child = Bun.spawn([process.execPath, main, ...args], { env: env(home), stdin: stdin === undefined ? "ignore" : new Blob([stdin]), stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code: await child.exited, stdout, stderr };
  };
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "agentic-cli-"));
    const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    port = probe.port;
    probe.stop(true);
    const host = join(dir, "host", ".agentic-dashboard");
    mkdirSync(host, { recursive: true });
    writeFileSync(join(host, "server.env"), formatEnv("# test", { PORT: String(port), DATA_DIR: join(host, "data") }));
    app = createApp({ databasePath: join(host, "data", "dashboard.sqlite"), credentialsPath: join(host, "data", "credentials.json"), port });
    server = Bun.serve({ hostname: "127.0.0.1", port, fetch: app.fetch });
  });
  afterAll(() => { server?.stop(true); app?.close(); rmSync(dir, { recursive: true, force: true }); });

  test("invite on the host and connect on another computer: the key lands in a private file, the skill is installed and records save", async () => {
    const host = join(dir, "host");
    const issued = await cli(host, ["invite", "laptop"]);
    expect([issued.code, issued.stderr]).toEqual([0, ""]);
    const code = /code for the agent "laptop": (\S+)/.exec(issued.stdout)?.[1] ?? "";
    expect(code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/);
    expect(issued.stdout).toContain(`sh -s -- connect --url http://127.0.0.1:${port} --code ${code}`);

    const laptop = join(dir, "laptop");
    mkdirSync(join(laptop, ".claude"), { recursive: true });
    const connected = await cli(laptop, ["connect", "--url", `127.0.0.1:${port}`, "--code", code, "--key-store", "file"]);
    expect([connected.code, connected.stderr]).toEqual([0, ""]);
    const home = join(laptop, ".agentic-dashboard");
    expect(z.object({ url: z.string(), agent: z.string(), keyStore: z.string() }).parse(JSON.parse(readFileSync(join(home, "client.json"), "utf8"))))
      .toMatchObject({ url: `http://127.0.0.1:${port}`, agent: "laptop", keyStore: "file" });
    expect([mode(home), mode(join(home, "client.json")), mode(join(home, "agent-key"))]).toEqual(["700", "600", "600"]);
    expect(connected.stdout).not.toContain(readFileSync(join(home, "agent-key"), "utf8").trim());
    const skill = readFileSync(join(laptop, ".claude", "skills", "agentic-dashboard", "SKILL.md"), "utf8");
    expect(skill).toContain(`connected to http://127.0.0.1:${port} as the agent \`laptop\``);
    expect(existsSync(join(laptop, ".codex"))).toBe(false);

    writeFileSync(join(dir, "record.json"), JSON.stringify({ kind: "note", title: "Install check", body: "Saved from the CLI test", tags: ["install"] }));
    const saved = await cli(laptop, ["agent", "--file", join(dir, "record.json"), "--request-id", "cli-test-1"]);
    expect([saved.code, saved.stderr]).toEqual([0, ""]);
    const found = await cli(laptop, ["agent", "--search", "Install check"]);
    expect(z.object({ items: z.array(z.object({ title: z.string() })) }).parse(JSON.parse(found.stdout)).items.map(item => item.title)).toEqual(["Install check"]);

    const again = await cli(join(dir, "other"), ["connect", "--url", `http://127.0.0.1:${port}`, "--code", code, "--key-store", "file"]);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain("unknown, already used or expired");
    const status = await cli(laptop, ["status"]);
    expect(status.stdout).toContain("as \"laptop\"");
    expect(status.stdout).toContain(": working");
  });

  test("connect with an agent name and a key on stdin, and a refused key changes nothing", async () => {
    const key = app?.agents.add("desk-agent") ?? "";
    const desk = join(dir, "desk");
    const refused = await cli(desk, ["connect", "--url", `http://127.0.0.1:${port}`, "--agent", "desk-agent", "--key-stdin", "--key-store", "file"], "wrong-key");
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("HTTP 401");
    expect(existsSync(join(desk, ".agentic-dashboard", "client.json"))).toBe(false);
    const ok = await cli(desk, ["connect", "--url", `http://127.0.0.1:${port}`, "--agent", "desk-agent", "--key-stdin", "--key-store", "file", "--skills", "agents"], `${key}\n`);
    expect([ok.code, ok.stderr]).toEqual([0, ""]);
    expect(existsSync(join(desk, ".agents", "skills", "agentic-dashboard", "SKILL.md"))).toBe(true);
  });

  test("without a terminal the first run neither prompts nor hangs, and setup asks for --yes", async () => {
    const fresh = join(dir, "fresh");
    const first = await cli(fresh, []);
    expect([first.code, first.stdout.includes("isn't set up on this computer yet")]).toEqual([0, true]);
    const setup = await cli(fresh, ["setup"]);
    expect([setup.code, setup.stderr.includes("--yes")]).toEqual([1, true]);
    expect(existsSync(join(fresh, ".agentic-dashboard", "server.env"))).toBe(false);
  });
}

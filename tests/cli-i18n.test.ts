import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectLang, en, ko } from "../cli/i18n";

const main = join(import.meta.dir, "..", "cli", "main.ts");
const home = mkdtempSync(join(tmpdir(), "agentic-cli-i18n-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

test("Korean is chosen for a ko language tag only, and English otherwise or when nothing is set", () => {
  for (const value of ["ko", "ko_KR.UTF-8", "ko-KR", "KO_KR.utf8", "ko_KR@euro"]) expect([value, detectLang({ LANG: value })]).toEqual([value, "ko"]);
  // Konkani (kok_IN) and other languages starting with "ko" are not Korean.
  for (const value of ["kok_IN.UTF-8", "kok", "kos_FM", "en_US.UTF-8", "C", "POSIX", ""]) expect([value, detectLang({ LANG: value })]).toEqual([value, "en"]);
  expect(detectLang({})).toBe("en");
  expect(detectLang({ AGENTIC_DASHBOARD_LANG: "en", LANG: "ko_KR.UTF-8" })).toBe("en");
  expect(detectLang({ LC_ALL: "C", LANG: "ko_KR.UTF-8" })).toBe("en");
  expect(detectLang({ LC_MESSAGES: "ko_KR.UTF-8", LANG: "en_US.UTF-8" })).toBe("ko");
});

async function cli(lang: string, args: string[]) {
  const child = Bun.spawn([process.execPath, main, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe",
    env: { ...process.env, HOME: home, AGENTIC_DASHBOARD_HOME: join(home, ".agentic-dashboard"), AGENTIC_DASHBOARD_LANG: lang } });
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code: await child.exited, stdout, stderr };
}

test("--help and a wrong --key-store answer in the chosen language", async () => {
  for (const [lang, messages] of [["en", en], ["ko", ko]] as const) {
    const help = await cli(lang, ["--help"]);
    expect([help.code, help.stdout.trim(), help.stderr]).toEqual([0, messages.help, ""]);
    // Fails before any network call: the value is checked first.
    const store = await cli(lang, ["connect", "--url", "http://127.0.0.1:9", "--key-store", "vault"]);
    expect([store.code, store.stderr.trim()]).toEqual([1, messages.connectKeyStoreInvalid]);
  }
});

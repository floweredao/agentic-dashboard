import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const root = new URL("../", import.meta.url).pathname;
const env = `PROJECT_ID=example-project
BILLING_ACCOUNT=000000-000000-000000
BUCKET=example-dashboard
TURSO_DB=example-dashboard
TURSO_GROUP=default
OWNER_ALERT_EMAIL=owner@example.com
CONTACT_EMAIL=contact@example.com
`;

async function invoke(args: readonly string[]) {
  const proc = Bun.spawn([process.execPath, `${root}scripts/hosted/main.ts`, ...args], {
    env: { ...process.env, PATH: "" }, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}
test("CLI refuses execution when the confirmation flag is absent", async () => {
  // Given no confirmation and even an invalid config path.
  const args = ["bootstrap", "--env-file", "/nonexistent/deploy.env"];
  // When the executable entrypoint is invoked.
  const result = await invoke(args);
  // Then it stops before config access or any cloud operation.
  expect(result.code).toBe(2);
  expect(result.stderr).toContain("--dry-run | --yes");
});

test.each(["bootstrap", "deploy", "secret"])("CLI %s dry run needs no cloud executables", async operation => {
  // Given a private config and PATH without gcloud or turso.
  const directory = await mkdtemp(join(tmpdir(), "hosted-cli-"));
  directories.push(directory);
  const path = join(directory, "deploy.env");
  await writeFile(path, env, { mode: 0o600 });
  // When the actual CLI renders the plan.
  const result = await invoke([operation, "--env-file", path, "--dry-run"]);
  // Then the commands are printed successfully despite no cloud CLIs being available.
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("'gcloud'");
  expect(result.stdout).toContain("'turso'");
});

test("CLI refuses a shared-readable configuration when asked for a dry run", async () => {
  // Given a config readable by other users.
  const directory = await mkdtemp(join(tmpdir(), "hosted-cli-"));
  directories.push(directory);
  const path = join(directory, "deploy.env");
  await writeFile(path, env, { mode: 0o600 });
  await chmod(path, 0o644);
  // When a dry run reads it.
  const result = await invoke(["bootstrap", "--env-file", path, "--dry-run"]);
  // Then the boundary refuses unsafe permissions.
  expect(result.code).toBe(2);
  expect(result.stdout).toBe("");
});

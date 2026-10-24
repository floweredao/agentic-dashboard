import { expect, test } from "bun:test";
import { parseConfig } from "../server/config";
import { parseDeployment } from "../scripts/hosted/config";
import { prepareSecrets, retainedVersions, secretDryRun, updateSecrets } from "../scripts/hosted/secrets";
import type { Command } from "../scripts/hosted/commands";

const config = () => parseDeployment({
  PROJECT_ID: "example-project", BILLING_ACCOUNT: "000000-000000-000000", BUCKET: "example-dashboard",
  TURSO_DB: "example-dashboard", TURSO_GROUP: "default",
  OWNER_ALERT_EMAIL: "owner@example.com", CONTACT_EMAIL: "contact@example.com",
});
const prompt = async (field: string) => field.startsWith("google.") ? crypto.randomUUID() : "";

test("secret creation generates server-compatible keys when no version exists", async () => {
  // Given no persisted encryption, session or VAPID keys.
  const current = { kek: {} };
  const authToken = crypto.randomUUID();
  // When secret preparation runs with hidden-field answers.
  const secrets = await prepareSecrets(current, prompt, async () => authToken);
  // Then the production parser accepts the secret, including Turso authentication.
  const parsed = parseConfig({ AUTH_MODE: "google", APP_ORIGIN: "https://example.com", APP_SECRETS: JSON.stringify(secrets) });
  expect(parsed.databaseToken).toBe(authToken);
  expect(Buffer.from(secrets.kek["1"] ?? "", "base64")).toHaveLength(32);
  expect(secrets.sessionSigningKey?.length).toBeGreaterThanOrEqual(32);
  expect(secrets.vapid?.publicKey.length).toBeGreaterThan(32);
});

test("secret editing preserves encryption and push keys when answers are empty", async () => {
  // Given an existing valid secret and an unusable token-creation callback.
  const current = await prepareSecrets({ kek: {} }, prompt, async () => crypto.randomUUID());
  // When the operator keeps each existing value.
  const next = await prepareSecrets(current, async () => "", async () => { throw new Error("must not create another token"); });
  // Then already issued sessions, ciphertexts and push subscriptions remain usable.
  expect(next).toEqual(current);
});

test("secret rotation destroys only older versions after a successful upload", async () => {
  // Given an existing secret and four versions returned after upload.
  const current = await prepareSecrets({ kek: {} }, prompt, async () => crypto.randomUUID());
  const calls: Command[] = [];
  let listings = 0;
  const versions = (ids: readonly number[]) => JSON.stringify(ids.map(id => ({
    name: `projects/example/secrets/config/versions/${id}`, state: "ENABLED",
  })));
  // When the real rotation workflow adds a new version.
  await updateSecrets(config(), async command => {
    calls.push(command);
    if (command.args.includes("list")) return versions(++listings === 1 ? [3, 2, 1] : [3, 1, 4, 2]);
    if (command.args.includes("access")) return JSON.stringify(current);
    return "";
  }, async () => "");
  // Then payload is sent over stdin and only versions 1 and 2 are destroyed.
  expect(calls.find(call => call.args.includes("add"))?.input).toBe(JSON.stringify(current));
  expect(calls.filter(call => call.args.includes("destroy")).map(call => call.args[4])).toEqual(["2", "1"]);
});

test("failed secret upload preserves older versions when transport rejects", async () => {
  // Given a valid existing secret and a failing upload transport.
  const current = await prepareSecrets({ kek: {} }, prompt, async () => crypto.randomUUID());
  const calls: Command[] = [];
  // When adding the version fails.
  const result = updateSecrets(config(), async command => {
    calls.push(command);
    if (command.args.includes("list")) return JSON.stringify([{ name: "projects/example/secrets/config/versions/1", state: "ENABLED" }]);
    if (command.args.includes("access")) return JSON.stringify(current);
    throw new Error("upload refused");
  }, async () => "");
  // Then the failure propagates and no version is destroyed.
  await expect(result).rejects.toThrow("upload refused");
  expect(calls.some(call => call.args.includes("destroy"))).toBe(false);
});

test("version selection sorts numeric IDs when the API response is unordered", () => {
  // Given lexical ordering would select version 9 before 10.
  const input = [9, 10, 2].map(id => ({ name: `projects/example/secrets/config/versions/${id}`, state: "ENABLED" }));
  // When retained candidates are selected.
  const versions = retainedVersions(input);
  // Then rotation preserves the numeric newest versions.
  expect(versions.map(version => version.name.split("/").at(-1))).toEqual(["10", "9", "2"]);
});

test("secret dry runs describe stdin uploads without materializing credentials", () => {
  // Given only deployment metadata.
  const c = config();
  // When secret commands are rendered without reading or generating secrets.
  const text = secretDryRun(c);
  // Then only a redacted stdin marker accompanies the upload.
  const upload = text.split("\n").find(line => line.includes("'--data-file=-'"));
  expect(upload?.endsWith(" < [REDACTED stdin]")).toBe(true);
  expect(text).not.toContain("sessionSigningKey");
});

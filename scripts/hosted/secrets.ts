import { emitKeypressEvents } from "node:readline";
import type { Key } from "node:readline";
import webpush from "web-push";
import { z } from "zod";
import { secretsSchema } from "../../server/config";
import { cloud } from "./plans";
import { DeploymentError } from "./config";
import type { Deployment } from "./config";
import type { Transport } from "./commands";
import { renderPlan } from "./commands";

type Secrets = z.infer<typeof secretsSchema>;
export type SecretPrompt = (field: string) => Promise<string>;
const versionsSchema = z.array(z.object({ name: z.string().regex(/\/versions\/\d+$/), state: z.string() }));
export function retainedVersions(input: unknown) {
  return versionsSchema.parse(input).filter(item => item.state !== "DESTROYED")
    .sort((a, b) => Number(BigInt(b.name.split("/").at(-1) ?? "0") - BigInt(a.name.split("/").at(-1) ?? "0")));
}
export async function prepareSecrets(current: Secrets, prompt: SecretPrompt, token: () => Promise<string>): Promise<Secrets> {
  const google = {
    clientId: await prompt("google.clientId (Enter keeps existing)") || current.google?.clientId,
    clientSecret: await prompt("google.clientSecret (Enter keeps existing)") || current.google?.clientSecret,
  };
  const platformToken = await prompt("turso.platformToken (optional; Enter keeps existing)") || current.turso?.platformToken;
  const org = await prompt("turso.org (required with platform token)") || current.turso?.org;
  const apiKey = await prompt("resend.apiKey (optional; Enter keeps existing)") || current.resend?.apiKey;
  if (platformToken && !org) throw new DeploymentError("Turso usage monitoring requires turso.org");
  const value = {
    ...current,
    kek: Object.keys(current.kek).length ? current.kek : { "1": Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64") },
    sessionSigningKey: current.sessionSigningKey ?? Buffer.from(crypto.getRandomValues(new Uint8Array(48))).toString("base64url"),
    vapid: current.vapid ?? webpush.generateVAPIDKeys(), google,
    turso: { ...current.turso, authToken: current.turso?.authToken ?? await token(),
      ...(platformToken ? { platformToken } : {}), ...(org ? { org } : {}) },
    ...(apiKey ? { resend: { apiKey } } : {}),
  };
  return secretsSchema.parse(value);
}
export function secretDryRun(c: Deployment): string {
  return renderPlan([
    { kind: "command", command: cloud(c, "secrets", "versions", "list", c.SECRET, "--format=json") },
    { kind: "command", command: cloud(c, "secrets", "versions", "access", "@LATEST_ENABLED@", `--secret=${c.SECRET}`) },
    { kind: "command", command: { args: ["turso", "db", "tokens", "create", c.TURSO_DB] } },
    { kind: "command", command: { ...cloud(c, "secrets", "versions", "add", c.SECRET, "--data-file=-"), input: "[REDACTED]" } },
    { kind: "command", command: cloud(c, "secrets", "versions", "list", c.SECRET, "--format=json") },
    { kind: "command", command: cloud(c, "secrets", "versions", "destroy", "@OLDER_VERSION@", `--secret=${c.SECRET}`) },
  ]).replace("'turso' 'db' 'tokens'", "# only if no existing database token:\n 'turso' 'db' 'tokens'")
    + "\n# Secret reads and token stdout are captured, never printed. Destroy only versions older than the newest two.\n";
}
export async function updateSecrets(c: Deployment, transport: Transport, prompt: SecretPrompt) {
  const list = () => transport(cloud(c, "secrets", "versions", "list", c.SECRET, "--format=json"));
  const versions = retainedVersions(JSON.parse(await list()));
  const latest = versions.find(item => item.state === "ENABLED");
  const current = latest ? secretsSchema.parse(JSON.parse(await transport(
    cloud(c, "secrets", "versions", "access", latest.name.split("/").at(-1) ?? "", `--secret=${c.SECRET}`),
  ))) : { kek: {} };
  const secrets = await prepareSecrets(current, prompt, async () => {
    const value = (await transport({ args: ["turso", "db", "tokens", "create", c.TURSO_DB] })).trim();
    if (!value || /\s/.test(value)) throw new DeploymentError("Turso did not return a single database token");
    return value;
  });
  await transport({ ...cloud(c, "secrets", "versions", "add", c.SECRET, "--data-file=-"), input: JSON.stringify(secrets) });
  const after = retainedVersions(JSON.parse(await list()));
  for (const old of after.slice(2)) {
    await transport(cloud(c, "secrets", "versions", "destroy", old.name.split("/").at(-1) ?? "", `--secret=${c.SECRET}`));
  }
}
export async function hiddenPrompt(field: string): Promise<string> {
  if (!process.stdin.isTTY) throw new DeploymentError("Secret setup requires an interactive terminal");
  process.stderr.write(`${field}: `);
  emitKeypressEvents(process.stdin);
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  try {
    return await new Promise<string>((resolve, reject) => {
      let value = "";
      const done = (error?: DeploymentError) => {
        process.stdin.removeListener("keypress", listener);
        process.stderr.write("\n");
        if (error) reject(error); else resolve(value);
      };
      const listener = (text: string | undefined, key: Key) => {
        if (key.ctrl && (key.name === "c" || key.name === "d")) return done(new DeploymentError("Secret setup cancelled"));
        if (key.name === "return") return done();
        if (key.name === "backspace") value = value.slice(0, -1);
        else if (text && !key.ctrl && !key.meta && !/[\u0000-\u001f\u007f]/.test(text)) value += text;
      };
      process.stdin.on("keypress", listener);
    });
  } finally {
    process.stdin.setRawMode(wasRaw);
    process.stdin.pause();
  }
}

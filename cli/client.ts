import { existsSync, readFileSync, rmSync } from "node:fs";
import { z } from "zod";
import { t } from "./i18n";
import { ensureHome, launcher, paths, type Paths, writePrivate } from "./paths";
import { ask, askSecret, confirm, interactive, say } from "./prompt";
import { renderSkill, SKILL_SOURCE, skillTargets, writeSkill } from "./skills";

const KEYCHAIN_SERVICE = "agentic-dashboard";
const ClientSchema = z.object({
  url: z.url(), agent: z.string().min(1), keyStore: z.enum(["keychain", "file"]), connectedAt: z.string(),
}).strict();
export type ClientConfig = z.infer<typeof ClientSchema>;
export type KeyStore = ClientConfig["keyStore"];

export class CliError extends Error {}

export const readClient = (p: Paths): ClientConfig | null =>
  existsSync(p.client) ? ClientSchema.parse(JSON.parse(readFileSync(p.client, "utf8"))) : null;
const keychainItem = (config: Pick<ClientConfig, "agent" | "url">) => ({ service: KEYCHAIN_SERVICE, name: `${config.agent}@${config.url}` });

export async function loadKey(p: Paths, config: ClientConfig): Promise<string | null> {
  if (config.keyStore === "file") return existsSync(p.keyFile) ? readFileSync(p.keyFile, "utf8").trim() || null : null;
  return await Bun.secrets.get(keychainItem(config));
}

async function deleteKey(p: Paths, config: ClientConfig) {
  if (config.keyStore === "file") rmSync(p.keyFile, { force: true });
  else await Bun.secrets.delete(keychainItem(config)).catch(() => false);
}

/** The connection `agentic-dashboard connect` stored on this computer, or null; `agent.ts` uses it when no key is given. */
export async function storedConnection(env: NodeJS.ProcessEnv = process.env) {
  const p = paths(env);
  const config = readClient(p);
  if (!config) return null;
  const token = await loadKey(p, config);
  return token ? { url: config.url, agent: config.agent, token } : null;
}

export function normalizeUrl(value: string) {
  const text = value.trim();
  const url = new URL(/^https?:\/\//i.test(text) ? text : `http://${text}`);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new CliError(t("setupOriginInvalid"));
  return url.origin;
}

const detail = (error: unknown) => error instanceof Error ? error.message : String(error);
async function request(url: string, init: RequestInit = {}) {
  return await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
}

async function probe(url: string) {
  const response = await request(`${url}/api/v1/config`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return z.object({ appName: z.string(), version: z.string() }).passthrough().parse(await response.json());
}

export async function checkKey(url: string, key: string) {
  return (await request(`${url}/api/v1/records?limit=1`, { headers: { Authorization: `Bearer ${key}` } })).status;
}

async function storeKey(p: Paths, config: Omit<ClientConfig, "keyStore" | "connectedAt">, key: string, wanted: KeyStore | undefined): Promise<KeyStore> {
  if (wanted !== "file") {
    try {
      await Bun.secrets.set({ ...keychainItem(config), value: key });
      rmSync(p.keyFile, { force: true });
      say(t("connectKeychain"));
      return "keychain";
    } catch (error) {
      if (wanted === "keychain") throw new CliError(t("connectKeychainFailed", { detail: detail(error) }));
      say(t("connectKeychainFailed", { detail: detail(error) }));
    }
  }
  writePrivate(p.keyFile, `${key}\n`);
  say(t("connectKeyFile", { path: p.keyFile }));
  return "file";
}

export interface ConnectFlags {
  readonly url?: string | undefined;
  readonly code?: string | undefined;
  readonly agent?: string | undefined;
  readonly keyStdin?: boolean | undefined;
  readonly keyStore?: KeyStore | undefined;
  readonly skills?: string | undefined;
  readonly yes?: boolean | undefined;
}

export async function connect(p: Paths, flags: ConnectFlags) {
  const prompting = interactive() && !flags.yes;
  const current = readClient(p);
  if (current && prompting && !flags.url && !flags.code && !await confirm(t("connectAlready", { url: current.url, agent: current.agent }), false)) return;
  let url = "";
  let found: { appName: string; version: string } | null = null;
  while (!found) {
    const raw = flags.url ?? (prompting ? await ask(t("connectUrl"), current?.url ?? "http://127.0.0.1:4310") : current?.url);
    if (!raw) throw new CliError(t("connectNeedUrl"));
    try {
      url = normalizeUrl(raw);
      found = await probe(url);
    } catch (error) {
      const message = t("connectUnreachable", { url: raw, detail: detail(error) });
      if (!prompting || flags.url) throw new CliError(message);
      say(message);
    }
  }
  say(t("connectFound", { name: found.appName, version: found.version, url }));

  let agent = "";
  let key = "";
  for (;;) {
    const code = flags.code ?? (prompting && !flags.agent ? await ask(t("connectCode")) : "");
    if (code) {
      const response = await request(`${url}/api/v1/agents/connect`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }),
      });
      if (response.status === 201) {
        ({ agent, key } = z.object({ agent: z.string(), key: z.string() }).parse(await response.json()));
        break;
      }
      const message = response.status === 404 ? t("connectBadCode")
        : z.object({ error: z.object({ message: z.string() }) }).safeParse(await response.json().catch(() => null)).data?.error.message ?? `HTTP ${response.status}`;
      if (!prompting || flags.code) throw new CliError(message);
      say(message);
      continue;
    }
    agent = flags.agent ?? (prompting ? await ask(t("connectAgent")) : "");
    key = flags.keyStdin ? (await Bun.stdin.text()).trim() : prompting ? await askSecret(t("connectKey")) : "";
    if (!agent || !key) throw new CliError(t("connectNeedKey"));
    break;
  }
  const status = await checkKey(url, key);
  if (status !== 200) throw new CliError(t("connectBadKey", { status }));
  say(t("connectConnected", { agent }));

  ensureHome(p);
  if (current && (current.url !== url || current.agent !== agent)) await deleteKey(p, current);
  const keyStore = await storeKey(p, { url, agent }, key, flags.keyStore);
  writePrivate(p.client, `${JSON.stringify({ url, agent, keyStore, connectedAt: new Date().toISOString() } satisfies ClientConfig, null, 2)}\n`);
  await installSkills(p, { url, agent }, flags.skills ?? (prompting ? undefined : "detected"), prompting);
  say(t("connectDone", { command: `${launcher()} agent --search ""` }));
}

/**
 * `choice`: "detected" (every tool found here), "none", a comma list of target ids (written even when the tool isn't found),
 * or undefined to ask about the detected ones.
 */
export async function installSkills(p: Paths, connection: { url: string; agent: string }, choice: string | undefined, prompting: boolean, force = false) {
  if (choice === "none") return;
  const all = skillTargets(p.userHome);
  let targets = all.filter(target => existsSync(target.root));
  if (choice && choice !== "detected") {
    const ids = choice.split(",").map(id => id.trim()).filter(Boolean);
    const unknown = ids.find(id => !all.some(target => target.id === id));
    if (unknown) throw new CliError(t("skillsUnknownTarget", { target: unknown }));
    targets = all.filter(target => ids.includes(target.id));
  }
  if (targets.length === 0) { say(t("skillsNone")); return; }
  if (prompting && choice === undefined && !await confirm(t("skillsAsk", { list: targets.map(target => target.label).join(", ") }), true)) return;
  const content = renderSkill(readFileSync(SKILL_SOURCE, "utf8"), { launcher: launcher(), ...connection });
  for (const target of targets) {
    say(writeSkill(target, content, force) === "written"
      ? t("skillsInstalled", { label: target.label, path: target.file })
      : t("skillsSkipped", { path: target.file }));
  }
}

export async function clientStatus(p: Paths) {
  const config = readClient(p);
  if (!config) return t("statusNoClient");
  const key = await loadKey(p, config).catch(() => null);
  let state = t("stateNoKey");
  if (key) {
    const status = await checkKey(config.url, key).catch(() => null);
    state = status === 200 ? t("stateWorking") : status === null ? t("stateUnreachable") : t("stateRefused", { status });
  }
  return t("statusClient", { url: config.url, agent: config.agent, store: config.keyStore === "file" ? p.keyFile : t("storeKeychain"), state });
}

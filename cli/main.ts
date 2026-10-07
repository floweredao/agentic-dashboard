#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ZodError } from "zod";
import packageJson from "../package.json" with { type: "json" };
import { ApiError } from "../server/errors";
import { clientStatus, CliError, connect, installSkills, readClient } from "./client";
import { t } from "./i18n";
import { APP_ROOT, paths } from "./paths";
import { choose, interactive, say } from "./prompt";
import { installService, restartService, SERVICE_LABEL, serviceState, uninstallService } from "./service";
import { invite, loadServerEnv, ownerKey, serverStatus, setup, start } from "./server";

const p = paths();
const [command, ...rest] = Bun.argv.slice(2);

async function setupThenMaybeStart(args: string[] = rest) {
  const { values } = parseArgs({ args, allowPositionals: true, options: {
    yes: { type: "boolean", short: "y" }, port: { type: "string" }, "data-dir": { type: "string" }, origin: { type: "string" },
    service: { type: "boolean" }, "no-service": { type: "boolean" },
  } });
  const service = values["no-service"] ? false : values.service ? true : undefined;
  if (await setup(p, { yes: values.yes, port: values.port, dataDir: values["data-dir"], origin: values.origin, service })) await start(p);
}

async function connectCommand() {
  const { values } = parseArgs({ args: rest, allowPositionals: true, options: {
    url: { type: "string" }, code: { type: "string" }, agent: { type: "string" }, "key-stdin": { type: "boolean" },
    "key-store": { type: "string" }, skills: { type: "string" }, yes: { type: "boolean", short: "y" },
  } });
  const keyStore = values["key-store"];
  if (keyStore !== undefined && keyStore !== "keychain" && keyStore !== "file") throw new CliError("--key-store is keychain or file");
  await connect(p, { url: str(values.url), code: str(values.code), agent: str(values.agent), keyStdin: values["key-stdin"] === true,
    keyStore, skills: str(values.skills), yes: values.yes === true });
}
const str = (value: unknown) => typeof value === "string" ? value : undefined;

async function firstRun() {
  const server = existsSync(p.serverEnv);
  const client = readClient(p);
  if (command !== "onboard" && server) {
    if (serviceState(p) === "running") { say(t("alreadyRunning", { url: loadServerEnv(p).url })); return; }
    await start(p);
    return;
  }
  if (command !== "onboard" && client) { say(await clientStatus(p)); return; }
  if (!interactive()) { say(t("notSetUp")); return; }
  const choice = await choose(t("onboardTitle"), [t("onboardHost"), t("onboardConnect")], server || !client ? 0 : 1);
  if (choice === 0) await setupThenMaybeStart([]);
  else await connect(p, {});
}

async function main() {
  switch (command) {
    case undefined:
    case "onboard":
      return await firstRun();
    case "setup":
      return await setupThenMaybeStart();
    case "start":
      return await start(p);
    case "service": {
      const action = rest[0];
      if (action === "install") say(t("setupServiceInstalled", { path: installService(p), log: join(p.logs, "server.log") }));
      else if (action === "uninstall") { uninstallService(p); say(t("serviceRemoved")); }
      else if (action === "restart") { restartService(); say(t("serviceRestarted")); }
      else if (action === "status") {
        const state = serviceState(p);
        say(t("serviceState", { label: SERVICE_LABEL, state: t(state === "running" ? "stateRunning" : state === "stopped" ? "stateStopped"
          : state === "not-installed" ? "stateNotInstalled" : "stateUnsupported") }));
      } else { say(t("serviceUsage")); process.exitCode = 1; }
      return;
    }
    case "invite":
      return invite(p, rest[0]);
    case "agents":
      loadServerEnv(p);
      await import("../scripts/agents");
      return;
    case "owner-key":
      return ownerKey(p);
    case "connect":
      return await connectCommand();
    case "agent": {
      const child = Bun.spawn([process.execPath, join(APP_ROOT, "scripts", "agent.ts"), ...rest], { stdio: ["inherit", "inherit", "inherit"] });
      process.exitCode = await child.exited;
      return;
    }
    case "skills": {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { target: { type: "string" }, force: { type: "boolean" } } });
      const client = readClient(p);
      if (positionals[0] !== "install") { say(t("help")); process.exitCode = 1; return; }
      if (!client) throw new CliError(t("skillsNeedConnect"));
      await installSkills(p, client, str(values.target) ?? "detected", false, values.force === true);
      return;
    }
    case "status":
      say(serverStatus(p));
      say(await clientStatus(p));
      return;
    case "help":
    case "--help":
    case "-h":
      say(t("help"));
      return;
    case "--version":
    case "version":
      say(packageJson.version);
      return;
    default:
      say(t("unknownCommand", { command }));
      process.exitCode = 1;
  }
}

try {
  await main();
} catch (error) {
  if (error instanceof CliError || error instanceof ApiError) console.error(error.message);
  else if (error instanceof ZodError) console.error(error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("\n"));
  else if (error instanceof Error && error.message === "unsupported") console.error(t("setupServiceUnsupported"));
  else if (error instanceof TypeError && "code" in error && String(error.code).startsWith("ERR_PARSE_ARGS")) console.error(`${error.message}\n${t("help")}`);
  else throw error;
  process.exitCode = 1;
}

import { createApp } from "./app";
import { parseConfig } from "./config";
import { appOptions } from "./config-app";
import { ApiError } from "./errors";

const config = (() => {
  try { return parseConfig(process.env); }
  catch (error) {
    if (!(error instanceof ApiError)) throw error;
    console.error(error.message);
    process.exit(1);
  }
})();
const app = await createApp(appOptions(config));
if (config.mcpListener && config.MCP_AGENT) {
  const agent = await app.agents.get(config.MCP_AGENT);
  if (!agent || agent.revokedAt !== null) {
    console.error("Invalid configuration: MCP_AGENT must name an active registered agent.");
    await app.close();
    process.exit(1);
  }
}
const privateServer = Bun.serve({ hostname: config.HOST, port: config.PORT, fetch: app.fetch });
const publicServer = config.agentIngress
  ? Bun.serve({ hostname: "127.0.0.1", port: config.AGENT_PORT, fetch: app.publicFetch }) : null;
const mcpServer = config.mcpListener ? Bun.serve({ hostname: "127.0.0.1", port: config.MCP_PORT, fetch: app.mcpFetch }) : null;
console.log([
  `${config.APP_NAME} listening on http://${config.HOST}:${privateServer.port}`,
  `authentication ${config.AUTH_MODE}`,
  `agent ingress ${publicServer ? `127.0.0.1:${publicServer.port}` : "disabled"}`,
  `mcp ${config.hosted ? "/mcp (bearer)" : mcpServer ? `127.0.0.1:${mcpServer.port} (bearer)` : "disabled"}`,
  ...(config.DEMO ? ["read-only demo"] : []),
  `time zone ${config.TIME_ZONE}`,
].join("; "));
const narrationRetryTimer = config.TASKS_QUEUE ? undefined : setInterval(() => app.retryDeferred(), 30 * 60 * 1000);
const purgeTimer = config.TASKS_QUEUE ? undefined : setInterval(() => app.purgeTrash(), 60 * 60 * 1000);
const maintenanceTimer = config.TASKS_QUEUE ? undefined : setInterval(() => {
  void app.maintenance().catch((error: unknown) => {
    console.error(`maintenance failed: ${error instanceof Error ? error.name : "unknown"}`);
  });
}, 24 * 60 * 60 * 1000);
async function stop() {
  clearInterval(purgeTimer);
  clearInterval(narrationRetryTimer);
  clearInterval(maintenanceTimer);
  privateServer.stop(true);
  publicServer?.stop(true);
  mcpServer?.stop(true);
  await app.close();
  process.exit(0);
}
process.once("SIGTERM", stop);
process.once("SIGINT", stop);

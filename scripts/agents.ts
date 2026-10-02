import { join } from "node:path";
import { ZodError } from "zod";
import { Agents } from "../server/agents";
import { ApiError } from "../server/errors";
import { Store } from "../server/store";

const usage = `Manage the agents that may write to this dashboard.

  bun run agents add <name>      register an agent and print its key once
  bun run agents list            list agents, when each was added and last used
  bun run agents rotate <name>   issue a new key (the old one stops working); also reactivates a removed agent
  bun run agents remove <name>   revoke an agent's key; its records stay

Names use lowercase letters, digits and dashes and start with a letter, for example codex, claude-code or research-bot.
Uses DATABASE_PATH, or DATA_DIR/dashboard.sqlite (default data/dashboard.sqlite), the same database as the server.`;

const [command, name] = Bun.argv.slice(2);
const databasePath = process.env["DATABASE_PATH"] ?? join(process.env["DATA_DIR"] ?? "data", "dashboard.sqlite");
const store = new Store(databasePath, Date.now);
const agents = new Agents(store);
const issued = (verb: string, agent: string, key: string) => console.log(
  `${verb} agent "${agent}". Its key is shown only now; store it where the agent reads it, for example:\n\n` +
  `  export DASHBOARD_TOKEN='${key}'\n\nThe dashboard keeps only a hash of it. Lost it? Run: bun run agents rotate ${agent}`);
try {
  if (command === "add" && name) issued("Added", name, agents.add(name));
  else if (command === "rotate" && name) issued("Rotated the key of", name, agents.rotate(name));
  else if (command === "remove" && name) { agents.revoke(name); console.log(`Removed agent "${name}": its key no longer works. Its records stay.`); }
  else if (command === "list") {
    const items = agents.list();
    if (!items.length) console.log("No agents yet. Add one with: bun run agents add <name>");
    for (const agent of items) {
      const state = agent.revokedAt ? `removed ${agent.revokedAt}` : `last used ${agent.lastUsedAt ?? "never"}`;
      console.log(`${agent.name.padEnd(24)} added ${agent.createdAt ?? "unknown"}  ${state}`);
    }
  } else {
    console.log(usage);
    process.exitCode = command === undefined || command === "help" || command === "--help" ? 0 : 1;
  }
} catch (error) {
  if (error instanceof ApiError) console.error(error.message);
  else if (error instanceof ZodError) console.error(`Invalid agent name: ${error.issues.map(issue => issue.message).join("; ")}`);
  else throw error;
  process.exitCode = 1;
} finally {
  store.close();
}

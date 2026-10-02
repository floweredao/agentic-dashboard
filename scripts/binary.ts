import { join } from "node:path";
import { ensureCredentials, readCredentials } from "../server/auth";

const command = Bun.argv[2];
if (command === "agents") await import("./agents");
else if (command === "owner-key") {
  const path = process.env["CREDENTIALS_PATH"] ?? join(process.env["DATA_DIR"] ?? "data", "credentials.json");
  const created = ensureCredentials(path);
  console.log(`${created ? "Created" : "Kept"} ${path}\nOwner key: ${readCredentials(path).owner}`);
} else if (command === undefined || command === "serve") await import("../server/index");
else {
  console.log("Usage: agentic-dashboard [serve] | agentic-dashboard owner-key | agentic-dashboard agents <add|list|rotate|remove> [name]");
  process.exitCode = command === "help" || command === "--help" ? 0 : 1;
}

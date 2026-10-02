import { join } from "node:path";
import { ensureCredentials, readCredentials } from "../server/auth";

const dataDir = process.env["DATA_DIR"] ?? "data";
const credentialsPath = process.env["CREDENTIALS_PATH"] ?? join(dataDir, "credentials.json");
const created = ensureCredentials(credentialsPath);
const port = process.env["PORT"] ?? "4310";
const origin = process.env["APP_ORIGIN"] ?? `http://127.0.0.1:${port}`;

console.log("Building the web app...");
const build = Bun.spawnSync(["bun", "x", "vite", "build", "--logLevel", "warn"], { stdout: "inherit", stderr: "inherit" });
if (build.exitCode !== 0) {
  console.error("The web app build failed; fix the error above and run bun run setup again.");
  process.exit(1);
}
console.log(`
${created ? "Created" : "Kept"} the owner key in ${credentialsPath} (readable only by you).

Owner key: ${readCredentials(credentialsPath).owner}

Next:
  1. bun start                      start the dashboard
  2. open ${origin} and sign in with the owner key above
  3. bun run agents add <name>      give each agent its own key

Keep the owner key private: it can read and delete everything. Agents get their own keys.`);

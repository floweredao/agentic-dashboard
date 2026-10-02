import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";

if (!existsSync("dist/index.html")) {
  console.error("dist/ is missing; run bun run build first (bun run build:binary does both).");
  process.exit(1);
}
rmSync("release", { recursive: true, force: true });
mkdirSync("release");
const target = process.env["BUN_TARGET"];
const build = Bun.spawnSync(["bun", "build", "scripts/binary.ts", "--compile", "--minify", "--outfile", "release/agentic-dashboard",
  ...(target ? [`--target=${target}`] : [])], { stdout: "inherit", stderr: "inherit" });
if (build.exitCode !== 0) process.exit(build.exitCode ?? 1);
cpSync("dist", "release/dist", { recursive: true });
cpSync(".env.example", "release/.env.example");
console.log("Built release/agentic-dashboard and release/dist. Run it from release/: ./agentic-dashboard owner-key, then ./agentic-dashboard");

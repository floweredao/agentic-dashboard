import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { DeploymentError, loadDeployment } from "./config";
import { bootstrapPlan, deploymentPlan } from "./plans";
import { executePlan, renderPlan, runCommand } from "./commands";
import { hiddenPrompt, secretDryRun, updateSecrets } from "./secrets";

const usage = "Usage: bootstrap-gcp.sh|deploy-cloud-run.sh|set-secret.ts --env-file <private deploy.env> [--dry-run | --yes]";
async function main(operation: string, args: readonly string[]) {
  const { values } = parseArgs({ args: [...args], options: {
    "env-file": { type: "string" }, "dry-run": { type: "boolean" }, yes: { type: "boolean" },
  }, strict: true, allowPositionals: false });
  if (!values["env-file"] || (!values["dry-run"] && !values.yes)) throw new DeploymentError(usage);
  if (values["dry-run"] && values.yes) throw new DeploymentError("Choose --dry-run or --yes, not both");
  const config = await loadDeployment(resolve(values["env-file"]));
  process.chdir(fileURLToPath(new URL("../../", import.meta.url)));
  if (operation === "secret") {
    if (values["dry-run"]) console.log(secretDryRun(config));
    else await updateSecrets(config, runCommand, hiddenPrompt);
    return;
  }
  if (operation !== "bootstrap" && operation !== "deploy") throw new DeploymentError(usage);
  const plan = operation === "bootstrap" ? bootstrapPlan(config) : deploymentPlan(config);
  if (values["dry-run"]) console.log(renderPlan(plan));
  else await executePlan(plan, runCommand);
}
export async function runCli(operation: string, args: readonly string[]) {
  // CLI boundary: do not include unknown error messages or validation values in output.
  try { await main(operation, args); }
  catch (error) {
    console.error(error instanceof DeploymentError ? error.message : "Deployment failed; details withheld to protect credentials");
    process.exitCode = 2;
  }
}
if (import.meta.main) await runCli(process.argv[2] ?? "", process.argv.slice(3));

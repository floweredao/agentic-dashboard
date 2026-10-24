import { expect, test } from "bun:test";
import { parseDeployment } from "../scripts/hosted/config";
import { bootstrapPlan, deploymentPlan, schedulerPlan } from "../scripts/hosted/plans";
import { executePlan, renderPlan } from "../scripts/hosted/commands";

const fixture = {
  PROJECT_ID: "example-project", BILLING_ACCOUNT: "000000-000000-000000",
  BUCKET: "example-dashboard", TURSO_DB: "example-dashboard", TURSO_GROUP: "default",
  APP_ORIGIN: "https://dashboard.example.com", OWNER_ALERT_EMAIL: "owner@example.com",
  CONTACT_EMAIL: "contact@example.com", DATABASE_URL: "libsql://database.example.com",
};

test("deployment limits CPU and instances when building hosted commands", () => {
  // Given a validated hosted configuration.
  const config = parseDeployment(fixture);
  // When the deployment plan is built.
  const commands = deploymentPlan(config).flatMap(step => step.kind === "command" ? [step.command] : []);
  // Then Cloud Build pushes the image and Cloud Run uses request-only CPU with bounded capacity.
  expect(commands[0]?.args).toContain("builds");
  expect(commands[0]?.args).toContain("--tag=us-central1-docker.pkg.dev/example-project/dashboard/dashboard:latest");
  expect(commands[1]?.args).toEqual(expect.arrayContaining([
    "--min-instances=0", "--max-instances=2", "--cpu=1", "--memory=512Mi",
    "--concurrency=40", "--timeout=900", "--cpu-throttling", "--no-cpu-boost",
    "--set-secrets=APP_SECRETS=dash-web-config:latest",
  ]));
});

test("provisioning scopes runtime privileges when resources are built", () => {
  // Given a dedicated runtime identity.
  const config = parseDeployment(fixture);
  // When the provisioning plan is rendered.
  const text = renderPlan(bootstrapPlan(config));
  // Then storage, secrets and queue grants are resource-scoped, not project-wide admin grants.
  expect(text).toContain("'storage' 'buckets' 'add-iam-policy-binding' 'gs://example-dashboard'");
  expect(text).toContain("'secrets' 'add-iam-policy-binding' 'dash-web-config'");
  expect(text).toContain("'tasks' 'queues' 'add-iam-policy-binding' 'dashboard'");
  expect(text).not.toContain("roles/editor");
  expect(text).not.toContain("roles/owner");
});

test("scheduler uses operations contract when building maintenance target", () => {
  // Given an explicit public origin.
  const config = parseDeployment(fixture);
  // When the scheduler plan is built.
  const text = renderPlan(schedulerPlan(config));
  // Then the correct OIDC audience, identity and daily time are sent.
  expect(text).toContain("--uri=https://dashboard.example.com/internal/tasks/maintenance");
  expect(text).toContain("--oidc-token-audience=https://dashboard.example.com");
  expect(text).toContain("--oidc-service-account-email=dashboard@example-project.iam.gserviceaccount.com");
  expect(text).toContain("--schedule=0 4 * * *");
  expect(text).toContain("--time-zone=Asia/Seoul");
});

test("provisioning keeps existing resources when discovery finds them", async () => {
  // Given every resource already exists and a fake command transport.
  const calls: string[][] = [];
  const plan = bootstrapPlan(parseDeployment(fixture));
  // When the real plan executor reconciles existing resources.
  await executePlan(plan, async command => {
    calls.push([...command.args]);
    if (command.args.includes("--format=value(projectNumber)")) return "123456789";
    return command.args[0] === "turso" ? `${fixture.TURSO_DB}\tdefault\n`
      : command.args.some(arg => arg.startsWith("--format=")) ? "existing-resource\n" : "";
  });
  // Then ensure steps do not issue duplicate creates, but queue settings are reconciled.
  expect(calls.filter(args => args.includes("create"))).toHaveLength(0);
  expect(calls.some(args => args.includes("update") && args.includes("--max-attempts=3"))).toBe(true);
});

test("provisioning propagates discovery failure instead of treating it as absence", async () => {
  // Given a failing cloud permission probe.
  const failure = new Error("permission denied");
  // When discovery fails, then provisioning stops without creating resources.
  await expect(executePlan(bootstrapPlan(parseDeployment(fixture)), async () => { throw failure; })).rejects.toBe(failure);
});

test("configuration refuses unsafe locations and executable env values", () => {
  // Given unsupported locations and unknown credentials.
  const inputs = [{ ...fixture, REGION: "europe-west1" }, { ...fixture, APP_SECRETS: "private" },
    { ...fixture, PROJECT_ID: "$(touch /tmp/unwanted)" }];
  // When the config boundary parses them, then all are rejected.
  for (const input of inputs) expect(() => parseDeployment(input)).toThrow();
});

test("first deployment uses discovered database and origin in downstream commands", async () => {
  // Given empty optional URLs as in a fresh config file.
  const config = parseDeployment({ ...fixture, APP_ORIGIN: "", DATABASE_URL: "" });
  const calls: string[][] = [];
  // When cloud discovery supplies the actual database and service URLs.
  await executePlan(deploymentPlan(config), async command => {
    calls.push([...command.args]);
    if (command.args[0] === "turso") return "libsql://actual.example.com";
    if (command.args.includes("--format=value(status.url)")) return "https://actual.example.com";
    return "";
  });
  // Then the discovered values bind both the application revision and maintenance OIDC target.
  expect(calls.find(args => args.includes("deploy"))?.find(arg => arg.startsWith("--set-env-vars=")))
    .toContain("DATABASE_URL=libsql://actual.example.com");
  expect(calls.find(args => args.includes("--update-env-vars=APP_ORIGIN=https://actual.example.com"))).toBeDefined();
  expect(calls.find(args => args.includes("scheduler") && args.includes("create")))
    .toEqual(expect.arrayContaining(["--uri=https://actual.example.com/internal/tasks/maintenance",
      "--oidc-token-audience=https://actual.example.com"]));
});

test("budget commands filter only this project when creating missing budgets", async () => {
  // Given an empty project and billing inventory.
  const calls: string[][] = [];
  // When provisioning receives the numeric project identifier.
  await executePlan(bootstrapPlan(parseDeployment(fixture)), async command => {
    calls.push([...command.args]);
    return command.args.includes("--format=value(projectNumber)") ? "123456789" : "";
  });
  // Then both actual-spend thresholds use this project, with distinct dollar limits.
  const budgets = calls.filter(args => args.includes("budgets") && args.includes("create"));
  expect(budgets.map(args => args.find(arg => arg.startsWith("--budget-amount=")))).toEqual(["--budget-amount=1USD", "--budget-amount=5USD"]);
  for (const args of budgets) expect(args).toEqual(expect.arrayContaining([
    "--filter-projects=projects/123456789", "--threshold-rule=percent=1,basis=current-spend",
  ]));
});

test("rendering redacts secret stdin when a command has a payload", () => {
  // Given a generated payload that must never appear in a command transcript.
  const payload = crypto.randomUUID();
  // When a command with stdin is rendered.
  const text = renderPlan([{ kind: "command", command: { args: ["gcloud", "secrets", "versions", "add"], input: payload } }]);
  // Then the transcript retains argv but omits the payload.
  expect(text).toContain("'gcloud' 'secrets' 'versions' 'add'");
  expect(text).not.toContain(payload);
});

import type { Deployment } from "./config";
import { buildAccount, runtimeAccount } from "./config";
import type { Command, Step } from "./commands";

export function cloud(config: Deployment, ...args: readonly string[]): Command {
  return { args: ["gcloud", ...args, `--project=${config.PROJECT_ID}`, "--quiet"] };
}
export function bootstrapPlan(c: Deployment): readonly Step[] {
  const g = (...args: readonly string[]) => cloud(c, ...args);
  const run = (...args: readonly string[]): Step => ({ kind: "command", command: g(...args) });
  const runtime = runtimeAccount(c), builder = buildAccount(c);
  const ensure = (probe: Command, create: Command): Step => ({ kind: "ensure", probe, create });
  const bind = (role: string, member: string) => [`--role=${role}`, `--member=serviceAccount:${member}`];
  const bucket = `gs://${c.BUCKET}`, sources = `${bucket}-build`;
  return [
    run("services", "enable", ...["run", "cloudbuild", "artifactregistry", "secretmanager", "cloudtasks",
      "cloudscheduler", "iamcredentials", "iam", "storage", "logging", "cloudresourcemanager", "billingbudgets"].map(api => `${api}.googleapis.com`)),
    { kind: "command", command: g("projects", "describe", c.PROJECT_ID, "--format=value(projectNumber)"), capture: "PROJECT_NUMBER" },
    ...[c.SA, `${c.SA}-build`].map(id => ensure(
      g("iam", "service-accounts", "list", `--filter=email=${id}@${c.PROJECT_ID}.iam.gserviceaccount.com`, "--format=value(email)"),
      g("iam", "service-accounts", "create", id))),
    ensure(g("artifacts", "repositories", "list", `--location=${c.REGION}`, `--filter=name~'/repositories/${c.REPOSITORY}$'`, "--format=value(name)"),
      g("artifacts", "repositories", "create", c.REPOSITORY, `--location=${c.REGION}`, "--repository-format=docker")),
    run("artifacts", "repositories", "set-cleanup-policies", c.REPOSITORY, `--location=${c.REGION}`,
      "--policy=scripts/hosted/registry-policy.json", "--no-dry-run"),
    run("artifacts", "repositories", "add-iam-policy-binding", c.REPOSITORY, `--location=${c.REGION}`,
      ...bind("roles/artifactregistry.writer", builder)),
    run("projects", "add-iam-policy-binding", c.PROJECT_ID, ...bind("roles/logging.logWriter", builder), "--condition=None"),
    ensure(g("secrets", "list", `--filter=name~'/secrets/${c.SECRET}$'`, "--format=value(name)"),
      g("secrets", "create", c.SECRET, "--replication-policy=automatic")),
    run("secrets", "add-iam-policy-binding", c.SECRET, ...bind("roles/secretmanager.secretAccessor", runtime)),
    ...[bucket, sources].flatMap(uri => [
      ensure(g("storage", "buckets", "list", `--filter=name=${uri.slice(5)}`, "--format=value(name)"),
        g("storage", "buckets", "create", uri, `--location=${c.REGION}`, "--uniform-bucket-level-access", "--public-access-prevention")),
      run("storage", "buckets", "update", uri, "--uniform-bucket-level-access", "--public-access-prevention",
        `--lifecycle-file=scripts/hosted/${uri === bucket ? "bucket" : "build-bucket"}-policy.json`),
      run("storage", "buckets", "add-iam-policy-binding", uri, ...bind("roles/storage.objectAdmin", uri === bucket ? runtime : builder)),
    ]),
    { kind: "ensure", probe: g("tasks", "queues", "list", `--location=${c.REGION}`, `--filter=name~'/queues/${c.QUEUE}$'`, "--format=value(name)"),
      create: g("tasks", "queues", "create", c.QUEUE, `--location=${c.REGION}`, "--max-attempts=3"),
      update: g("tasks", "queues", "update", c.QUEUE, `--location=${c.REGION}`, "--max-attempts=3") },
    run("tasks", "queues", "add-iam-policy-binding", c.QUEUE, `--location=${c.REGION}`, ...bind("roles/cloudtasks.enqueuer", runtime)),
    // Enqueuing an OIDC task requires actAs as well as createTask.
    run("iam", "service-accounts", "add-iam-policy-binding", runtime, ...bind("roles/iam.serviceAccountUser", runtime)),
    run("iam", "service-accounts", "add-iam-policy-binding", runtime, ...bind("roles/iam.serviceAccountTokenCreator", runtime)),
    ...[1, 5].map(amount => ({
      kind: "ensure", probe: g("billing", "budgets", "list", `--billing-account=${c.BILLING_ACCOUNT}`,
        `--filter=displayName=${c.SERVICE}-${c.PROJECT_ID}-${amount}usd`, "--format=value(name)"),
      create: g("billing", "budgets", "create", `--billing-account=${c.BILLING_ACCOUNT}`,
        `--display-name=${c.SERVICE}-${c.PROJECT_ID}-${amount}usd`, `--budget-amount=${amount}USD`,
        "--filter-projects=projects/@PROJECT_NUMBER@", "--threshold-rule=percent=1,basis=current-spend"),
      update: g("billing", "budgets", "update", "@EXISTING@", `--billing-account=${c.BILLING_ACCOUNT}`,
        `--budget-amount=${amount}USD`, "--filter-projects=projects/@PROJECT_NUMBER@", "--threshold-rule=percent=1,basis=current-spend"),
    } satisfies Step)),
    { kind: "ensure", probe: { args: ["turso", "db", "list", "--group", c.TURSO_GROUP] }, match: c.TURSO_DB,
      create: { args: ["turso", "db", "create", c.TURSO_DB, "--group", c.TURSO_GROUP, "--wait"] } },
  ];
}
export function deploymentPlan(c: Deployment): readonly Step[] {
  const image = `${c.REGION}-docker.pkg.dev/${c.PROJECT_ID}/${c.REPOSITORY}/${c.SERVICE}:latest`;
  const env = {
    AUTH_MODE: "google", HOST: "0.0.0.0", APP_ORIGIN: c.APP_ORIGIN ?? "https://bootstrap.invalid",
    DATABASE_URL: c.DATABASE_URL ?? "@DATABASE_URL@", AUDIO_BUCKET: c.BUCKET,
    TASKS_QUEUE: `projects/${c.PROJECT_ID}/locations/${c.REGION}/queues/${c.QUEUE}`,
    TASKS_SERVICE_ACCOUNT: runtimeAccount(c), OWNER_ALERT_EMAIL: c.OWNER_ALERT_EMAIL, CONTACT_EMAIL: c.CONTACT_EMAIL,
    ...(c.DATABASE_REGION ? { DATABASE_REGION: c.DATABASE_REGION } : {}),
    ...(c.DEMO_HOSTED_URL ? { DEMO_HOSTED_URL: c.DEMO_HOSTED_URL } : {}),
    AUTH_TRUST_PROXY: c.AUTH_TRUST_PROXY, TRUSTED_PROXY_HOPS: String(c.TRUSTED_PROXY_HOPS),
    AUTH_START_LIMIT: String(c.AUTH_START_LIMIT), PENDING_SIGN_IN_LIMIT: String(c.PENDING_SIGN_IN_LIMIT),
    MAX_USERS: String(c.MAX_USERS), NARRATION_DAILY_LIMIT: String(c.NARRATION_DAILY_LIMIT),
    NARRATION_GLOBAL_DAILY_LIMIT: String(c.NARRATION_GLOBAL_DAILY_LIMIT), OWNER_USER_LIMITS: JSON.stringify(c.OWNER_USER_LIMITS),
    AUDIO_DIR: "/tmp/audio", DATA_DIR: "/tmp/dashboard", NARRATION_RECORD_AUTO: "off", NARRATION_DIGEST_AUTO: "off",
  };
  return [
    ...(c.DATABASE_URL ? [] : [{ kind: "command", command: { args: ["turso", "db", "show", c.TURSO_DB, "--url"] }, capture: "DATABASE_URL" } satisfies Step]),
    { kind: "command", command: cloud(c, "builds", "submit", ".", `--region=${c.REGION}`, `--tag=${image}`,
      `--service-account=projects/${c.PROJECT_ID}/serviceAccounts/${buildAccount(c)}`,
      `--gcs-source-staging-dir=gs://${c.BUCKET}-build/source`, `--gcs-log-dir=gs://${c.BUCKET}-build/logs`,
      "--ignore-file=scripts/hosted/build.ignore") },
    { kind: "command", command: cloud(c, "run", "deploy", c.SERVICE, `--region=${c.REGION}`, `--image=${image}`,
      "--min-instances=0", "--max-instances=2", "--cpu=1", "--memory=512Mi", "--concurrency=40", "--timeout=900",
      "--cpu-throttling", "--no-cpu-boost", "--allow-unauthenticated", `--service-account=${runtimeAccount(c)}`,
      `--set-secrets=APP_SECRETS=${c.SECRET}:latest`, `--set-env-vars=^|^${Object.entries(env).map(([key, value]) => `${key}=${value}`).join("|")}`) },
    ...(!c.APP_ORIGIN ? [
      { kind: "command", command: cloud(c, "run", "services", "describe", c.SERVICE, `--region=${c.REGION}`, "--format=value(status.url)"), capture: "APP_ORIGIN" } satisfies Step,
      { kind: "command", command: cloud(c, "run", "services", "update", c.SERVICE, `--region=${c.REGION}`, "--update-env-vars=APP_ORIGIN=@APP_ORIGIN@") } satisfies Step,
    ] : []),
    { kind: "command", command: cloud(c, "run", "services", "add-iam-policy-binding", c.SERVICE, `--region=${c.REGION}`,
      `--member=serviceAccount:${runtimeAccount(c)}`, "--role=roles/run.invoker") },
    ...schedulerPlan(c),
  ];
}
export function schedulerPlan(c: Deployment): readonly Step[] {
  const origin = c.APP_ORIGIN ?? "@APP_ORIGIN@";
  const args = [`--location=${c.REGION}`, "--schedule=0 4 * * *", "--time-zone=Asia/Seoul", "--http-method=POST",
    `--uri=${origin}/internal/tasks/maintenance`, `--oidc-token-audience=${origin}`,
    `--oidc-service-account-email=${runtimeAccount(c)}`, "--attempt-deadline=900s"];
  return [{
    kind: "ensure", probe: cloud(c, "scheduler", "jobs", "list", `--location=${c.REGION}`,
      "--filter=name~'/jobs/dash-web-maintenance$'", "--format=value(name)"),
    create: cloud(c, "scheduler", "jobs", "create", "http", "dash-web-maintenance", ...args),
    update: cloud(c, "scheduler", "jobs", "update", "http", "dash-web-maintenance", ...args),
  }];
}

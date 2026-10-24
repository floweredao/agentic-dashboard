import { parseEnv } from "node:util";
import { stat } from "node:fs/promises";
import { z } from "zod";

export class DeploymentError extends Error {
  constructor(readonly detail: string) { super(detail); this.name = "DeploymentError"; }
}
const name = z.string().regex(/^[a-z][a-z0-9-]*[a-z0-9]$/);
const httpsUrl = z.url().refine(value => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password && !value.includes("|");
});
const origin = httpsUrl.refine(value => {
  const url = new URL(value);
  return url.protocol === "https:" && url.pathname === "/" && !url.search && !url.hash && !url.username && !url.password;
}).transform(value => new URL(value).origin);
const database = z.url().refine(value => {
  const url = new URL(value);
  return ["libsql:", "https:"].includes(url.protocol) && ["", "/"].includes(url.pathname) && !url.username && !url.password && !url.search && !url.hash;
});
const optional = (value: unknown) => value === "" ? undefined : value;
const captures = { PROJECT_NUMBER: z.string().regex(/^\d+$/), APP_ORIGIN: origin, DATABASE_URL: database } as const;
export type Capture = keyof typeof captures;
export function parseCaptured(key: Capture, value: string): string {
  const parsed = captures[key].safeParse(value);
  if (!parsed.success) throw new DeploymentError(`Invalid command output: ${key}`);
  return parsed.data;
}
const schema = z.object({
  PROJECT_ID: name.min(6).max(30), REGION: z.literal("us-central1").default("us-central1"),
  SERVICE: name.max(49).default("dashboard"), SA: name.min(6).max(24).default("dashboard"),
  REPOSITORY: name.default("dashboard"), SECRET: name.default("dash-web-config"),
  BUCKET: z.string().regex(/^[a-z0-9][a-z0-9-]{1,49}[a-z0-9]$/),
  QUEUE: name.default("dashboard"), BILLING_ACCOUNT: z.string().regex(/^[A-Fa-f0-9]{6}-[A-Fa-f0-9]{6}-[A-Fa-f0-9]{6}$/),
  TURSO_DB: name, TURSO_GROUP: name,
  DATABASE_URL: z.preprocess(optional, database.optional()),
  APP_ORIGIN: z.preprocess(optional, origin.optional()), OWNER_ALERT_EMAIL: z.email(), CONTACT_EMAIL: z.email(),
  DATABASE_REGION: z.preprocess(optional, z.string().trim().min(1).regex(/^[^|\r\n]+$/).optional()),
  DEMO_HOSTED_URL: z.preprocess(optional, httpsUrl.optional()),
  AUTH_TRUST_PROXY: z.enum(["on", "off", "true", "false"]).default("on"),
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).default(1),
  AUTH_START_LIMIT: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).default(900),
  PENDING_SIGN_IN_LIMIT: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).default(10000),
  MAX_USERS: z.coerce.number().int().min(0).default(50),
  NARRATION_DAILY_LIMIT: z.coerce.number().int().min(0).max(200).default(10),
  NARRATION_GLOBAL_DAILY_LIMIT: z.coerce.number().int().min(0).default(60),
  OWNER_USER_LIMITS: z.string().transform((value): unknown => JSON.parse(value))
    .pipe(z.record(z.string().regex(/^[A-Za-z0-9_-]+$/), z.number().int().min(0).max(200))).prefault("{}"),
}).strict().refine(value => value.PENDING_SIGN_IN_LIMIT > value.AUTH_START_LIMIT * 10, {
  path: ["PENDING_SIGN_IN_LIMIT"], message: "Must exceed ten minutes of admitted starts",
});
export type Deployment = z.infer<typeof schema>;

export function parseDeployment(input: unknown): Deployment {
  try {
    const result = schema.safeParse(input);
    if (!result.success) throw new DeploymentError(`Invalid deployment fields: ${result.error.issues.map(issue => issue.path.join(".")).join(", ")}`);
    return result.data;
  } catch (error) {
    if (error instanceof SyntaxError) throw new DeploymentError("OWNER_USER_LIMITS must be JSON");
    throw error;
  }
}
export async function loadDeployment(path: string) {
  const info = await stat(path);
  if (!info.isFile() || (info.mode & 0o077) !== 0) throw new DeploymentError("Deployment config must be a private file (chmod 600)");
  return parseDeployment(parseEnv(await Bun.file(path).text()));
}
export const runtimeAccount = (config: Deployment) => `${config.SA}@${config.PROJECT_ID}.iam.gserviceaccount.com`;
export const buildAccount = (config: Deployment) => `${config.SA}-build@${config.PROJECT_ID}.iam.gserviceaccount.com`;

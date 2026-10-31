import { z } from "zod";
import { ApiError } from "./errors";
import { createJwks } from "./oidc-jwks";
import type { CloudClient } from "./cloud-client";

export const JobKindSchema = z.enum(["narration", "ai-fill"]);
export type JobKind = z.infer<typeof JobKindSchema>;
export const JobPayloadSchema = z.object({ userId: z.string().min(1).max(100), id: z.string().min(1).max(100),
  revision: z.string().min(1).max(100) }).strict();
export type JobPayload = z.infer<typeof JobPayloadSchema>;
export interface Jobs {
  enqueue(kind: JobKind, payload: JobPayload): Promise<void>;
  idle(): Promise<void>;
}
export function localJobs(run: (kind: JobKind, payload: JobPayload) => Promise<void>): Jobs {
  const pending = new Set<Promise<void>>();
  const errors: unknown[] = [];
  return {
    async enqueue(kind, payload) {
      const work = Promise.resolve().then(() => run(kind, payload)).catch((error: unknown) => { errors.push(error); })
        .finally(() => pending.delete(work));
      pending.add(work);
    },
    async idle() {
      while (pending.size) await Promise.all(pending);
      const error = errors.shift();
      if (error !== undefined) throw error;
    },
  };
}
export interface TasksOptions {
  readonly queue: string;
  readonly serviceAccount: string;
  readonly jwks?: string;
  readonly issuers?: readonly string[];
}
export function cloudJobs(options: TasksOptions & { readonly origin: string; readonly client: CloudClient }): Jobs {
  return {
    async enqueue(kind, payload) {
      const id = new Bun.CryptoHasher("sha256").update(JSON.stringify([kind, payload])).digest("hex");
      const response = await options.client.request(`${options.client.tasksOrigin}/v2/${options.queue}/tasks`, {
        method: "POST", throwHttpErrors: false, json: { task: {
          name: `${options.queue}/tasks/${id}`, dispatchDeadline: "900s",
          httpRequest: { httpMethod: "POST", url: `${options.origin}/internal/tasks/${kind}`,
            headers: { "Content-Type": "application/json" }, body: Buffer.from(JSON.stringify(payload)).toString("base64"),
            oidcToken: { serviceAccountEmail: options.serviceAccount, audience: options.origin } },
        } },
      });
      if (!response.ok && response.status !== 409) throw new ApiError(503, "task_enqueue", "Background work could not be queued");
    },
    async idle() {},
  };
}
export function taskVerifier(options: Pick<TasksOptions, "serviceAccount" | "jwks" | "issuers"> & {
  readonly origin: string; readonly now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const verify = createJwks(options.jwks ?? "https://www.googleapis.com/oauth2/v3/certs", now);
  const claims = z.object({ iss: z.string(), aud: z.string(), exp: z.number(), iat: z.number(),
    email: z.email(), email_verified: z.literal(true), sub: z.string().min(1) });
  return async (request: Request) => {
    const token = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
    if (!token) throw new ApiError(401, "task_unauthenticated", "Service account authentication required");
    try {
      const identity = claims.parse(await verify(token));
      if (!(options.issuers ?? ["https://accounts.google.com", "accounts.google.com"]).includes(identity.iss) ||
        identity.aud !== options.origin || identity.email !== options.serviceAccount ||
        identity.exp <= now() / 1000 || identity.iat > now() / 1000 + 60) {
        throw new ApiError(401, "task_unauthenticated", "Service account authentication required");
      }
    } catch (error) {
      if (error instanceof Error) throw new ApiError(401, "task_unauthenticated", "Service account authentication required");
      throw error;
    }
  };
}

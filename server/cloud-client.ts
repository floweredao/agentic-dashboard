import ky, { type Options } from "ky";
import { z } from "zod";

export interface CloudOptions {
  readonly accessToken?: () => Promise<string>;
  readonly account?: () => Promise<string>;
  readonly storageOrigin?: string;
  readonly iamOrigin?: string;
  readonly tasksOrigin?: string;
}

/** Metadata credentials stay in memory; callers never log request headers or bodies. */
export function cloudClient(options: CloudOptions = {}) {
  const metadata = ky.create({ prefixUrl: "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/",
    headers: { "Metadata-Flavor": "Google" }, timeout: 10000, retry: 0 });
  let cached: { token: string; until: number } | null = null;
  const accessToken = options.accessToken ?? (async () => {
    if (cached && cached.until > Date.now()) return cached.token;
    const result = z.object({ access_token: z.string(), expires_in: z.number().positive() }).parse(await metadata.get("token").json());
    cached = { token: result.access_token, until: Date.now() + Math.max(0, result.expires_in - 60) * 1000 };
    return result.access_token;
  });
  return {
    storageOrigin: options.storageOrigin ?? "https://storage.googleapis.com",
    iamOrigin: options.iamOrigin ?? "https://iamcredentials.googleapis.com",
    tasksOrigin: options.tasksOrigin ?? "https://cloudtasks.googleapis.com",
    account: options.account ?? (() => metadata.get("email").text()),
    async request(url: string, init: Options = {}) {
      const token = await accessToken();
      return ky(url, { timeout: 60000, retry: 0, ...init,
        hooks: { beforeRequest: [request => { request.headers.set("Authorization", `Bearer ${token}`); }] } });
    },
  };
}
export type CloudClient = ReturnType<typeof cloudClient>;

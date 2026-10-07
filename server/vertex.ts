import { homedir } from "node:os";
import { z } from "zod";
import { ProviderError } from "./narration";

/** Gemini 3.8 TTS on Vertex AI serves only the `global` location (https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/text-to-speech/overview). */
export const VERTEX_LOCATION = "global";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
/** Refresh this long before Google's stated expiry, so a long job never sends a token that dies mid-request. */
const EARLY_MS = 5 * 60 * 1000;

/** Application Default Credentials: whether the file is there (free, no network) and a fresh access token. */
export interface AdcSource {
  exists(): Promise<boolean>;
  token(signal: AbortSignal): Promise<string>;
}
type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/** `GOOGLE_APPLICATION_CREDENTIALS`, else the file `gcloud auth application-default login` writes. */
export function defaultAdcPath(env: Record<string, string | undefined> = process.env): string {
  return env.GOOGLE_APPLICATION_CREDENTIALS || `${env.HOME || homedir()}/.config/gcloud/application_default_credentials.json`;
}

const userSchema = z.object({
  type: z.literal("authorized_user"), client_id: z.string().min(1), client_secret: z.string().min(1), refresh_token: z.string().min(1),
});
const tokenSchema = z.object({ access_token: z.string().min(1), expires_in: z.number().positive() });

/**
 * A user's ADC login (`authorized_user`): the refresh token is exchanged for an access token, cached until shortly before it
 * expires. A missing, unreadable or other kind of file, or a refused refresh (revoked or expired login), is `vertex_auth`.
 * Neither the file's contents nor the tokens ever go into errors or logs.
 */
export function adcCredentials(options: { readonly path?: string; readonly fetch?: Fetch; readonly now?: () => number } = {}): AdcSource {
  const path = options.path ?? defaultAdcPath();
  const send = options.fetch ?? ((input: string, init: RequestInit) => fetch(input, init));
  const now = options.now ?? Date.now;
  let cached: { readonly token: string; readonly until: number } | null = null;
  return {
    exists: () => Bun.file(path).exists(),
    async token(signal) {
      if (cached && now() < cached.until) return cached.token;
      let user: z.infer<typeof userSchema>;
      try { user = userSchema.parse(JSON.parse(await Bun.file(path).text())); }
      catch (error) {
        if (error instanceof Error) throw new ProviderError("vertex_auth", false);
        throw error;
      }
      let response: Response;
      try {
        response = await send(TOKEN_URL, { method: "POST", signal, headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "refresh_token", client_id: user.client_id, client_secret: user.client_secret,
            refresh_token: user.refresh_token }).toString() });
      } catch (error) {
        if (signal.aborted) throw new ProviderError("timeout", true);
        if (error instanceof Error) throw new ProviderError("network", true);
        throw error;
      }
      if (response.status >= 500) throw new ProviderError(`http_${response.status}`, true);
      const parsed = response.ok ? tokenSchema.safeParse(await response.json().catch(() => null)) : null;
      if (!parsed?.success) throw new ProviderError("vertex_auth", false);
      cached = { token: parsed.data.access_token, until: now() + parsed.data.expires_in * 1000 - EARLY_MS };
      return cached.token;
    },
  };
}

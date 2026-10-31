import ky from "ky";
import { z } from "zod";
import { AccountSchema } from "../shared/account";
import { clearRecordCache } from "./record-feed";

const schema = z.object({ csrfToken: z.string(), expiresAt: z.string(), account: AccountSchema.optional() });
export type Session = z.infer<typeof schema>;
let primed: Session | null = null;
export const primeSession = (value: Session | null) => { primed = value; clearRecordCache(); };
export async function fetchSession(token?: string) {
  const options = { credentials: "same-origin" as const, retry: 0, timeout: 15000 };
  const response = token === undefined ? ky.get("/api/v1/auth/session", options)
    : ky.post("/api/v1/auth/session", { ...options, json: { token } });
  return schema.parse(await response.json());
}
/** The entry gate hands its already-verified session to the dashboard once, avoiding a serial duplicate request. */
export async function session(token?: string) {
  if (token === undefined && primed) { const value = primed; primed = null; return value; }
  return fetchSession(token);
}

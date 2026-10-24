import ky from "ky";
import { config } from "./config";
import { disablePush } from "./push";
import { primeSession } from "./session-data";
import { clearRateLimit } from "./rate-limit";

export async function logout(csrfToken: string) {
  const headers = { "X-CSRF-Token": csrfToken };
  if (config.features.push) await disablePush(csrfToken);
  if (config.authMode === "google") {
    await ky.post("/auth/logout", { headers, credentials: "same-origin", retry: 0, timeout: 10000 });
  } else {
    await ky.delete("/api/v1/auth/session", { headers, credentials: "same-origin", retry: 0, timeout: 10000 });
  }
  primeSession(null);
  clearRateLimit();
  if (typeof window !== "undefined") window.dispatchEvent(new Event("agentic:signed-out"));
}

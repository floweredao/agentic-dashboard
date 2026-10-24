import ky from "ky";
import { config } from "./config";
import { disablePush } from "./push";

export async function logout(csrfToken: string) {
  const headers = { "X-CSRF-Token": csrfToken };
  if (config.features.push) await disablePush(csrfToken);
  if (config.authMode === "google") {
    await ky.post("/auth/logout", { headers, credentials: "same-origin", retry: 0, timeout: 10000 });
    return;
  }
  await ky.delete("/api/v1/auth/session", { headers, credentials: "same-origin", retry: 0, timeout: 10000 });
}

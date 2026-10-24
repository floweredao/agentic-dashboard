import { expect, test } from "bun:test";
import ky from "ky";
import { accountErrorMessage } from "./account-errors";
import { errorMessage } from "./api-errors";
import { applyLocale, getLocale } from "./i18n";
import { clearRateLimit, rateLimited } from "./rate-limit";

test.each([
  ["account_export_busy", 429], ["account_export_too_large", 413], ["account_export_unavailable", 503],
] as const)("%s has bilingual recovery without blocking unrelated actions", async (code, status) => {
  const previous = getLocale();
  const server = Bun.serve({ port: 0, fetch: () => Response.json({ error: { code, message: "Server detail" } },
    { status, headers: { "X-RateLimit-Scope": "export", "Retry-After": "60" } }) });
  try {
    for (const locale of ["en", "ko"] as const) {
      clearRateLimit();
      applyLocale(locale);
      let message: string | undefined;
      try { await ky.get(server.url, { retry: 0 }); }
      catch (error) { message = await errorMessage(error); }
      expect(accountErrorMessage(code)).toBeDefined();
      expect(message).toBe(accountErrorMessage(code));
      expect(rateLimited()).toBe(false);
    }
  } finally { server.stop(true); clearRateLimit(); applyLocale(previous); }
});

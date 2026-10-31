import { expect, test } from "bun:test";
import { DashboardRecordSchema } from "../shared/contracts";

const record = DashboardRecordSchema.parse({
  id: "00000000-0000-4000-8000-000000000701", kind: "note", title: "Test record", body: "Body",
  source: "manual", createdBy: "owner", reviewState: "approved", archivedAt: null,
  createdAt: "2026-10-24T00:00:00Z", updatedAt: "2026-10-24T00:00:00Z", version: 1, fields: {},
});
type View = InstanceType<typeof Bun.WebView>;
const until = (view: View, expression: string) => view.evaluate(`new Promise((resolve, reject) => {
  const read = () => (${expression});
  const stop = () => { observer.disconnect(); clearTimeout(timer); };
  const check = () => { const value = read(); if (value) { stop(); resolve(value); } };
  const observer = new MutationObserver(check);
  const timer = setTimeout(() => { stop(); reject(new Error("State did not arrive")); }, 5000);
  observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true }); check();
})`);

test("startup retries server failures, settings retry load failures, and rate limits disable repeated actions", async () => {
  // Given: the real client served beside controllable HTTP boundary failures.
  const build = await Bun.build({ entrypoints: [`${import.meta.dir}/main.tsx`], target: "browser" });
  expect(build.success).toBe(true);
  const script = await build.outputs.find(output => output.path.endsWith(".js"))?.text();
  let startupFails = true;
  let settingsFail = true;
  let rateFails = false;
  let shareCalls = 0;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/") return new Response('<!doctype html><div id="root"></div><script type="module" src="/app.js"></script>', { headers: { "Content-Type": "text/html" } });
    if (path === "/app.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
    if (path === "/api/v1/config") return Response.json({ appName: "Test", locale: "en", timeZone: "UTC",
      features: { narration: true, push: false, digest: false, trustedLogin: false } });
    if (path === "/api/v1/auth/session") return startupFails
      ? Response.json({ error: { code: "internal_error", message: "Internal failure" } }, { status: 503 })
      : Response.json({ csrfToken: "csrf-test", expiresAt: "2026-10-30T00:00:00Z" });
    if (path === "/api/v1/records") return Response.json({ items: [record], nextCursor: null });
    if (path === "/api/v1/records/changes") return Response.json({ cursor: 0, items: [], deletedIds: [], hasMore: false, reset: false });
    if (path === "/api/v1/narration/auto") return settingsFail
      ? Response.json({ error: { code: "internal_error", message: "Failed" } }, { status: 503 })
      : Response.json({ digests: "off", records: "off", scope: "full" });
    if (path === "/api/v1/narration/voices") return Response.json({ error: { code: "internal_error", message: "Failed" } }, { status: 503 });
    if (path.endsWith("/share")) {
      shareCalls++;
      return rateFails ? Response.json({ error: { code: "rate_limited", message: "limited" } },
        { status: 429, headers: { "Retry-After": "60" } }) : Response.json({ share: null });
    }
    return Response.json({ items: [] });
  } });
  const view = new Bun.WebView({ width: 1024, height: 768 });
  try {
    // When: startup fails, then the owner retries after the server recovers.
    await view.navigate(`${server.url}#/settings`);
    expect(await until(view, 'document.querySelector("[data-startup-error]") !== null')).toBe(true);
    expect(await view.evaluate<boolean>('Boolean([...document.querySelectorAll("button")].find(b => b.textContent?.includes("owner key")))')).toBe(false);
    startupFails = false;
    await view.evaluate('document.querySelector("[data-startup-error] button").click()');
    // Then: both independent audio sections remain visible and a failed section can recover in place.
    expect(await until(view, 'document.querySelector("#settings-auto") && document.querySelector("#settings-voices") && document.querySelector("[aria-labelledby=settings-auto] [role=alert]") !== null')).toBe(true);
    settingsFail = false;
    await view.evaluate('document.querySelector("[aria-labelledby=settings-auto] button").click()');
    expect(await until(view, 'document.querySelector("[aria-labelledby=settings-auto] .auto-choice") !== null')).toBe(true);

    // When: sharing is explicitly requested but the server rate-limits it.
    rateFails = true;
    await view.evaluate(`location.hash = "#/library/${record.id}"`);
    await until(view, 'document.querySelector("button[aria-label=Share]") !== null');
    await view.evaluate('document.querySelector("button[aria-label=Share]").click()');
    // Then: the draft action cannot repeat during Retry-After.
    expect(await until(view, 'document.querySelector("dialog .form-error")?.textContent?.includes("60")')).toBe(true);
    expect(await view.evaluate<boolean>('document.querySelector("dialog .btn-primary")?.disabled')).toBe(true);
    expect(shareCalls).toBe(1);
  } finally { view.close(); server.stop(true); }
}, 30_000);

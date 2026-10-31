import { beforeAll, expect, test } from "bun:test";
import { agentText } from "./views/agent-copy";
import { applyLocale, getLocale } from "./i18n";
import { hostedFixture } from "../tests/helpers/hosted";

type View = InstanceType<typeof Bun.WebView>;
let script: string;
beforeAll(async () => {
  const build = await Bun.build({ entrypoints: [`${import.meta.dir}/main.tsx`], target: "browser" });
  expect(build.success).toBe(true);
  const output = build.outputs.find(output => output.path.endsWith(".js"));
  if (!output) throw new Error("Missing browser bundle");
  script = await output.text();
});
const until = (view: View, expression: string) => view.evaluate(`new Promise((resolve, reject) => {
  const stop = () => { observer.disconnect(); clearTimeout(timer); };
  const check = () => { const value = (${expression}); if (value) { stop(); resolve(value); } };
  const observer = new MutationObserver(check);
  const timer = setTimeout(() => { stop(); reject(new Error("State did not arrive: " + ${JSON.stringify(expression)})); }, 5000);
  observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true }); check();
})`);
async function setup(locale: "en" | "ko" = "en", timeZoneSaved = false, timeZone = "UTC") {
  let used = false;
  const agent = () => ({ name: "omo", capture: false, createdAt: "2026-10-24T00:00:00Z",
    lastUsedAt: used ? "2026-10-24T01:00:00Z" : null, revokedAt: null });
  const account = () => ({ id: "test-user", email: "reader@example.test", locale, timeZone, timeZoneSaved,
    onboardedAt: null, agentSaveVerified: used, agentSaveRecordId: null, features: { digest: false, push: false } });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/") return new Response(`<!doctype html><div id="root"></div><script>
      const OriginalDateTimeFormat = Intl.DateTimeFormat;
      Intl.DateTimeFormat = function(...args) {
        const formatter = new OriginalDateTimeFormat(...args);
        const options = formatter.resolvedOptions();
        formatter.resolvedOptions = () => ({ ...options, timeZone: "America/Los_Angeles" });
        return formatter;
      };
      Intl.DateTimeFormat.prototype = OriginalDateTimeFormat.prototype;
      </script><script type="module" src="/app.js"></script>`, { headers: { "Content-Type": "text/html" } });
    if (path === "/app.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
    if (path === "/api/v1/config") return Response.json({ appName: "Test", locale, timeZone: "UTC", authMode: "google",
      features: { narration: false, push: false, digest: false, trustedLogin: false } });
    if (path === "/api/v1/auth/session") return Response.json({ csrfToken: "csrf-test", expiresAt: "2026-10-30T00:00:00Z", account: account() });
    if (path === "/api/v1/account") return Response.json({ account: account() });
    if (path === "/api/v1/agents") return request.method === "POST"
      ? Response.json({ agent: agent(), key: "synthetic-token-for-test" }) : Response.json({ items: [agent()] });
    return Response.json({ items: [] });
  } });
  const view = new Bun.WebView({ width: 1024, height: 768 });
  await view.navigate(String(server.url));
  await until(view, 'document.querySelector(".setup-footer .btn-primary") !== null');
  return { view, useAgent: () => { used = true; }, close: () => { view.close(); server.stop(true); } };
}

for (const saved of [false, true]) {
  test(`the initial calendar zone follows the browser only when no account choice is saved (${saved})`, async () => {
    // Given: a browser in Los Angeles and a UTC account projection, saved or inherited.
    const app = await setup("en", saved);
    try {
      // When: the first onboarding step renders.
      // Then: explicit UTC is preserved; an inherited default uses the browser's zone.
      expect(await app.view.evaluate<string>('document.querySelector("input[list=account-zones]").value'))
        .toBe(saved ? "UTC" : "America/Los_Angeles");
    } finally { app.close(); }
  }, 15_000);
}

test("account metadata distinguishes inherited UTC from a saved UTC choice", async () => {
  // Given: an account inheriting the server's UTC default.
  const f = await hostedFixture({ timeZone: "UTC" });
  try {
    expect(await (await f.call("/api/v1/account")).json()).toMatchObject({ account: { timeZone: "UTC", timeZoneSaved: false } });
    // When: the user explicitly saves UTC.
    await f.call("/api/v1/account/preferences", { method: "PATCH", body: { timeZone: "UTC" } });
    // Then: subsequent sessions can distinguish this choice from the default.
    expect(await (await f.call("/api/v1/auth/session")).json()).toMatchObject({ account: { timeZone: "UTC", timeZoneSaved: true } });
  } finally { await f.close(); }
});

test("saving another preference does not turn an inherited timezone into a saved choice", async () => {
  // Given: an account with no saved timezone.
  const f = await hostedFixture({ timeZone: "UTC" });
  try {
    // When: only the language is changed.
    await f.call("/api/v1/account/preferences", { method: "PATCH", body: { locale: "en" } });
    // Then: the browser can still offer its timezone as the initial choice.
    expect(await (await f.call("/api/v1/account")).json()).toMatchObject({ account: { timeZone: "UTC", timeZoneSaved: false } });
  } finally { await f.close(); }
});

test("checking an external save refreshes the mounted agent row", async () => {
  // Given: step two has already loaded the unused token.
  const previousLocale = getLocale();
  const app = await setup();
  try {
    await app.view.evaluate('document.querySelector(".setup-footer .btn-primary").click()');
    await until(app.view, 'document.querySelector(".account-agent .setting-note") !== null');
    const before = await app.view.evaluate<string>('document.querySelector(".account-agent .setting-note").textContent');
    app.useAgent();
    // When: the account check observes a new external save without navigating away.
    await app.view.evaluate('document.querySelector(".setup-panel > div > button").click()');
    await until(app.view, 'document.querySelector(".setup-footer .btn-primary").disabled === false');
    // Then: the same row reflects updated usage.
    await until(app.view, `document.querySelector(".account-agent .setting-note").textContent !== ${JSON.stringify(before)}`);
    applyLocale("en");
    expect(await app.view.evaluate<string>('document.querySelector(".account-agent .setting-note").textContent')).toBe(agentText().active);
  } finally { app.close(); applyLocale(previousLocale); }
}, 15_000);

for (const locale of ["en", "ko"] as const) {
  test(`clipboard denial keeps a selectable credential and specific recovery feedback (${locale})`, async () => {
    // Given: a newly issued copy-once credential and a browser denying clipboard writes.
    const previousLocale = getLocale();
    const app = await setup(locale);
    try {
      await app.view.evaluate('document.querySelector(".setup-footer .btn-primary").click()');
      await until(app.view, 'document.querySelector(".account-agent") !== null && document.querySelector("[aria-labelledby=agent-connect-heading] .btn-primary").disabled === false');
      await app.view.evaluate('document.querySelector("[aria-labelledby=agent-connect-heading] .btn-primary").click()');
      await until(app.view, 'document.querySelector("dialog form") !== null');
      await app.view.evaluate('document.querySelector("dialog form").requestSubmit()');
      await until(app.view, 'document.querySelector("dialog input[readonly]") !== null && document.querySelector("dialog .account-actions .btn-primary").disabled === false');
      await app.view.evaluate(`Object.defineProperty(navigator, "clipboard", { configurable: true,
        value: { writeText: async () => { throw new DOMException("Denied", "NotAllowedError"); } } })`);
      // When: Copy token is pressed.
      await app.view.evaluate('document.querySelector("dialog .account-actions .btn-primary").click()');
      await until(app.view, 'document.querySelector("dialog [role=alert]") !== null');
      // Then: recovery is clipboard-specific, and manual selection can copy the still-visible token.
      applyLocale(locale);
      expect(await app.view.evaluate<string>('document.querySelector("dialog [role=alert]").textContent')).toBe(
        agentText().clipboardBlocked,
      );
      expect(await app.view.evaluate<string>('document.querySelector("dialog input[readonly]").type')).toBe("text");
      expect(await app.view.evaluate<string>('document.querySelector("dialog input[readonly]").value')).toBe("synthetic-token-for-test");
      await app.view.evaluate('document.querySelector("dialog input[readonly]").select()');
      expect(await app.view.evaluate<number>('document.querySelector("dialog input[readonly]").selectionEnd')).toBe("synthetic-token-for-test".length);
      await app.view.evaluate('document.querySelector("dialog .account-check input").click()');
      await app.view.evaluate('document.querySelector("dialog .dialog-actions .btn-primary").click()');
      await until(app.view, 'document.querySelector("dialog") === null');
      expect(await app.view.evaluate<boolean>('document.body.textContent.includes("synthetic-token-for-test")')).toBe(false);
    } finally { app.close(); applyLocale(previousLocale); }
  }, 15_000);
}

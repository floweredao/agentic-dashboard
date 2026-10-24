import { expect, test } from "bun:test";
import { accountErrorMessage } from "./account-errors";
import { applyLocale, getLocale } from "./i18n";

test.each(["en", "ko"] as const)("the %s export control displays the size-limit recovery", async locale => {
  const previous = getLocale();
  const build = await Bun.build({ entrypoints: [`${import.meta.dir}/main.tsx`], target: "browser" });
  const script = await build.outputs.find(output => output.path.endsWith(".js"))?.text();
  const account = { id: "reader", email: "reader@example.test", locale, timeZone: "UTC",
    onboardedAt: "2026-01-01", agentSaveVerified: true, features: { digest: false, push: false } };
  let exports = 0;
  const server = Bun.serve({ port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/") return new Response('<div id="root"></div><script type="module" src="/app.js"></script>',
      { headers: { "Content-Type": "text/html" } });
    if (path === "/app.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
    if (path === "/api/v1/config") return Response.json({ appName: "Test", timeZone: "UTC", locale, authMode: "google",
      features: { narration: false, push: false, digest: false, trustedLogin: false } });
    if (path === "/api/v1/auth/session") return Response.json({ csrfToken: "fixture", expiresAt: "2099-01-01", account });
    if (path === "/api/v1/records/changes") return Response.json({ cursor: 0, items: [], deletedIds: [], hasMore: false, reset: false });
    if (path === "/api/v1/account/export") {
      exports++;
      return Response.json({ error: { code: "account_export_too_large", message: "Server detail" } }, { status: 413 });
    }
    return Response.json({ items: [], nextCursor: null });
  } });
  const view = new Bun.WebView({ width: 390, height: 844 });
  const ready = (condition: string) => view.evaluate(`new Promise((resolve,reject)=>{
    const check=()=>{if(${condition}){observer.disconnect();clearTimeout(timer);resolve(true)}};
    const observer=new MutationObserver(check);const timer=setTimeout(()=>{observer.disconnect();reject(new Error(${JSON.stringify(`Export UI missing: ${condition}`)}))},5000);
    observer.observe(document,{childList:true,subtree:true,attributes:true});check();
  })`);
  try {
    await view.navigate(`${server.url}#/settings`);
    await ready('document.querySelector(".account-export button")');
    // Exercise the current button's handler; pointer geometry is covered by the visual QA.
    await view.evaluate('document.querySelector(".account-export button").click()');
    await ready('document.querySelector(".account-export [role=alert]")');
    applyLocale(locale);
    const expected = accountErrorMessage("account_export_too_large");
    if (expected === undefined) throw new Error("Export error mapping missing");
    expect(await view.evaluate<string>('document.querySelector(".account-export [role=alert]").textContent'))
      .toBe(expected);
    expect(exports).toBe(1);
  } finally { view.close(); server.stop(true); applyLocale(previous); }
}, 15000);

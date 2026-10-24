import { expect, test } from "bun:test";

const waitFor = (view: InstanceType<typeof Bun.WebView>, condition: string) => view.evaluate(`new Promise((resolve,reject)=>{
  const check=()=>{if(${condition}){observer.disconnect();clearTimeout(timer);resolve(true)}};
  const observer=new MutationObserver(check); const timer=setTimeout(()=>{observer.disconnect();reject(new Error("Entry did not render"))},5000);
  observer.observe(document,{childList:true,subtree:true,attributes:true});check();
})`);

for (const locale of ["en", "ko"]) {
  test(`signed-out ${locale} entry has no navigation chrome or opener`, async () => {
    // Given: the actual built entry and a signed-out hosted API.
    const build = await Bun.build({ entrypoints: [`${import.meta.dir}/main.tsx`], target: "browser" });
    const script = await build.outputs.find(output => output.path.endsWith(".js"))?.text();
    const server = Bun.serve({ port: 0, fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/") return new Response(`<div id="root"></div><script>localStorage.setItem("agentic:locale",${JSON.stringify(locale)})</script><script type="module" src="/app.js"></script>`, { headers: { "Content-Type": "text/html" } });
      if (path === "/app.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
      if (path === "/api/v1/config") return Response.json({ appName: "Test", timeZone: "UTC", locale, authMode: "google", features: { narration: false, push: false, digest: false, trustedLogin: false } });
      return Response.json({ error: { code: "unauthenticated" } }, { status: 401 });
    } });
    const view = new Bun.WebView({ width: 390, height: 844 });
    try {
      // When: the real entry renders its sign-in surface.
      await view.navigate(server.url.href);
      await waitFor(view, 'document.querySelector(".google-signin")');
      // Then: navigation cannot appear or receive focus.
      expect(await view.evaluate<number>('document.querySelectorAll(".appbar-menu,.sidebar,.tabbar,.sidebar-open").length')).toBe(0);
      expect(await view.evaluate<string>('document.documentElement.lang')).toBe(locale);
    } finally { view.close(); server.stop(true); }
  }, 15000);
}

test("the hosted session renders the signed-in Google email", async () => {
  // Given: a completed hosted account and its own email in the session projection.
  const build = await Bun.build({ entrypoints: [`${import.meta.dir}/main.tsx`], target: "browser" });
  const script = await build.outputs.find(output => output.path.endsWith(".js"))?.text();
  const email = "reader@example.test";
  const server = Bun.serve({ port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/") return new Response('<div id="root"></div><script type="module" src="/app.js"></script>', { headers: { "Content-Type": "text/html" } });
    if (path === "/app.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
    if (path === "/api/v1/config") return Response.json({ appName: "Test", timeZone: "UTC", locale: "en", authMode: "google", features: { narration: false, push: false, digest: false, trustedLogin: false } });
    if (path === "/api/v1/auth/session") return Response.json({ csrfToken: "fixture", expiresAt: "2099-01-01",
      account: { id: "reader", email, locale: "en", timeZone: "UTC", onboardedAt: "2026-01-01", agentSaveVerified: true, features: { digest: false, push: false } } });
    if (path === "/api/v1/records/changes") return Response.json({ cursor: 0, items: [], deletedIds: [], hasMore: false, reset: false });
    return Response.json({ items: [], nextCursor: null });
  } });
  const view = new Bun.WebView();
  try {
    // When: the signed-in user opens agent connections.
    await view.navigate(`${server.url}#/channels`);
    await waitFor(view, 'document.querySelector(".session-section")');
    // Then: the rendered identity comes from the session, not a generic owner label.
    expect(await view.evaluate<string>('document.querySelector(".session-section")?.textContent')).toContain(email);
  } finally { view.close(); server.stop(true); }
}, 15000);

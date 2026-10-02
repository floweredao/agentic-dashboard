// Agentic Dashboard service worker: Web Push only. It caches nothing, so every load still gets the current build.
// Payload (server/push.ts): { kind, title, body, url, tag }; url is an in-app address such as /#/digest/<id>.

self.addEventListener("install", () => { self.skipWaiting(); });
self.addEventListener("activate", event => { event.waitUntil(self.clients.claim()); });

// Every push shows a notification: Safari drops a subscription whose pushes stay silent.
self.addEventListener("push", event => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; }
  catch { payload = { body: event.data ? event.data.text() : "" }; }
  event.waitUntil(self.registration.showNotification(payload.title || "Agentic Dashboard", {
    body: payload.body || "",
    tag: payload.tag || "Agentic Dashboard",
    data: { url: typeof payload.url === "string" && payload.url.startsWith("/") ? payload.url : "/" },
    icon: "/icon-192.png",
    badge: "/favicon-32.png",
  }));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const target = windows.find(client => client.focused) || windows[0];
    if (target) {
      target.postMessage({ type: "agentic:open", url });
      try { await target.focus(); return; } catch { /* iOS can refuse focus(); open a window instead. */ }
    }
    await self.clients.openWindow(url);
  })());
});

import { expect, test } from "bun:test";
import { fixture } from "./backend-helper";
import { subscription } from "./isolation-fixture";
import type { PushPayload } from "../shared/contracts";
import { deferred } from "./narration-helper";

test("hidden previews redact private text for only the device that requested it", async () => {
  // Given: two devices with different privacy choices and a real account store.
  const sent: { endpoint: string; payload: PushPayload }[] = [];
  const f = await fixture(10000, Date.now, { push: { deliver: async (target, payload) => {
    sent.push({ endpoint: target.endpoint, payload }); return 201;
  } } });
  try {
    const owner = await f.login();
    const hidden = await f.call("/api/v1/push/subscription", "PUT", { subscription: { ...subscription("hidden"), hideContent: true } }, owner);
    expect(hidden.status).toBe(200);
    await f.call("/api/v1/push/subscription", "PUT", { subscription: subscription("visible") }, owner);
    // When: one private review is delivered to both devices.
    await f.app.push.notify([{ kind: "review", payload: { kind: "review", title: "Private subject", body: "Secret excerpt", url: "/#/work/one", tag: "one" } }]);
    // Then: only the explicit preview device receives the text, and routing is preserved.
    expect(sent.find(item => item.endpoint.endsWith("/visible"))?.payload.body).toBe("Secret excerpt");
    const safe = sent.find(item => item.endpoint.endsWith("/hidden"))?.payload;
    expect(JSON.stringify(safe)).not.toContain("Private subject");
    expect(JSON.stringify(safe)).not.toContain("Secret excerpt");
    expect(safe?.url).toBe("/#/work/one");
  } finally { await f.close(); }
});

test("notification completion includes delivery instead of abandoning work after the request", async () => {
  // Given: an exact delivery-entry event and release signal.
  const entered = deferred<void>(); const release = deferred<void>();
  const f = await fixture(10000, Date.now, { push: { deliver: async () => { entered.resolve(); await release.promise; return 201; } } });
  try {
    await f.app.push.subscribe(subscription("awaited"));
    // When: notification starts while the transport is held.
    const pending = f.app.push.notify([{ kind: "review", payload: { kind: "review", title: "Title", body: "Body", url: "/", tag: "one" } }]);
    await entered.promise;
    expect(Bun.peek.status(pending)).toBe("pending");
    release.resolve(); await pending;
    // Then: completion reports an actual settled transport.
    expect(Bun.peek.status(pending)).toBe("fulfilled");
  } finally { release.resolve(); await f.close(); }
});

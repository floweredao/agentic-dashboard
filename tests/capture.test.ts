import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { z } from "zod";
import { createApp, type AppOptions } from "../server/app";
import { captureFallback, enrichCapture } from "../server/capture-enrichment";
import { fetchPublicPage } from "../server/capture-http";
import { DashboardRecordSchema } from "../shared/contracts";
import { bearer, fixture, payload } from "./backend-helper";

const privateOrigin = "https://capture.example.test:9443";
const identity = { Host: "capture.example.test:9443", "Tailscale-User-Login": "owner@example.test", "X-Capture": "v1" };
const resultSchema = z.object({ record: DashboardRecordSchema, replayed: z.boolean() });
function captureFixture(options: AppOptions = {}) {
  const f = fixture();
  let enrichments = 0;
  const config = { ...f.options, privateOrigin, trustedIdentity: { header: "Tailscale-User-Login", login: "owner@example.test" }, publicApiBaseUrl: "https://agents.example.test", ...options,
    enrichCapture: async (url: URL) => { enrichments++; return (options.enrichCapture ?? (async target => captureFallback(target)))(url); } };
  let app = createApp(config);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => app.fetch(request) });
  const ingress = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => app.publicFetch(request) });
  const db = new Database(f.options.databasePath);
  const count = (table: "records" | "requests" | "sessions") => z.object({ n: z.number() }).parse(db.query(`SELECT count(*) AS n FROM ${table}`).get()).n;
  return {
    f, db, count, get app() { return app; }, get enrichments() { return enrichments; },
    restart() { app.close(); app = createApp(config); },
    async call(body: unknown = { url: "https://example.com/a" }, init: RequestInit = {}, publicOnly = false) {
      const headers = new Headers({ ...identity, "Content-Type": "application/json" });
      new Headers(init.headers).forEach((value, key) => headers.set(key, value));
      const response = await fetch(`http://127.0.0.1:${publicOnly ? ingress.port : server.port}/api/v1/capture`, {
        method: "POST", ...init, headers, body: init.body ?? JSON.stringify(body), signal: AbortSignal.timeout(5000),
      });
      if (process.env.CAPTURE_EVIDENCE) console.log(JSON.stringify({
        status: response.status, headers: Object.fromEntries(response.headers), body: await response.clone().text(),
      }));
      return response;
    },
    async close() {
      await server.stop(true); await ingress.stop(true); db.close(); app.close(); f.close();
      expect(existsSync(f.dir)).toBe(false);
      if (process.env.CAPTURE_EVIDENCE) console.log(`cleanup: stopped private/public HTTP listeners; removed ${f.dir}`);
    },
  };
}

test("enriches a URL-only capture with a real title and extractive summary", async () => {
  // Given: page metadata available through the endpoint's offline enrichment seam.
  const f = captureFixture({ enrichCapture: async () => ({
    title: "Shortcuts user guide",
    fields: { summary: "Run shortcuts from another app.", captureEnrichment: { status: "available", source: "page" } },
  }) });
  try {
    // When: the existing Shortcut sends only its original URL.
    const response = await f.call({ url: "https://support.apple.com/ko-kr/guide/shortcuts/apd163eb9f95/ios" });
    // Then: usable content is saved, without altering the Shortcut payload.
    expect(response.status).toBe(201);
    expect(resultSchema.parse(await response.json()).record).toMatchObject({
      title: "Shortcuts user guide", fields: { summary: "Run shortcuts from another app." },
      links: [{ label: "Source", url: "https://support.apple.com/ko-kr/guide/shortcuts/apd163eb9f95/ios" }],
    });
  } finally { await f.close(); }
});

test("creates pending social capture without a session", async () => {
  // Given: an isolated private Serve backend and no session.
  const f = captureFixture();
  try {
    // When: a native caller shares a URL without tokens, cookies or Origin.
    const response = await f.call({ url: " https://X.com/user/status/1 " });
    // Then: the stored response is a pending owner social record, without a session.
    expect(response.status).toBe(201);
    const result = resultSchema.parse(await response.json());
    expect(result.replayed).toBe(false);
    expect(result.record).toMatchObject({ kind: "social", source: "manual", createdBy: "owner", reviewState: "pending", version: 1,
      archivedAt: null, title: "x.com/user/status/1", fields: { origin: "x" }, links: [{ label: "Source", url: "https://x.com/user/status/1" }] });
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(f.count("sessions")).toBe(0);
    expect(f.count("records")).toBe(1);
  } finally { await f.close(); }
});

const invalidBodies = [
  {}, null, [], { url: 42 }, { url: "" }, { url: "   " }, { url: "example.com" }, { url: "/relative" }, { url: "//example.com" },
  { url: "ftp://example.com" }, { url: "javascript:alert(1)" }, { url: "https://" }, { url: "https://[" },
  { url: "https://user@example.com" }, { url: "https://user:pass@example.com" }, { url: "https://:pass@example.com" },
  { url: "https://example.com/a b" }, { url: "https://exam\tple.com" }, { url: "https://example.com/a\nb" },
  { url: "https://example.com/a\u0000b" }, { url: "https://example.com/a\u007fb" }, { url: "https://example.com/a\u0085b" },
  { url: "https://example.com/a\u00a0b" }, { url: "https://example.com", title: "injected" }, { url: "https://example.com", requestId: "override" },
  { url: `https://example.com/${"a".repeat(2030)}` }, { url: `https://example.com/${"./".repeat(1020)}` },
  { url: `https://example.com/${"가".repeat(230)}` },
];
test.each(invalidBodies.map(body => ({ body })))("rejects invalid capture JSON %j", async ({ body }) => {
  // Given/When: invalid input crosses the actual HTTP boundary.
  const f = captureFixture();
  try {
    const response = await f.call(body);
    // Then: validation never persists anything or creates a session.
    expect(response.status).toBe(400);
    expect(f.enrichments).toBe(0);
    expect(f.count("records")).toBe(0); expect(f.count("requests")).toBe(0); expect(f.count("sessions")).toBe(0);
  } finally { await f.close(); }
});
test.each([
  ["https://x.com", "x.com", "x"], ["https://mobile.twitter.com/a?b=1#c", "mobile.twitter.com/a", "x"],
  ["https://a.x.com/a", "a.x.com/a", "x"], ["https://twitter.com", "twitter.com", "x"],
  ["https://threads.net", "threads.net", "threads"], ["https://www.threads.com/t", "www.threads.com/t", "threads"],
  ["https://a.threads.net", "a.threads.net", "threads"], ["https://threads.com", "threads.com", "threads"],
  ["https://notx.com", "notx.com", "other"], ["https://x.com.evil.test", "x.com.evil.test", "other"],
  ["https://notthreads.net", "notthreads.net", "other"], ["http://127.0.0.1:9", "127.0.0.1", "other"],
  [`https://example.com/${"a".repeat(2028)}`, `example.com/${"a".repeat(188)}`, "other"],
])("infers title and origin for %s", async (url, title, origin) => {
  // Given/When: a valid URL, including the 2048-character boundary, is captured.
  const f = captureFixture();
  try {
    const response = await f.call({ url }, { headers: { Origin: privateOrigin } });
    // Then: inference uses hostname boundaries, omits root/query/fragment and truncates title.
    expect(response.status).toBe(201);
    expect(resultSchema.parse(await response.json()).record).toMatchObject({ title, fields: { origin } });
  } finally { await f.close(); }
});

const deniedCases: readonly { readonly name: string; readonly headers?: HeadersInit; readonly options?: AppOptions; readonly status: number }[] = [
  { name: "disabled login", options: { trustedIdentity: { header: "Tailscale-User-Login", login: "" } }, status: 401 },
  { name: "HTTP configuration", options: { privateOrigin: "http://capture.example.test:9443" }, status: 401 },
  { name: "wrong identity", headers: { "Tailscale-User-Login": "other@example.test" }, status: 401 },
  { name: "empty identity", headers: { "Tailscale-User-Login": "" }, status: 401 },
  { name: "combined identity", headers: { "Tailscale-User-Login": "owner@example.test,other@example.test" }, status: 401 },
  { name: "empty marker", headers: { "X-Capture": "" }, status: 403 },
  { name: "wrong marker", headers: { "X-Capture": "v2" }, status: 403 },
  { name: "local host", headers: { Host: "127.0.0.1:4310" }, status: 401 },
  { name: "forwarded host", headers: { Host: "127.0.0.1:4310", "X-Forwarded-Host": "capture.example.test:9443", "X-Forwarded-Proto": "https" }, status: 401 },
  { name: "public host", headers: { Host: "agents.example.test" }, status: 401 },
  { name: "wrong port", headers: { Host: "capture.example.test" }, status: 421 },
  { name: "foreign host", headers: { Host: "evil.example.test" }, status: 421 },
  { name: "local Origin", headers: { Origin: "http://127.0.0.1:4310" }, status: 403 },
  { name: "foreign Origin", headers: { Origin: "https://evil.example.test" }, status: 403 },
  { name: "null Origin", headers: { Origin: "null" }, status: 403 },
  { name: "empty Origin", headers: { Origin: "" }, status: 403 },
  { name: "slash Origin", headers: { Origin: `${privateOrigin}/` }, status: 403 },
  { name: "empty Authorization", headers: { Authorization: "" }, status: 401 },
  { name: "malformed Authorization", headers: { Authorization: "Basic invalid" }, status: 401 },
  { name: "invalid Bearer", headers: { Authorization: "Bearer invalid" }, status: 401 },
  { name: "agent Bearer", headers: bearer("omo"), status: 401 },
  { name: "owner Bearer", headers: bearer("owner"), status: 401 },
];
test.each([...deniedCases])("denies capture with $name", async ({ options, headers, status }) => {
  // Given/When: one trust condition fails on the live backend.
  const f = captureFixture(options);
  try {
    const response = await f.call(undefined, { headers: headers ?? {} });
    // Then: no credential fallback or persistent side effect is possible.
    expect(response.status).toBe(status); expect(response.headers.get("set-cookie")).toBeNull();
    expect(f.enrichments).toBe(0);
    expect(f.count("records")).toBe(0); expect(f.count("sessions")).toBe(0);
  } finally { await f.close(); }
});
test("requires each header and ignores valid cookie authority", async () => {
  // Given: an existing owner session.
  const f = captureFixture();
  try {
    const owner = await f.f.login();
    for (const missing of ["Host", "Tailscale-User-Login", "X-Capture"]) {
      const headers = new Headers({ ...identity, Cookie: owner.Cookie, "Content-Type": "application/json" }); headers.delete(missing);
      // When: an otherwise valid caller omits a required header.
      const response = await f.app.fetch(new Request(`${privateOrigin}/api/v1/capture`, { method: "POST", headers, body: '{"url":"https://example.com"}' }));
      // Then: even the cookie and request URL cannot supply capture authority.
      expect(response.status).toBe(missing === "X-Capture" ? 403 : 401); expect(response.headers.get("set-cookie")).toBeNull();
    }
    expect(f.count("records")).toBe(0); expect(f.count("sessions")).toBe(1);
  } finally { await f.close(); }
});
test("rejects malformed bodies and public ingress", async () => {
  // Given/When: malformed JSON, wrong media type, oversized body, or public access.
  const f = captureFixture();
  try {
    expect((await f.call(undefined, { body: "{" })).status).toBe(400);
    expect((await f.call(undefined, { headers: { "Content-Type": "text/plain" } })).status).toBe(415);
    expect((await f.call(undefined, { body: JSON.stringify({ url: "x".repeat(32768) }) })).status).toBe(413);
    expect((await f.call(undefined, {}, true)).status).toBe(404);
    // Then: no record or session is created.
    expect(f.count("records")).toBe(0); expect(f.count("sessions")).toBe(0);
    expect(f.enrichments).toBe(0);
  } finally { await f.close(); }
});
test("replays concurrent and restarted captures without resetting edited read archived state", async () => {
  // Given: several native submissions of the same normalized URL.
  const f = captureFixture();
  try {
    const responses = await Promise.all(Array.from({ length: 8 }, (_, i) => f.call({ url: i % 2 ? " https://EXAMPLE.com:443/a " : "https://example.com/a" })));
    expect(responses.map(r => r.status).sort()).toEqual([200, 200, 200, 200, 200, 200, 200, 201]);
    const results = await Promise.all(responses.map(async r => resultSchema.parse(await r.json())));
    const first = results.find(r => !r.replayed); expect(first).toBeDefined(); if (!first) return;
    expect(results.every(r => JSON.stringify(r.record) === JSON.stringify(first.record))).toBe(true);
    const owner = await f.f.login();
    const patch = await f.f.call(`/api/v1/records/${first.record.id}`, "PATCH", { expectedVersion: 1, changes: {
      title: "Edited", fields: { ...first.record.fields, summary: "Owner's edited summary" }, reviewState: "approved", archived: true,
    } }, owner);
    expect(patch.status).toBe(200);
    const edited = await patch.json();
    const row = z.object({ request_id: z.string(), payload: z.string() }).parse(f.db.query("SELECT request_id,payload FROM requests").get());
    expect(row.request_id).toBe(`capture:v1:${new Bun.CryptoHasher("sha512").update("https://example.com/a").digest("hex")}`);
    expect(row.request_id.length).toBe(139); expect(JSON.parse(row.payload)).toEqual({ url: "https://example.com/a" });
    // When: the server restarts and receives the URL again.
    f.restart();
    const response = await f.call({ url: "https://example.com/a" });
    // Then: replay returns the original snapshot, not a rewrite of the edited record.
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ record: first.record, replayed: true });
    expect(await (await f.f.call(`/api/v1/records/${first.record.id}`, "GET", undefined, owner)).json()).toEqual(edited);
    expect(f.count("records")).toBe(1); expect(f.count("requests")).toBe(1);
    expect(f.enrichments).toBe(1);
    expect((await f.f.call("/api/v1/records", "POST", { ...payload(), requestId: row.request_id }, owner)).status).toBe(400);
  } finally { await f.close(); }
});
test("keeps Store.create authoritative when separate apps finish enrichment out of order", async () => {
  // Given: two apps share one SQLite store but have independent enrichment in flight.
  const firstEntered = Promise.withResolvers<void>();
  const secondEntered = Promise.withResolvers<void>();
  const firstReady = Promise.withResolvers<void>();
  const secondReady = Promise.withResolvers<void>();
  const f = captureFixture({ enrichCapture: async url => {
    firstEntered.resolve(); await firstReady.promise;
    return { ...captureFallback(url), title: "Late metadata" };
  } });
  const second = createApp({ ...f.f.options, privateOrigin, trustedIdentity: { header: "Tailscale-User-Login", login: "owner@example.test" },
    enrichCapture: async url => { secondEntered.resolve(); await secondReady.promise; return { ...captureFallback(url), title: "Winning metadata" }; },
  });
  try {
    const one = f.call();
    const two = second.fetch(new Request(`${privateOrigin}/api/v1/capture`, {
      method: "POST", headers: { ...identity, "Content-Type": "application/json" }, body: '{"url":"https://example.com/a"}',
    }));
    await Promise.all([firstEntered.promise, secondEntered.promise]);
    // When: the second app wins the transaction before the first finishes metadata.
    secondReady.resolve();
    const winnerResponse = await two;
    const winner = resultSchema.parse(await winnerResponse.json());
    firstReady.resolve();
    const replayResponse = await one;
    // Then: both return the same committed snapshot, not whichever metadata finishes later.
    expect(winnerResponse.status).toBe(201);
    expect(winner.record.title).toBe("Winning metadata");
    expect(replayResponse.status).toBe(200);
    expect(await replayResponse.json()).toEqual({ record: winner.record, replayed: true });
    expect(f.count("records")).toBe(1); expect(f.count("requests")).toBe(1);
  } finally {
    firstReady.resolve(); secondReady.resolve(); second.close(); await f.close();
  }
});
test("rolls back capture when the request snapshot cannot be inserted", async () => {
  // Given: a real SQLite failure after the record insert.
  const f = captureFixture();
  try {
    f.db.run("CREATE TRIGGER fail_capture BEFORE INSERT ON requests BEGIN SELECT RAISE(ABORT, 'capture test rollback'); END");
    // When: capture attempts the transaction.
    expect((await f.call()).status).toBe(500);
    // Then: both inserts roll back and the next retry is a fresh creation.
    expect(f.count("records")).toBe(0); expect(f.count("requests")).toBe(0);
    f.db.run("DROP TRIGGER fail_capture");
    expect((await f.call()).status).toBe(201); expect(f.count("records")).toBe(1); expect(f.count("requests")).toBe(1);
  } finally { await f.close(); }
});
test("saves private targets as unavailable without resolving or connecting", async () => {
  // Given: the real enrichment and security path, with network seams that must not run.
  let networkCalls = 0;
  const f = captureFixture({ enrichCapture: url => enrichCapture(url, {
    page: (target, signal) => fetchPublicPage(target, signal, {
      resolve: async () => { networkCalls++; throw new Error("Unexpected DNS"); },
      request: async () => { networkCalls++; throw new Error("Unexpected connection"); },
    }),
  }) });
  try {
    // When: a validated URL points at loopback.
    const response = await f.call({ url: "http://127.0.0.1:9/a" });
    // Then: the URL is preserved, but no fetch or DNS lookup is possible.
    expect(response.status).toBe(201);
    expect(resultSchema.parse(await response.json()).record).toMatchObject({
      title: "127.0.0.1/a", links: [{ label: "Source", url: "http://127.0.0.1:9/a" }],
      fields: { summary: "", captureEnrichment: { status: "unavailable", reason: "unsafe_url" } },
    });
    expect(networkCalls).toBe(0);
  } finally { await f.close(); }
});

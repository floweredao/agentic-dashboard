import { expect, test } from "bun:test";
import { z } from "zod";
import { hostedFixture } from "./helpers/hosted";
import { tenantData } from "../server/tenant-data";
import { fake, deferred } from "./narration-helper";
import { isolationFixture, clock } from "./isolation-fixture";
import type { Sql, SqlValue } from "../server/db";

const note = { kind: "note", title: "Own agent save", body: "Saved from the connected computer.", tags: ["test"] };
const saved = z.object({ record: z.object({ id: z.string() }) });
async function identified(extra: Parameters<typeof hostedFixture>[0] = {}) {
  const f = await hostedFixture(extra);
  await f.app.sql.run("UPDATE users SET email=?,name=?,google_sub=? WHERE id=?", ["a@example.test", "A", "subject-a", "a"]);
  await f.app.sql.run("UPDATE users SET email=?,name=? WHERE id=?", ["b@example.test", "B", "b"]);
  return f;
}

test("onboarding requires an external agent save rather than a manual or browser test save", async () => {
  // Given: a new account and its personal agent token.
  const f = await identified();
  try {
    const token = z.object({ key: z.string() }).parse(await (await f.call("/api/v1/agents",
      { method: "POST", body: { name: "writer" } })).json()).key;
    await f.call("/api/v1/records", { method: "POST", body: { requestId: "manual", record: note } });
    await f.call("/api/v1/records", { method: "POST", headers: { Authorization: `Bearer ${token}`, Origin: "http://127.0.0.1:4390" },
      body: { requestId: "browser-test", record: note } });
    expect((await f.call("/api/v1/onboarding/done", { method: "POST", body: {} })).status).toBe(409);
    // When: the user's own CLI sends a valid bearer save.
    await f.call("/api/v1/records", { method: "POST", headers: { Authorization: `Bearer ${token}` },
      body: { requestId: "actual-agent", record: note } });
    // Then: setup completes for A alone.
    expect((await f.call("/api/v1/onboarding/done", { method: "POST", body: {} })).status).toBe(200);
    expect(await (await f.call("/api/v1/account")).json()).toMatchObject({ account: { email: "a@example.test", agentSaveVerified: true } });
    expect(await (await f.call("/api/v1/account", { headers: f.b.headers })).json()).toMatchObject({ account: { agentSaveVerified: false, onboardedAt: null } });
  } finally { await f.close(); }
});

test("account preferences persist across sessions and reject an invalid calendar zone", async () => {
  // Given: two account sessions.
  const f = await identified();
  try {
    // When: A sets its language, calendar and digest preference.
    const result = await f.call("/api/v1/account/preferences", { method: "PATCH",
      body: { locale: "ko", timeZone: "Asia/Seoul", features: { digest: false, push: true } } });
    // Then: the server persists A's choice without changing B.
    expect(result.status).toBe(200);
    expect(await (await f.call("/api/v1/auth/session")).json()).toMatchObject({ account: { email: "a@example.test", locale: "ko", timeZone: "Asia/Seoul", features: { digest: false } } });
    expect(await (await f.call("/api/v1/account", { headers: f.b.headers })).json()).toMatchObject({ account: { locale: "system" } });
    expect((await f.call("/api/v1/account/preferences", { method: "PATCH", body: { timeZone: "Not/AZone" } })).status).toBe(400);
  } finally { await f.close(); }
});

test("export includes all tenant tables and audio but excludes credentials and another account", async () => {
  // Given: A and B content and A's HTML document.
  const f = await identified();
  try {
    const a = saved.parse(await (await f.call("/api/v1/records", { method: "POST", body: { requestId: "a", record: note } })).json()).record;
    await f.call(`/api/v1/records/${a.id}/document`, { method: "PUT", body: { html: "<p>A complete document</p>" } });
    await f.call("/api/v1/records", { method: "POST", headers: f.b.headers, body: { requestId: "b", record: { ...note, title: "B private" } } });
    // When: A downloads its archive through the real API.
    const response = await f.call("/api/v1/account/export");
    expect(response.status).toBe(200);
    const files = await new Bun.Archive(new Uint8Array(await response.arrayBuffer())).files();
    const data = z.object({ tables: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))) })
      .parse(JSON.parse(await files.get("data.json")?.text() ?? "{}"));
    // Then: every table has a slot, documents are intact, and authentication material is absent.
    expect([...files.keys()]).toContain("README.txt");
    expect(Object.keys(data.tables).sort()).toEqual(Object.keys(await tenantData(f.app.sql, "a")).sort());
    expect(data.tables["documents"]?.[0]?.["html"]).toBe("<p>A complete document</p>");
    expect(JSON.stringify(data)).not.toContain("B private");
    expect(JSON.stringify(data)).not.toContain("token_hash");
    expect(JSON.stringify(data)).not.toContain("gemini_key_ct");
    expect(JSON.stringify(data)).not.toContain(f.a.headers["X-CSRF-Token"]);
  } finally { await f.close(); }
});

test("account deletion removes every tenant row and revokes sessions without touching B", async () => {
  // Given: saved content in each account.
  const f = await identified();
  try {
    await f.call("/api/v1/records", { method: "POST", body: { requestId: "a", record: note } });
    await f.call("/api/v1/records", { method: "POST", headers: f.b.headers, body: { requestId: "b", record: note } });
    const before = await tenantData(f.app.sql, "b");
    // When: A confirms deletion with its current session.
    const response = await f.call("/api/v1/account", { method: "DELETE", body: { confirm: "a@example.test" } });
    // Then: active data is gone and a scrubbed tombstone remains; B is byte-for-byte unchanged.
    expect(response.status).toBe(204);
    expect(Object.values(await tenantData(f.app.sql, "a")).flat()).toEqual([]);
    expect(await tenantData(f.app.sql, "b")).toEqual(before);
    const tombstone = z.object({ email: z.string().nullable(), name: z.string().nullable(), google_sub: z.string(), gemini_key_ct: z.string().nullable() })
      .parse(await f.app.sql.get("SELECT email,name,google_sub,gemini_key_ct FROM users WHERE id='a'"));
    expect(tombstone).toEqual({
      email: null, name: null, google_sub: "subject-a", gemini_key_ct: null,
    });
    expect((await f.call("/api/v1/account")).status).toBe(401);
  } finally { await f.close(); }
});

test("deletion refuses incorrect confirmation and requires a session under ten minutes old", async () => {
  // Given: a controlled clock rather than a timed wait.
  let now = Date.parse("2026-01-01T12:00Z");
  const f = await identified({ now: () => now });
  try {
    expect((await f.call("/api/v1/account", { method: "DELETE", body: { confirm: "wrong@example.test" } })).status).toBe(400);
    now += 600001;
    // When: deletion uses an otherwise valid but stale session.
    const response = await f.call("/api/v1/account", { method: "DELETE", body: { confirm: "a@example.test" } });
    // Then: the user is asked to reauthenticate, without losing their live data.
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "reauth_required" } });
    expect(await f.app.sql.get("SELECT id FROM users WHERE id='a' AND deleted_at IS NULL")).not.toBeNull();
  } finally { await f.close(); }
});

test("deletion reads the confirmation profile through its transaction handle", async () => {
  const f = await identified();
  const sql = f.app.sql;
  const transaction: Sql = {
    get: sql.get.bind(sql), all: sql.all.bind(sql), run: sql.run.bind(sql),
    batch: sql.batch.bind(sql), tx: sql.tx.bind(sql), close: sql.close.bind(sql),
  };
  let inside = false;
  sql.get = async <T = unknown>(query: string, args?: readonly SqlValue[]) => {
    if (inside) throw new Error("The root connection cannot read inside this transaction");
    return transaction.get<T>(query, args);
  };
  sql.tx = callback => transaction.tx(async () => {
    inside = true;
    try { return await callback(transaction); }
    finally { inside = false; }
  });
  try {
    const response = await f.call("/api/v1/account", { method: "DELETE", body: { confirm: "a@example.test" } });
    expect(response.status).toBe(204);
    expect(await sql.get("SELECT id FROM users WHERE id='a' AND deleted_at IS NULL")).toBeNull();
  } finally {
    sql.get = transaction.get;
    sql.tx = transaction.tx;
    await f.close();
  }
});

test("in-flight narration cannot make its next provider call after deletion", async () => {
  // Given: script generation held at an exact observable boundary.
  const tts = fake();
  const entered = deferred<AbortSignal>(); const release = deferred<void>();
  tts.scriptHold = { entered, release };
  const f = await identified({ narration: { provider: tts.provider, retryDelayMs: 0 } });
  try {
    const a = saved.parse(await (await f.call("/api/v1/records", { method: "POST", body: { requestId: "a", record: note } })).json()).record;
    await f.call(`/api/v1/records/${a.id}/narration`, { method: "POST", body: {} });
    await entered.promise;
    // When: A deletes the account while its script is in flight.
    expect((await f.call("/api/v1/account", { method: "DELETE", body: { confirm: "a@example.test" } })).status).toBe(204);
    release.resolve();
    await f.a.scope.narration.idle();
    // Then: no speech is billed and no result resurrects the account.
    expect(tts.calls.speak).toEqual([]);
    expect(Object.values(await tenantData(f.app.sql, "a")).flat()).toEqual([]);
  } finally { release.resolve(); await f.close(); }
});

test("full export preserves every seeded tenant table and its actual audio bytes", async () => {
  // Given: the repository's comprehensive tenant fixture, including comments, reactions, shares and audio.
  const f = await isolationFixture();
  try {
    const before = await tenantData(f.app.sql, "a");
    // When: exporting that account.
    const files = await new Bun.Archive(await (await f.a.account.export()).arrayBuffer()).files();
    const exported = z.object({ tables: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))) })
      .parse(JSON.parse(await files.get("data.json")?.text() ?? "{}"));
    // Then: every seeded row is present, and audio is the stored file rather than a URL.
    for (const [table, rows] of Object.entries(before)) expect(exported.tables[table]?.length).toBe(rows.length);
    const name = z.string().parse(before["narrations"]?.[0]?.["audio_file"]);
    const audio = files.get(`audio/${name}`);
    expect(audio?.size).toBe(524);
  } finally { await f.close(); }
});

test("deletion erases every populated tenant table while retaining the other tenant", async () => {
  // Given: all tenant tables populated and an identified hosted-style account.
  const f = await isolationFixture();
  try {
    await f.app.sql.run("UPDATE users SET email='a@example.test' WHERE id='a'");
    await f.a.store.db.run("INSERT INTO background_jobs(kind,id,revision,user_id) VALUES('ai-fill','test','1',?)", []);
    const before = await tenantData(f.app.sql, "b");
    // When: removing A after a fresh authentication.
    await f.a.account.remove("a@example.test", clock());
    // Then: every active A row is removed and B is unchanged.
    expect(Object.values(await tenantData(f.app.sql, "a")).flat()).toEqual([]);
    expect(await tenantData(f.app.sql, "b")).toEqual(before);
  } finally { await f.close(); }
});

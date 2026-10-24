import { expect, test } from "bun:test";
import { z } from "zod";
import { oidcFixture, oidcOrigin } from "./helpers/oidc-app";
import { hash, secret } from "../server/agents";
import { ControlDb } from "../server/control-db";

test("pending OAuth transactions stay bounded for one client across rate windows", async () => {
  const f = await oidcFixture(50, oidcOrigin, true);
  try {
    // Given twenty outstanding transactions from one trusted client.
    const headers = { "X-Forwarded-For": "192.0.2.1, 198.51.100.1" };
    for (let window = 0; window < 2; window++) {
      for (let i = 0; i < 10; i++) await f.start(headers);
      f.advance(60000);
    }
    // When a third minute adds another pending transaction.
    await f.start(headers);
    // Then the client cannot accumulate more than twenty active rows.
    const row = z.object({ count: z.number() }).parse(await f.app.sql.get("SELECT count(*) AS count FROM oauth_transactions"));
    expect(row.count).toBe(20);
  } finally { await f.close(); }
});

test("the newest bounded transaction still works if the callback's network changes", async () => {
  const f = await oidcFixture(50, oidcOrigin, true);
  try {
    // Given more starts than the per-client outstanding-transaction bound.
    const headers = { "X-Forwarded-For": "192.0.2.1, 198.51.100.1" };
    for (let window = 0; window < 2; window++) {
      for (let i = 0; i < 10; i++) await f.start(headers);
      f.advance(60000);
    }
    const latest = await f.start(headers);
    // When the signed transaction returns without its original network metadata.
    const response = await f.finish(latest);
    // Then its cookie, not an unstable callback IP, binds the one-time transaction.
    expect(response.status).toBe(302);
  } finally { await f.close(); }
});

test("different direct socket clients retain independent pending transaction budgets", async () => {
  const f = await oidcFixture();
  try {
    // Given one direct client's outstanding transactions.
    const start = (address: string) => f.app.fetch(new Request(`${oidcOrigin}/auth/google/start`), {
      requestIP: () => ({ address }),
    });
    for (let i = 0; i < 20; i++) await start("198.51.100.1");
    // When another direct client starts its own transactions.
    for (let i = 0; i < 20; i++) await start("198.51.100.2");
    // Then it does not evict the first client's budget.
    const row = z.object({ count: z.number() }).parse(await f.app.sql.get("SELECT count(*) AS count FROM oauth_transactions"));
    expect(row.count).toBe(40);
  } finally { await f.close(); }
});

test("concurrent starts cannot exceed the per-client database bound", async () => {
  const f = await oidcFixture();
  try {
    // Given one client tag and a shared transaction store.
    const client = hash(secret());
    const expires = Date.parse("2026-10-24T12:10:00Z");
    // When starts arrive concurrently, independently of the in-memory rate limiter.
    await Promise.all(Array.from({ length: 25 }, () => f.app.auth.control.startOAuth(hash(secret()), expires, client)));
    // Then atomic pruning and insertion preserve the bound.
    const row = z.object({ count: z.number() }).parse(await f.app.sql.get("SELECT count(*) AS count FROM oauth_transactions"));
    expect(row.count).toBe(20);
  } finally { await f.close(); }
});

test("IPv6 prefix shares pending transaction capacity across rate windows", async () => {
  const f = await oidcFixture(50, oidcOrigin, true);
  try {
    // Given twenty pending starts from different interfaces in one /64.
    for (let i = 0; i < 20; i++) await f.start({ "X-Forwarded-For": `2001:db8:1:2::${i.toString(16)}` });
    f.advance(60000);
    // When a new interface starts in the next rate window.
    await f.start({ "X-Forwarded-For": "2001:0db8:0001:0002:ffff::1" });
    // Then the shared client tag keeps the pending row bound.
    const row = z.object({ count: z.number() }).parse(await f.app.sql.get("SELECT count(*) AS count FROM oauth_transactions"));
    expect(row.count).toBe(20);
  } finally { await f.close(); }
});

test("global pending capacity evicts oldest starts and admits a new client", async () => {
  const f = await oidcFixture();
  try {
    // Given a full store whose expiry order differs from lexical key order.
    const control = new ControlDb(f.app.sql, false, 3);
    const expires = Date.parse("2026-10-24T12:10:00Z");
    await control.startOAuth("oldest", expires, "z");
    await control.startOAuth("middle", expires + 1, "a");
    await control.startOAuth("recent", expires + 2, "b");
    // When an unrelated client starts.
    await control.startOAuth("newest", expires + 3, "c");
    // Then only the oldest transaction is evicted; the newcomer remains consumable.
    expect(await control.consumeOAuth("z:oldest", expires - 1)).toBe(false);
    expect(await control.consumeOAuth("a:middle", expires - 1)).toBe(true);
    expect(await control.consumeOAuth("b:recent", expires - 1)).toBe(true);
    expect(await control.consumeOAuth("c:newest", expires - 1)).toBe(true);
  } finally { await f.close(); }
});

test("concurrent distinct clients cannot exceed global pending capacity", async () => {
  const f = await oidcFixture();
  try {
    // Given a store with a small global cap.
    const control = new ControlDb(f.app.sql, false, 3);
    const expires = Date.parse("2026-10-24T12:10:00Z");
    // When distinct clients start concurrently at the same timestamp.
    await Promise.all(Array.from({ length: 25 }, (_, i) => control.startOAuth(`tx${i}`, expires, `client${i}`)));
    // Then atomic eviction and insertion retain exactly the configured capacity.
    const row = z.object({ count: z.number() }).parse(await f.app.sql.get("SELECT count(*) AS count FROM oauth_transactions"));
    expect(row.count).toBe(3);
  } finally { await f.close(); }
});

test("new starts survive global eviction when existing expiries tie", async () => {
  const f = await oidcFixture();
  try {
    // Given one pending start at a single-row capacity.
    const control = new ControlDb(f.app.sql, false, 1);
    const expires = Date.parse("2026-10-24T12:10:00Z");
    await control.startOAuth("z", expires, "first");
    // When a lexically earlier transaction arrives at the same timestamp.
    await control.startOAuth("a", expires, "second");
    // Then eviction preserves insertion order rather than rejecting the newcomer.
    expect(await control.consumeOAuth("first:z", expires - 1)).toBe(false);
    expect(await control.consumeOAuth("second:a", expires - 1)).toBe(true);
  } finally { await f.close(); }
});

test("a victim can finish sign-in during a flood at the global ceiling", async () => {
  const f = await oidcFixture(50, oidcOrigin, true);
  try {
    // Given a victim's real mock-provider sign-in awaiting its callback.
    const victim = await f.start({ "X-Forwarded-For": "198.51.100.1" });
    // When an attacker rotates enough /48s to flush the old pending capacity.
    const statuses = [];
    for (let i = 0; i < 2500; i++) statuses.push((await f.call("/auth/google/start", {
      "X-Forwarded-For": `2001:db8:${i.toString(16)}::1`,
    })).status);
    const response = await f.finish(victim);
    // Then only the remaining global allowance creates rows and the victim completes.
    expect(statuses.filter(status => status === 302)).toHaveLength(899);
    expect(statuses.filter(status => status === 429)).toHaveLength(1601);
    expect(response.status).toBe(302);
  } finally { await f.close(); }
});

test("default pending capacity retains an older sign-in beyond two thousand newer starts", async () => {
  const f = await oidcFixture();
  try {
    // Given an older pending sign-in and 2500 newer rows from prior rate windows.
    const control = new ControlDb(f.app.sql, false);
    const expires = Date.parse("2026-10-24T12:10:00Z");
    await control.startOAuth("victim", expires, "original");
    await f.app.sql.run(`WITH RECURSIVE pending(n) AS (
      VALUES(1) UNION ALL SELECT n+1 FROM pending WHERE n<2500)
      INSERT INTO oauth_transactions(tx_hash,expires_at)
      SELECT 'client-' || n || ':tx', ? FROM pending`, [expires + 1]);
    // When another client starts with default capacity.
    await control.startOAuth("newest", expires + 2, "fresh");
    // Then the older live sign-in is not evicted by the old two-thousand-row limit.
    expect(await control.consumeOAuth("original:victim", expires - 1)).toBe(true);
  } finally { await f.close(); }
});

import { expect, test } from "bun:test";
import { z } from "zod";
import { oidcFixture, oidcOrigin } from "./helpers/oidc-app";
import { hash, secret } from "../server/agents";

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

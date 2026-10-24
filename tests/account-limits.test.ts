import { expect, test } from "bun:test";
import { hostedFixture } from "./helpers/hosted";
import { fake } from "./narration-helper";
import { ProviderError } from "../server/narration-types";
import { z } from "zod";

test("hosted allowance reports default and per-account override without changing another account", async () => {
  // Given: a normal hosted account and an operator-assigned override.
  const f = await hostedFixture({ ownerUserLimits: { a: 20 } });
  try {
    // When: each account reads its effective allowance.
    const a = await f.call("/api/v1/narration/allowance");
    const b = await f.call("/api/v1/narration/allowance", { headers: f.b.headers });
    // Then: the operator keeps 20 and the other account gets the hosted default 10.
    expect(await a.json()).toMatchObject({ limit: 20, remaining: 20, failedStartsCount: true });
    expect(await b.json()).toMatchObject({ limit: 10, remaining: 10 });
  } finally { await f.close(); }
});

test("failed starts count and automatic audio cannot raise a hosted account allowance", async () => {
  // Given: one allowed start, fixed calendar time and a fake failing provider.
  const tts = fake();
  tts.scriptErrors.push(new ProviderError("quota_daily", false));
  const f = await hostedFixture({ now: () => Date.parse("2026-01-01T12:00Z"), timeZone: "UTC",
    narration: { provider: tts.provider, dailyLimit: 1, retryDelayMs: 0 } });
  try {
    const response = await f.call("/api/v1/records", { method: "POST", body: { requestId: "one",
      record: { kind: "note", title: "One", body: "One record." } } });
    const { record } = z.object({ record: z.object({ id: z.string() }) }).parse(await response.json());
    await f.call("/api/v1/narration/auto", { method: "PUT", body: { records: "read", digests: "off", scope: "full" } });
    await f.call(`/api/v1/records/${record.id}/narration`, { method: "POST", body: {} });
    await f.a.scope.narration.idle();
    // When: another start is requested after the provider failure.
    const limited = await f.call(`/api/v1/records/${record.id}/narration`, { method: "POST", body: { force: true } });
    // Then: the failed start consumed the allowance, with an exact reset and Retry-After.
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("43200");
    expect(await limited.json()).toMatchObject({ error: { code: "narration_daily_limit", retryAt: "2026-01-02T00:00:00.000Z" } });
    expect(await (await f.call("/api/v1/narration/allowance")).json()).toMatchObject({ used: 1, remaining: 0 });
    expect(await (await f.call("/api/v1/narration/allowance", { headers: f.b.headers })).json()).toMatchObject({ used: 0, remaining: 1 });
  } finally { await f.close(); }
});

test("public share requests have separate address limits with a retry deadline", async () => {
  // Given: a frozen one-minute window.
  const f = await hostedFixture({ now: () => Date.parse("2026-01-01T00:00:10Z") });
  try {
    for (let count = 0; count < 60; count++) await f.call("/s/missing", { headers: { "X-Forwarded-For": "192.0.2.1" } });
    // When: one address exceeds the share limit.
    const limited = await f.call("/s/missing", { headers: { "X-Forwarded-For": "192.0.2.1" } });
    // Then: another address is still served and the first sees its exact wait.
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("50");
    expect((await f.call("/s/missing", { headers: { "X-Forwarded-For": "192.0.2.2" } })).status).toBe(404);
  } finally { await f.close(); }
});

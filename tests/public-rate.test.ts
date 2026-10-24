import { expect, test } from "bun:test";
import { publicRequestLimiter } from "../server/public-rate";

for (const endpoint of [{ path: "/s/example", limit: 60 }, { path: "/api/v1/shared/example", limit: 60 }, { path: "/api/v1/auth/session", limit: 20 }]) {
  const call = (forwarded: string) => new Request(`https://example.test${endpoint.path}`, {
    method: endpoint.path === "/api/v1/auth/session" ? "POST" : "GET", headers: { "X-Forwarded-For": forwarded },
  });
  test(`${endpoint.path} cannot reset its budget with a spoofed leading hop`, () => {
    // Given: one proxy-appended client exhausting its bucket.
    const limit = publicRequestLimiter(() => 0, 1);
    for (let count = 0; count < endpoint.limit; count++) limit(call(`192.0.2.${count}, 198.51.100.1`), "203.0.113.1");
    // When/Then: a changed untrusted prefix cannot change the key.
    expect(limit(call("192.0.2.200, 198.51.100.1"), "203.0.113.1")?.status).toBe(429);
  });
  test(`${endpoint.path} ignores forwarded values on a direct listener`, () => {
    // Given: one socket peer exhausting its bucket.
    const limit = publicRequestLimiter(() => 0);
    for (let count = 0; count < endpoint.limit; count++) limit(call(`192.0.2.${count}`), "198.51.100.1");
    // When/Then: a fabricated forwarded address cannot evade the socket budget.
    expect(limit(call("192.0.2.200"), "198.51.100.1")?.status).toBe(429);
  });
  test(`${endpoint.path} accepts new clients when its bounded map is full`, () => {
    // Given: 10,000 distinct canonical IPv4 keys (not aliases inside one IPv6 /64).
    const limit = publicRequestLimiter(() => 0, 1);
    for (let count = 0; count < 10000; count++) limit(call(`198.18.${count >> 8}.${count % 256}`), "203.0.113.1");
    // When/Then: a fresh client gets its own initial budget.
    expect(limit(call("198.19.1.1"), "203.0.113.1")).toBeNull();
  });
}

test("the additional public limiter never handles OIDC starts or callbacks", () => {
  // Given: a limiter exhausted on owner-key login.
  const limit = publicRequestLimiter(() => 0);
  for (let count = 0; count < 21; count++) limit(new Request("https://example.test/api/v1/auth/session", { method: "POST" }), "192.0.2.1");
  // When/Then: main's canonical /auth budgets remain the only authority for OIDC.
  expect(limit(new Request("https://example.test/auth/google/start"), "192.0.2.1")).toBeNull();
  expect(limit(new Request("https://example.test/auth/google/callback"), "192.0.2.1")).toBeNull();
  expect(limit(new Request("https://example.test/api/v1/auth/session"), "192.0.2.1")).toBeNull();
});

import { expect, test } from "bun:test";
import { authLimiter } from "../server/auth-rate";

const request = (forwarded: string) => new Request("https://example.test/auth/google/start", {
  headers: { "X-Forwarded-For": forwarded },
});

test("trusted proxy requests share the appended client hop despite spoofed prefixes", () => {
  // Given one actual client has exhausted its minute.
  const limit = authLimiter(() => 0, true);
  for (let i = 0; i < 20; i++) limit(request(`192.0.2.${i}, 198.51.100.1`), "203.0.113.1");
  // When it changes the client-supplied leading hop again.
  const response = limit(request("192.0.2.99, 198.51.100.1"), "203.0.113.1");
  // Then it cannot reset the budget.
  expect(response?.status).toBe(429);
});

test("direct requests ignore forwarded values and use the socket address", () => {
  // Given the same socket peer has exhausted its minute.
  const limit = authLimiter(() => 0, false);
  for (let i = 0; i < 20; i++) limit(request(`192.0.2.${i}`), "198.51.100.1");
  // When the peer supplies a new forwarded value.
  const response = limit(request("192.0.2.99"), "198.51.100.1");
  // Then the socket budget still applies.
  expect(response?.status).toBe(429);
});

test("a full rate bucket map does not lock out a fresh client", () => {
  // Given enough distinct clients to fill the bounded map.
  const limit = authLimiter(() => 0, true);
  for (let i = 0; i < 10000; i++) limit(request(`2001:db8::${i.toString(16)}`), "203.0.113.1");
  // When another real client arrives.
  const response = limit(request("2001:db8:1::1"), "203.0.113.1");
  // Then it gets its own initial budget rather than a global lockout.
  expect(response).toBeNull();
});

test("missing forwarded metadata falls back to the socket even behind a proxy", () => {
  // Given a proxy connection without a forwarded client address.
  const limit = authLimiter(() => 0, true);
  const plain = new Request("https://example.test/auth/google/start");
  for (let i = 0; i < 20; i++) limit(plain, "198.51.100.1");
  // When that same socket attempts one more request.
  const response = limit(plain, "198.51.100.1");
  // Then the socket bucket is enforced.
  expect(response?.status).toBe(429);
});

for (const endpoint of [{ path: "/s/example", limit: 60 }, { path: "/api/v1/shared/example", limit: 60 }, { path: "/api/v1/auth/session", limit: 20 }]) {
  const call = (forwarded: string) => new Request(`https://example.test${endpoint.path}`, { headers: { "X-Forwarded-For": forwarded } });
  test(`${endpoint.path} cannot reset its budget with a spoofed leading hop`, () => {
    // Given: one proxy-appended client exhausting the applicable bucket.
    const limit = authLimiter(() => 0, true);
    for (let count = 0; count < endpoint.limit; count++) limit(call(`192.0.2.${count}, 198.51.100.1`), "203.0.113.1");
    // When/Then: changing the untrusted prefix does not change the client key.
    expect(limit(call("192.0.2.200, 198.51.100.1"), "203.0.113.1")?.status).toBe(429);
  });
  test(`${endpoint.path} ignores forwarded values on a direct listener`, () => {
    // Given: one real socket peer.
    const limit = authLimiter(() => 0, false);
    for (let count = 0; count < endpoint.limit; count++) limit(call(`192.0.2.${count}`), "198.51.100.1");
    // When/Then: a fabricated address cannot evade the socket bucket.
    expect(limit(call("192.0.2.200"), "198.51.100.1")?.status).toBe(429);
  });
  test(`${endpoint.path} still accepts new clients when the bounded map is full`, () => {
    // Given: enough genuine proxy-appended clients to fill the map.
    const limit = authLimiter(() => 0, true);
    for (let count = 0; count < 10000; count++) limit(call(`2001:db8::${count.toString(16)}`), "203.0.113.1");
    // When/Then: the next distinct client gets its own budget.
    expect(limit(call("2001:db8:1::1"), "203.0.113.1")).toBeNull();
  });
}

import { expect, test } from "bun:test";
import { authClientKey, authLimiter } from "../server/auth-rate";

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
  for (let i = 0; i < 10000; i++) limit(request(`2001:db8:${i.toString(16)}::1`), "203.0.113.1");
  // When another real client arrives.
  const response = limit(request("2001:db8:ffff::1"), "203.0.113.1");
  // Then it gets its own initial budget rather than a global lockout.
  expect(response).toBeNull();
});

test("rotating IPv6 interface addresses cannot reset a prefix budget", () => {
  // Given twenty requests from different addresses in one /64.
  const limit = authLimiter(() => 0, true);
  for (let i = 0; i < 20; i++) limit(request(`2001:db8:abcd:12::${i.toString(16)}`));
  // When another interface address in that prefix starts signing in.
  const response = limit(request("2001:0DB8:ABCD:0012:ffff:ffff:ffff:ffff"));
  // Then it shares the budget while a neighboring /64 remains independent.
  expect(response?.status).toBe(429);
  expect(limit(request("2001:db8:abcd:13::1"))).toBeNull();
});

test.each([
  ["2001:db8::1", "2001:0db8:0000:0000:0000:0000:0000:0000/64"],
  ["2001:0DB8:0000::ffff", "2001:0db8:0000:0000:0000:0000:0000:0000/64"],
  ["::ffff:192.0.2.1", "192.0.2.1"],
  ["0:0:0:0:0:FFFF:c000:0201", "192.0.2.1"],
  ["192.0.2.1", "192.0.2.1"],
])("client key canonicalizes %s", (address, expected) => {
  // Given an IP represented by a socket or trusted proxy.
  const plain = new Request("https://example.test/auth/google/start");
  // When either ingress selects that address.
  const keys = [authClientKey(plain, address, false), authClientKey(request(address), undefined, true)];
  // Then both produce the same canonical network key.
  expect(keys).toEqual([expected, expected]);
});

test("mapped IPv4 and native IPv4 share one budget", () => {
  // Given a native IPv4 client at its limit.
  const limit = authLimiter(() => 0, true);
  for (let i = 0; i < 20; i++) limit(request("192.0.2.1"));
  // When the proxy renders the same client as mapped IPv6.
  const response = limit(request("::ffff:c000:201"));
  // Then mapping cannot reset its budget.
  expect(response?.status).toBe(429);
});

test("two trusted hops select clients before a shared load balancer", () => {
  // Given a load balancer and an exhausted client with spoofed leading values.
  const limit = authLimiter(() => 0, 2);
  for (let i = 0; i < 20; i++) limit(request(`192.0.2.${i}, 198.51.100.1, 203.0.113.1`));
  // When that client tries again and another client uses the same balancer.
  const exhausted = limit(request("192.0.2.99, 198.51.100.1, 203.0.113.1"));
  const fresh = limit(request("192.0.2.99, 198.51.100.2, 203.0.113.1"));
  // Then spoofing cannot reset the client and the balancer does not share all budgets.
  expect(exhausted?.status).toBe(429);
  expect(fresh).toBeNull();
});

test.each(["198.51.100.1", "junk, 203.0.113.1", ", 203.0.113.1"])(
  "missing or malformed configured hop falls back to the socket: %s", forwarded => {
    // Given an invalid second-from-right hop and a socket address.
    const input = request(forwarded);
    // When that hop is selected.
    const key = authClientKey(input, "192.0.2.1", 2);
    // Then no other untrusted header position is used.
    expect(key).toBe("192.0.2.1");
  },
);

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

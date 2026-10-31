import { expect, test } from "bun:test";
import { createForwarder } from "../scripts/mcp-forward";
import { secret } from "../server/agents";

test("loopback forwarder injects bearer without forwarding browser credentials", async () => {
  // Given an HTTP MCP upstream and a generated bearer.
  const token = `fd_${secret()}`;
  const seen: string[] = [];
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    seen.push(request.headers.get("authorization") ?? "");
    return Response.json({ cookie: request.headers.get("cookie"), method: request.method });
  } });
  const forward = createForwarder({ destination: `http://127.0.0.1:${upstream.port}/mcp`, token, host: "127.0.0.1:4313" });
  try {
    // When a tunnel forwards an MCP request.
    const response = await forward(new Request("http://127.0.0.1:4313/mcp", { method: "POST",
      headers: { "Content-Type": "application/json", Cookie: "untrusted=browser" }, body: "{}" }));
    // Then only the configured agent authority reaches the upstream.
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ cookie: null, method: "POST" });
    expect(seen).toEqual([`Bearer ${token}`]);
  } finally { upstream.stop(true); }
});

test("loopback forwarder rejects browser origins and foreign hosts before upstream calls", async () => {
  const forward = createForwarder({ destination: "https://example.test/mcp", token: `fd_${secret()}`, host: "127.0.0.1:4313" });
  expect((await forward(new Request("http://evil.example/mcp", { method: "POST", body: "{}" }))).status).toBe(421);
  expect((await forward(new Request("http://127.0.0.1:4313/mcp", { method: "POST", headers: { Origin: "https://example.test" }, body: "{}" }))).status).toBe(403);
});

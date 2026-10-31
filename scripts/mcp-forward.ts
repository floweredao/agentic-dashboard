import { parseArgs } from "node:util";
import ky from "ky";
import { z } from "zod";

export function createForwarder(options: { readonly destination: string; readonly token: string; readonly host: string }) {
  return async (request: Request) => {
    const url = new URL(request.url);
    if ((request.headers.get("host") ?? url.host) !== options.host) return new Response(null, { status: 421 });
    if (request.headers.has("origin")) return new Response(null, { status: 403 });
    if (url.pathname !== "/mcp") return new Response(null, { status: 404 });
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
    const body = await request.arrayBuffer();
    if (body.byteLength > 512 * 1024) return new Response(null, { status: 413 });
    const headers = new Headers({ Authorization: `Bearer ${options.token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" });
    const version = request.headers.get("mcp-protocol-version");
    if (version) headers.set("MCP-Protocol-Version", version);
    try {
      const response = await ky.post(options.destination, { body, headers, retry: 0, timeout: 30000, redirect: "error", throwHttpErrors: false });
      return new Response(response.body, { status: response.status, headers: {
        "Content-Type": response.headers.get("content-type") ?? "application/json", "Cache-Control": "no-store",
      } });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return Response.json({ error: { code: "upstream_unavailable", message: "The dashboard could not be reached." } }, { status: 502 });
    }
  };
}

if (import.meta.main) {
  const { values } = parseArgs({ args: Bun.argv.slice(2), options: {
    listen: { type: "string", default: "127.0.0.1:4313" }, to: { type: "string" }, "token-file": { type: "string" },
  } });
  const listen = z.string().regex(/^127\.0\.0\.1:\d{1,5}$/).parse(values.listen);
  const port = z.coerce.number().int().min(1).max(65535).parse(listen.split(":")[1]);
  const destination = new URL(z.url().parse(values.to));
  if (destination.protocol !== "https:" && !(destination.protocol === "http:" && destination.hostname === "127.0.0.1")) {
    throw new TypeError("--to requires HTTPS (or loopback HTTP for a local test)");
  }
  if (destination.username || destination.password || destination.pathname !== "/mcp" || destination.search || destination.hash) {
    throw new TypeError("--to must be the dashboard /mcp endpoint");
  }
  const path = z.string().min(1).parse(values["token-file"]);
  const token = z.string().trim().min(16).max(512).parse(await Bun.file(path).text());
  const server = Bun.serve({ hostname: "127.0.0.1", port, maxRequestBodySize: 512 * 1024,
    fetch: createForwarder({ destination: destination.href, token, host: listen }) });
  console.log(`MCP forwarder listening on http://${listen}/mcp`);
  process.once("SIGINT", () => server.stop(true));
  process.once("SIGTERM", () => server.stop(true));
}

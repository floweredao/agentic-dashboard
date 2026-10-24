import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture } from "./backend-helper";

test("only existing content-hashed assets receive immutable caching", async () => {
  // Given: a real static root containing hashed and stable resources.
  const f = (await fixture());
  const staticRoot = join(f.dir, "static");
  mkdirSync(join(staticRoot, "assets"), { recursive: true });
  writeFileSync(join(staticRoot, "index.html"), "<!doctype html><title>Test</title>");
  writeFileSync(join(staticRoot, "assets", "app-Ab3dEf90.js"), "export {}");
  writeFileSync(join(staticRoot, "assets", "stable.js"), "export {}");
  const { createApp } = await import("../server/app");
  const app = (await createApp({ ...f.options, staticRoot }));
  try {
    // When: the actual HTTP surface serves resources, data and SPA fallbacks.
    const headers = await Promise.all(["/assets/app-Ab3dEf90.js", "/assets/stable.js", "/assets/missing-Ab3dEf90.js", "/", "/api/v1/config"]
      .map(async path => (await app.fetch(new Request(`http://127.0.0.1:4310${path}`))).headers.get("cache-control")));
    // Then: only the real hashed asset is cacheable.
    expect(headers).toEqual(["public, max-age=31536000, immutable", "no-store", "no-store", "no-store", "no-store"]);
  } finally { (await app.close()); (await f.close()); }
});

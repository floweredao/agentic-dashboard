import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomFillSync } from "node:crypto";
import { z } from "zod";
import { hostedFixture, hostedOrigin } from "./helpers/hosted";

test("a client abort during download removes its private export directory", async () => {
  // Given: a unique scratch root and a download with unread bytes.
  const directory = await mkdtemp(join(tmpdir(), "export-abort-test-"));
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = directory;
  const f = await hostedFixture();
  const abort = new AbortController();
  let response: Response | undefined;
  try {
    for (let i = 0; i < 12; i++) {
      await f.call("/api/v1/records", { method: "POST", body: {
        requestId: `abort-${i}`, record: { kind: "note", title: "Abort fixture",
          body: Buffer.from(randomFillSync(new Uint8Array(65536))).toString("base64") },
      } });
    }
    response = await f.app.fetch(new Request(`${hostedOrigin}/api/v1/account/export`, {
      headers: f.a.headers, signal: abort.signal,
    }));
    expect(response.status).toBe(200);
    expect((await readdir(directory)).filter(name => name.startsWith("floweredao-export-"))).toHaveLength(1);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Missing export body");
    try {
      expect((await reader.read()).done).toBe(false);
      const closed = reader.closed;
      // When: the client disconnects after receiving the first bytes.
      abort.abort();
      await expect(closed).rejects.toThrow();
      // Then: cleanup removed the directory and released the account lease.
      expect((await readdir(directory)).filter(name => name.startsWith("floweredao-export-"))).toEqual([]);
      expect(z.object({ export_lease: z.null() }).parse(
        await f.app.sql.get("SELECT export_lease FROM users WHERE id='a'")).export_lease).toBeNull();
    } finally { reader.releaseLock(); }
  } finally {
    await Promise.allSettled([response?.body?.cancel()]);
    await f.close();
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

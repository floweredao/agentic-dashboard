import { expect, test } from "bun:test";
import { z } from "zod";
import type { AudioStore } from "../server/audio-store";
import { hostedFixture } from "./helpers/hosted";
import { deferred } from "./narration-helper";

class StreamOnlyAudio extends Blob {
  chunks = 0;
  cancelled = false;
  constructor(private readonly length: number) { super([]); }
  override get size() { return this.length; }
  override async arrayBuffer(): Promise<ArrayBuffer> { throw new Error("Whole-audio buffering is forbidden"); }
  override stream() {
    let remaining = this.length;
    return new ReadableStream<Uint8Array<ArrayBuffer>>({
      pull: controller => {
        if (!remaining) { controller.close(); return; }
        const size = Math.min(65536, remaining);
        remaining -= size;
        this.chunks++;
        controller.enqueue(new Uint8Array(size));
      },
      cancel: () => { this.cancelled = true; },
    });
  }
}
async function fixture(read: AudioStore["read"], size: number) {
  const audio: AudioStore = {
    remote: true, read,
    async put() { throw new Error("Unexpected audio write"); },
    async url() { throw new Error("Unexpected signed link"); },
    async remove() {}, async removeAll() {},
  };
  const f = await hostedFixture({ audioStore: audio });
  const { record } = z.object({ record: z.object({ id: z.string() }) }).parse(await (await f.call("/api/v1/records", {
    method: "POST", body: { requestId: "export", record: { kind: "note", title: "Export fixture", body: "Complete text." } },
  })).json());
  await f.a.scope.store.db.run(`INSERT INTO narrations
    (record_id,status,job_hash,requested_by,requested_at,updated_at,audio_file,audio_bytes,user_id)
    VALUES(?,'ready','fixture','owner','2026-01-01','2026-01-01','large.wav',?,?)`, [record.id, size]);
  return f;
}

test("large export consumes audio as bounded chunks instead of whole-file buffers", async () => {
  const audio = new StreamOnlyAudio(32 * 1024 * 1024);
  const f = await fixture(async () => audio.stream(), audio.size);
  try {
    const response = await f.call("/api/v1/account/export");
    expect(response.status).toBe(200);
    const files = await new Bun.Archive(await response.arrayBuffer()).files();
    expect(files.get("audio/large.wav")?.size).toBe(audio.size);
    expect(audio.chunks).toBe(512);
  } finally { await f.close(); }
});

test("a second export is refused while the first export is in flight", async () => {
  const entered = deferred<void>(), release = deferred<void>();
  let reads = 0;
  const f = await fixture(async () => {
    if (++reads === 1) { entered.resolve(); await release.promise; }
    return new Blob(["audio"]).stream();
  }, 5);
  const first = f.call("/api/v1/account/export");
  try {
    await entered.promise;
    const second = await f.call("/api/v1/account/export");
    expect(second.status).toBe(429);
    expect(second.headers.get("X-RateLimit-Scope")).toBe("export");
    expect(await second.json()).toMatchObject({ error: { code: "account_export_busy" } });
    release.resolve();
    const response = await first;
    const duringDownload = await f.call("/api/v1/account/export");
    expect(duringDownload.status).toBe(429);
    await duringDownload.body?.cancel();
    await response.body?.cancel();
    const next = await f.call("/api/v1/account/export");
    expect(next.status).toBe(200);
    await next.body?.cancel();
  } finally {
    release.resolve();
    await (await first).body?.cancel();
    await f.close();
  }
});

test("an oversized export stops reading and returns a clear size-limit error", async () => {
  const audio = new StreamOnlyAudio(96 * 1024 * 1024);
  const f = await fixture(async () => audio.stream(), audio.size);
  try {
    const response = await f.call("/api/v1/account/export");
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "account_export_too_large" } });
    expect(audio.chunks).toBeLessThan(1536);
    expect(audio.cancelled).toBe(true);
  } finally { await f.close(); }
});

test("an export lease held by another instance cannot be replaced or cleared", async () => {
  const f = await fixture(async () => new Blob(["audio"]).stream(), 5);
  try {
    await f.app.sql.run("UPDATE users SET export_lease='other-instance',export_until=? WHERE id='a'", [f.a.scope.store.now() + 900000]);
    expect((await f.call("/api/v1/account/export")).status).toBe(429);
    expect(z.object({ export_lease: z.string() }).parse(
      await f.app.sql.get("SELECT export_lease FROM users WHERE id='a'")).export_lease).toBe("other-instance");
  } finally { await f.close(); }
});

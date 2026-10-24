import { chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import type { Store } from "./store";
import type { AudioStore } from "./audio-store";
import { DataRowSchema, tenantQueries } from "./tenant-data";
import { ApiError } from "./errors";
import { EXPORT_MAX_BYTES, exportTooLarge, spoolAudio, writeArchive } from "./export-archive";

const hidden = new Set(["token_hash", "hash", "csrf", "code_hash", "gemini_key_ct", "gemini_key_kek",
  "auth", "p256dh", "export_lease", "export_until"]);
const safe = (row: unknown) => Object.fromEntries(Object.entries(DataRowSchema.parse(row)).filter(([key]) => !hidden.has(key)));
const ExportRowSchema = DataRowSchema.and(z.object({ _export_rowid: z.number() }));
// /tmp is memory-backed in Cloud Run: bound total instance scratch as well as each account.
const exporting = new Set<string>();
const DURATION = 900000;
const IDLE = 60000;

export async function accountExport(store: Store, audio: AudioStore, readme: string, requestSignal?: AbortSignal) {
  const userId = store.db.userId, lease = crypto.randomUUID();
  if (exporting.has(userId)) throw new ApiError(429, "account_export_busy", "An account export is already in progress");
  if (exporting.size >= 2) return Response.json({ error: {
    code: "account_export_capacity", message: "Export capacity is full. Try again shortly.",
  } }, { status: 503, headers: { "Retry-After": "60", "Cache-Control": "private, no-store" } });
  exporting.add(userId);
  const idle = new AbortController();
  const signal = AbortSignal.any([idle.signal, ...(requestSignal ? [requestSignal] : [])]);
  const expire = () => idle.abort(new DOMException("Account export was idle for 60 seconds", "TimeoutError"));
  let timeout = setTimeout(expire, IDLE), renewed = store.now(), cleaned = false;
  const progress = async () => {
    if (cleaned) return;
    clearTimeout(timeout);
    timeout = setTimeout(expire, IDLE);
    const now = store.now();
    if (now - renewed >= IDLE) {
      await store.db.sql.run("UPDATE users SET export_until=? WHERE id=? AND export_lease=?", [now + DURATION, userId, lease]);
      renewed = now;
    }
  };
  let directory: string | undefined;
  const cleanup = async () => {
    cleaned = true;
    clearTimeout(timeout);
    try {
      await store.db.sql.run("UPDATE users SET export_lease=NULL,export_until=NULL WHERE id=? AND export_lease=?", [userId, lease]);
    } finally {
      try { if (directory) await rm(directory, { recursive: true, force: true }); }
      finally { exporting.delete(userId); }
    }
  };
  try {
    const claimed = await store.db.sql.run(`UPDATE users SET export_lease=?,export_until=?
      WHERE id=? AND deleted_at IS NULL AND (export_until IS NULL OR export_until<=?)`,
    [lease, store.now() + DURATION, userId, store.now()]);
    if (!claimed.changes) throw new ApiError(429, "account_export_busy", "An account export is already in progress");
    directory = await mkdtemp(join(tmpdir(), "floweredao-export-"));
    const root = directory, dataPath = join(root, "data.json"), audioPath = join(root, "audio-entry");
    const names = new Set<string>();
    const writer = Bun.file(dataPath).writer({ highWaterMark: 65536 });
    let dataBytes = 0;
    const write = async (text: string) => {
      signal.throwIfAborted();
      dataBytes += Buffer.byteLength(text);
      if (dataBytes > EXPORT_MAX_BYTES) throw exportTooLarge();
      writer.write(text);
      await writer.flush();
      await progress();
    };
    try {
      await store.db.sql.tx(async sql => {
        const account = await sql.get("SELECT * FROM users WHERE id=? AND deleted_at IS NULL", [userId]);
        if (!account) throw new ApiError(401, "unauthenticated", "Account is no longer active");
        await write(`{"account":${JSON.stringify(safe(account))},"tables":{`);
        let firstTable = true;
        for (const [table, query] of Object.entries(tenantQueries)) {
          await write(`${firstTable ? "" : ","}${JSON.stringify(table)}:[`);
          firstTable = false;
          let last: number | undefined, firstRow = true;
          while (true) {
            const rows = await sql.all(`${query.replace("SELECT *", "SELECT rowid AS _export_rowid,*")}${
              last === undefined ? "" : " AND rowid>?"} ORDER BY rowid LIMIT 16`,
            last === undefined ? [userId] : [userId, last]);
            for (const raw of rows) {
              const { _export_rowid, ...data } = ExportRowSchema.parse(raw);
              last = _export_rowid;
              const row = safe(data);
              if (table === "narrations" && typeof row["audio_file"] === "string") names.add(row["audio_file"]);
              await write(`${firstRow ? "" : ","}${JSON.stringify(row)}`);
              firstRow = false;
            }
            if (rows.length < 16) break;
          }
          await write("]");
        }
        await write("}}");
      });
    } finally { await writer.end(); }
    await chmod(dataPath, 0o600);
    const readmePath = join(root, "README.txt");
    await Bun.write(readmePath, readme);
    await chmod(readmePath, 0o600);
    async function* entries() {
      yield { name: "README.txt", file: Bun.file(readmePath) };
      yield { name: "data.json", file: Bun.file(dataPath) };
      let bytes = dataBytes + Buffer.byteLength(readme);
      for (const name of names) {
        signal.throwIfAborted();
        const stream = (await audio.read(userId, name)).pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
          async transform(chunk, controller) { await progress(); controller.enqueue(chunk); },
        }), { signal });
        await spoolAudio(stream, audioPath, EXPORT_MAX_BYTES - bytes, signal);
        const file = Bun.file(audioPath);
        bytes += file.size;
        yield { name: `audio/${name}`, file };
        await rm(audioPath);
      }
    }
    const archivePath = join(root, "account.tar.gz");
    await writeArchive(entries(), archivePath, signal);
    signal.throwIfAborted();
    await progress();
    // Track delivery here: a transform wrapper can acknowledge cancellation before cleanup.
    const file = Bun.file(archivePath), reader = file.stream().getReader();
    let ended = false, finished: Promise<void> | undefined;
    let abort: () => void;
    const finish = () => finished ??= (async () => {
      signal.removeEventListener("abort", abort);
      try { await reader.cancel(); } finally { await cleanup(); }
    })();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        abort = () => {
          ended = true;
          void finish().then(() => controller.error(signal.reason), error => controller.error(error));
        };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      },
      async pull(controller) {
        if (ended) return;
        try {
          const result = await reader.read();
          if (ended) return;
          if (result.done) { ended = true; await finish(); controller.close(); }
          else { await progress(); controller.enqueue(result.value); }
        } catch (error) { ended = true; await finish(); controller.error(error); }
      },
      async cancel() { ended = true; await finish(); },
    }, { highWaterMark: 0 });
    return new Response(body, { headers: {
      "Content-Type": "application/gzip", "Content-Length": String(file.size),
      "Content-Disposition": 'attachment; filename="floweredao-export.tar.gz"', "Cache-Control": "private, no-store",
    } });
  } catch (error) {
    await cleanup();
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, "account_export_unavailable", "Account export could not be completed");
  }
}

import { chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Store } from "./store";
import type { AudioStore } from "./audio-store";
import { DataRowSchema, tenantQueries } from "./tenant-data";
import { ApiError } from "./errors";
import { EXPORT_MAX_BYTES, exportResponse, exportTooLarge, spoolAudio, writeArchive } from "./export-archive";

const hidden = new Set(["token_hash", "hash", "csrf", "code_hash", "gemini_key_ct", "gemini_key_kek",
  "auth", "p256dh", "export_lease", "export_until"]);
const safe = (row: unknown) => Object.fromEntries(Object.entries(DataRowSchema.parse(row)).filter(([key]) => !hidden.has(key)));
// /tmp is memory-backed in Cloud Run: bound total instance scratch as well as each account.
let exporting = false;
const DURATION = 900000;

export async function accountExport(store: Store, audio: AudioStore, readme: string, requestSignal?: AbortSignal) {
  if (exporting) throw new ApiError(429, "account_export_busy", "An account export is already in progress");
  exporting = true;
  const userId = store.db.userId, lease = crypto.randomUUID();
  const signal = AbortSignal.any([AbortSignal.timeout(DURATION), ...(requestSignal ? [requestSignal] : [])]);
  let directory: string | undefined;
  const cleanup = async () => {
    try {
      await store.db.sql.run("UPDATE users SET export_lease=NULL,export_until=NULL WHERE id=? AND export_lease=?", [userId, lease]);
    } finally {
      try { if (directory) await rm(directory, { recursive: true, force: true }); }
      finally { exporting = false; }
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
          let offset = 0, firstRow = true;
          while (true) {
            const rows = await sql.all(`${query} LIMIT 16 OFFSET ?`, [userId, offset]);
            for (const raw of rows) {
              const row = safe(raw);
              if (table === "narrations" && typeof row["audio_file"] === "string") names.add(row["audio_file"]);
              await write(`${firstRow ? "" : ","}${JSON.stringify(row)}`);
              firstRow = false;
            }
            if (rows.length < 16) break;
            offset += rows.length;
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
        await spoolAudio(await audio.read(userId, name), audioPath, EXPORT_MAX_BYTES - bytes, signal);
        const file = Bun.file(audioPath);
        bytes += file.size;
        yield { name: `audio/${name}`, file };
        await rm(audioPath);
      }
    }
    const archivePath = join(root, "account.tar.gz");
    await writeArchive(entries(), archivePath, signal);
    signal.throwIfAborted();
    return exportResponse(Bun.file(archivePath), signal, cleanup);
  } catch (error) {
    await cleanup();
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, "account_export_unavailable", "Account export could not be completed");
  }
}

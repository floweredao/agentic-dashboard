import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { localAudioStore } from "./audio-store";
import type { NarrationOptions } from "./narration-types";
import type { createNarrationState } from "./narration-state";
import { ApiError } from "./errors";

export function narrationFiles(options: NarrationOptions, rows: ReturnType<typeof createNarrationState>) {
  const { store, audioDir } = options;
  const storage = options.audioStore ?? localAudioStore(audioDir);
  const userId = options.audioStore ? store.db.userId : "local";
  const removeFile = async (name: string | null) => { if (name) await storage.remove(userId, name); };
  return {
    storage, userId, removeFile,
    async audioFile(id: string) {
      const current = await rows.row(id);
      if (!current?.audio_file || !current.audio_mime || !await rows.audioPresent(current)) throw new ApiError(404, "not_found", "No narration audio for this record");
      return { path: await storage.url(userId, current.audio_file), mime: current.audio_mime, remote: storage.remote };
    },
    async prune() {
      const orphans = await store.db.all(`SELECT record_id, audio_file FROM narrations WHERE (record_id NOT IN (SELECT id FROM records WHERE records.user_id=narrations.user_id)
        AND record_id NOT IN (SELECT id FROM trash WHERE trash.user_id=narrations.user_id) AND status NOT IN ('queued','scripting','speaking')) AND user_id=?`, []);
      for (const value of orphans) {
        const orphan = z.object({ record_id: z.string(), audio_file: z.string().nullable() }).parse(value);
        if (await options.lookup?.(orphan.record_id)) continue;
        await removeFile(orphan.audio_file);
        await store.db.run("DELETE FROM narrations WHERE (record_id=?) AND user_id=?", [orphan.record_id]);
      }
      // Object storage is pruned from authoritative DB rows, never a local directory listing.
      if (storage.remote || !existsSync(audioDir)) return;
      const referenced = new Set((await store.db.all("SELECT audio_file FROM narrations WHERE (audio_file IS NOT NULL) AND user_id=?", []))
        .map(value => z.object({ audio_file: z.string() }).parse(value).audio_file));
      const working = new Set((await store.db.all("SELECT record_id FROM narrations WHERE (status IN ('queued','scripting','speaking')) AND user_id=?", []))
        .map(value => z.object({ record_id: z.string() }).parse(value).record_id));
      for (const name of readdirSync(audioDir)) {
        if (/^[0-9a-f-]{36}-[0-9a-f]{8}\.(?:m4a|wav)$/.test(name) && !referenced.has(name)) await removeFile(name);
        if (/^[0-9a-f-]{36}\.part\.(?:m4a|wav)$/.test(name) && !working.has(name.slice(0, 36))) rmSync(join(audioDir, name), { force: true });
      }
    },
  };
}

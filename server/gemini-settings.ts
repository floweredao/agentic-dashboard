import ky from "ky";
import { z } from "zod";
import type { Sql } from "./db";
import { createKeyCipher } from "./crypto";
import { ApiError } from "./errors";
import { GEMINI_KEY_SCRIPT_MODEL, GEMINI_TTS_MODEL } from "./gemini";

export interface GeminiKeyOptions {
  readonly kek: Readonly<Record<string, string>>;
  readonly validate?: (key: string) => Promise<{ readonly accepted: boolean; readonly models: readonly string[] }>;
  readonly model?: string;
  readonly selectedModels?: { readonly script: string; readonly speech: string };
}
async function accepted(key: string) {
  try {
    const response = await ky.get("https://generativelanguage.googleapis.com/v1beta/models",
      { searchParams: { pageSize: "1000" }, headers: { "x-goog-api-key": key }, timeout: 10000, retry: 0, throwHttpErrors: false });
    if (response.status !== 200) return { accepted: false, models: [] };
    const data = z.object({ models: z.array(z.object({ name: z.string() })).default([]) }).parse(await response.json());
    return { accepted: true, models: data.models.map(model => model.name.replace(/^models\//, "")) };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    throw new ApiError(503, "gemini_unavailable", "The key provider could not be reached. Try again.");
  }
}

/** Only encrypted values cross the users-table storage boundary; no key is cached between requests. */
export function createGeminiKeys(sql: Sql, options: GeminiKeyOptions) {
  const cipher = createKeyCipher(options.kek);
  const selectedModels = options.selectedModels ?? { script: GEMINI_KEY_SCRIPT_MODEL, speech: GEMINI_TTS_MODEL };
  const rowSchema = z.object({ gemini_key_ct: z.string().nullable(), gemini_key_kek: z.number().nullable() });
  async function keyFor(userId: string) {
    const raw = await sql.get("SELECT gemini_key_ct,gemini_key_kek FROM users WHERE id=? AND deleted_at IS NULL", [userId]);
    if (!raw) return null;
    const row = rowSchema.parse(raw);
    if (!row.gemini_key_ct) return null;
    if (!row.gemini_key_ct.startsWith(`v${row.gemini_key_kek}.`)) throw new ApiError(500, "key_ciphertext", "Stored encryption versions disagree");
    return cipher.decrypt(userId, row.gemini_key_ct);
  }
  async function status(userId: string) {
    const key = await keyFor(userId);
    return { configured: key !== null, last4: key?.slice(-4) ?? null };
  }
  return {
    keyFor, status, selectedModels,
    async require(userId: string) {
      if (!await keyFor(userId)) throw new ApiError(409, "gemini_key_required", "Add a Gemini key in Settings to generate audio.");
    },
    async save(userId: string, value: string) {
      const key = z.string().trim().min(1).max(512).parse(value);
      const validation = await (options.validate ?? accepted)(key);
      if (!validation.accepted) throw new ApiError(422, "gemini_key_invalid", "The Gemini key was not accepted.");
      const sealed = await cipher.encrypt(userId, key);
      const result = await sql.run("UPDATE users SET gemini_key_ct=?,gemini_key_kek=? WHERE id=? AND deleted_at IS NULL", [sealed.ciphertext, sealed.version, userId]);
      if (!result.changes) throw new ApiError(404, "not_found", "Account not found");
      return { configured: true, last4: key.slice(-4), modelAvailability: {
        script: { name: selectedModels.script, listed: validation.models.includes(selectedModels.script) },
        speech: { name: selectedModels.speech, listed: validation.models.includes(selectedModels.speech) },
      } };
    },
    async remove(userId: string) {
      await sql.run("UPDATE users SET gemini_key_ct=NULL,gemini_key_kek=NULL WHERE id=?", [userId]);
    },
    async rotateKek() {
      return sql.tx(async tx => {
        const rows = await tx.all("SELECT id,gemini_key_ct FROM users WHERE gemini_key_ct IS NOT NULL");
        for (const raw of rows) {
          const row = z.object({ id: z.string(), gemini_key_ct: z.string() }).parse(raw);
          const sealed = await cipher.encrypt(row.id, await cipher.decrypt(row.id, row.gemini_key_ct));
          await tx.run("UPDATE users SET gemini_key_ct=?,gemini_key_kek=? WHERE id=?", [sealed.ciphertext, sealed.version, row.id]);
        }
        return rows.length;
      });
    },
  };
}
export type GeminiKeys = ReturnType<typeof createGeminiKeys>;

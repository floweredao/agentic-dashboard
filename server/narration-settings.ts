import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { NarrationAutoSchema, NarrationVoicesSchema } from "../shared/contracts";
import type { NarrationAuto, NarrationVoiceSettings, NarrationVoices } from "../shared/contracts";
import { KOREAN_VOICES } from "../shared/voices";
import { ApiError } from "./errors";
import { ProviderError, type NarrationOptions } from "./narration-types";
import { SPEECH_STYLE, previewText, PODCAST_STYLE } from "./narration-prompts";
import { wav, afconvert } from "./narration-audio";
export function createNarrationSettings(options: NarrationOptions) {
  const { store, provider, audioDir } = options;
  const now = () => new Date(store.now()).toISOString();
  const available = async () => provider !== null && await provider.available();
  const encode = options.encode ?? afconvert;
  const timeoutMs = options.timeoutMs ?? 180_000;


  /** Settings › Automatic audio: the saved choice, else the server's defaults. */
  async function autoSettings(): Promise<NarrationAuto> {
    const defaults: NarrationAuto = { digests: "off", records: "off", scope: "full", ...options.autoDefaults };
    const value = (await store.db.get("SELECT data FROM narration_auto WHERE (id=1) AND user_id=?", []));
    if (!value) return defaults;
    const parsed = NarrationAutoSchema.safeParse(JSON.parse(z.object({ data: z.string() }).parse(value).data));
    return parsed.success ? parsed.data : defaults;
  }

  async function saveAuto(input: unknown): Promise<NarrationAuto> {
    const parsed = NarrationAutoSchema.safeParse(input);
    if (!parsed.success) throw new ApiError(400, "invalid_input", parsed.error.issues.map(issue => issue.message).join("; "));
    (await store.db.run("INSERT INTO narration_auto(id,data,updated_at,user_id) VALUES(1,?,?,?) ON CONFLICT(user_id,id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at", [JSON.stringify(parsed.data), now()]));
    return parsed.data;
  }

  /** The provider's voices and the built-in speaking styles; what narration uses until the owner saves a choice. */
  function voiceDefaults(): NarrationVoices {
    if (!provider) throw new ApiError(503, "narration_unavailable", "No TTS key is configured on the dashboard server");
    return { readVoice: provider.voice, hostA: provider.hosts[0], hostB: provider.hosts[1], readStyle: SPEECH_STYLE, podcastStyle: PODCAST_STYLE };
  }

  /** The Korean voice list, then the provider's own voices it does not name (their gender unknown). */
  function voiceChoices(): NarrationVoiceSettings["voices"] {
    const listed = KOREAN_VOICES.map(voice => ({ ...voice }));
    const own = provider ? [...new Set([provider.voice, ...provider.hosts])].filter(id => !listed.some(voice => voice.id === id)) : [];
    return [...listed, ...own.map(id => ({ id, name: id, gender: "neutral" as const, pitch: null }))];
  }

  /** The saved choice, or the defaults when none is saved or a saved voice is no longer offered. */
  async function voiceSettings(): Promise<NarrationVoices> {
    const defaults = voiceDefaults();
    const value = (await store.db.get("SELECT data FROM narration_settings WHERE (id=1) AND user_id=?", []));
    if (!value) return defaults;
    const parsed = NarrationVoicesSchema.safeParse(JSON.parse(z.object({ data: z.string() }).parse(value).data));
    const ids = new Set(voiceChoices().map(voice => voice.id));
    if (!parsed.success || ![parsed.data.readVoice, parsed.data.hostA, parsed.data.hostB].every(id => ids.has(id))) return defaults;
    return parsed.data;
  }

  const voiceView = async (): Promise<NarrationVoiceSettings> => ({ settings: (await voiceSettings()), defaults: voiceDefaults(), voices: voiceChoices() });

  /** Saves the owner's choice for the next narrations; audio already made keeps its voice. */
  async function saveVoices(input: unknown): Promise<NarrationVoiceSettings> {
    const parsed = NarrationVoicesSchema.safeParse(input);
    if (!parsed.success) throw new ApiError(400, "invalid_input", parsed.error.issues.map(issue => issue.message).join("; "));
    const ids = new Set(voiceChoices().map(voice => voice.id));
    const unknown = [parsed.data.readVoice, parsed.data.hostA, parsed.data.hostB].filter(id => !ids.has(id));
    if (unknown.length > 0) throw new ApiError(400, "invalid_voice", `Not an offered voice: ${unknown.join(", ")}`);
    (await store.db.run("INSERT INTO narration_settings(id,data,updated_at,user_id) VALUES(1,?,?,?) ON CONFLICT(user_id,id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at", [JSON.stringify(parsed.data), now()]));
    return (await voiceView());
  }

  const previewDir = join(audioDir, "previews");

  const previews = new Map<string, Promise<{ path: string; mime: string }>>();

  /**
   * A short sample of `voice` in the read-aloud style, spoken once (a few seconds of audio, a paid call) and then served from
   * `audio/previews/`; concurrent requests for one voice share the call.
   */
  function preview(voice: string): Promise<{ path: string; mime: string }> {
    if (!voiceChoices().some(choice => choice.id === voice)) throw new ApiError(404, "not_found", "No such voice");
    for (const [extension, mime] of [["m4a", "audio/mp4"], ["wav", "audio/wav"]] as const) {
      const path = join(previewDir, `${voice}.${extension}`);
      if (existsSync(path)) return Promise.resolve({ path, mime });
    }
    const pending = previews.get(voice);
    if (pending) return pending;
    const made = (async () => {
      if (!provider || !await available()) throw new ApiError(503, "narration_unavailable", "No TTS key is configured on the dashboard server");
      let pcm: Uint8Array;
      try { pcm = await provider.speak(previewText(voice), (await voiceSettings()).readStyle, AbortSignal.timeout(timeoutMs), voice); }
      catch (error) {
        if (error instanceof ProviderError) throw new ApiError(502, "narration_preview_failed", `The voice sample could not be made (${error.code})`);
        throw error;
      }
      mkdirSync(previewDir, { recursive: true, mode: 0o700 });
      const part = join(previewDir, `${voice}.wav`);
      writeFileSync(part, wav(pcm), { mode: 0o600 });
      const encoded = await encode(part, AbortSignal.timeout(timeoutMs));
      chmodSync(encoded.path, 0o600);
      return encoded;
    })().finally(() => previews.delete(voice));
    previews.set(voice, made);
    return made;
  }
  return { autoSettings, saveAuto, voiceSettings, voices: voiceView, saveVoices, preview };
}

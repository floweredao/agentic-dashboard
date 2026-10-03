import { z } from "zod";
import { ProviderError } from "./narration";
import type { NarrationProvider } from "./narration";

/** Gemini 3.8 Flash TTS (stable): https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash-tts */
export const GEMINI_TTS_MODEL = "gemini-3.8-flash-tts";
export const GEMINI_SCRIPT_MODEL = "gemini-3.8-flash";
export const GEMINI_VOICE = "Kore";
/** Podcast host B, a prebuilt voice that is easy to tell apart from host A; multi-speaker requests take at most two prebuilt voices. */
export const GEMINI_PODCAST_VOICE = "Puck";
const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";
export type KeySource = () => Promise<string | null>;

/** The key from an environment variable (GEMINI_API_KEY by default); narration stays unavailable while it is unset. */
export function envKey(name = "GEMINI_API_KEY", env: Record<string, string | undefined> = process.env): KeySource {
  return async () => env[name]?.trim() || null;
}

const responseSchema = z.object({
  steps: z.array(z.object({
    type: z.string(),
    content: z.array(z.object({ type: z.string(), text: z.string().optional(), data: z.string().optional() }).passthrough()).optional(),
  }).passthrough()),
}).passthrough();

/** Strips a RIFF/WAVE header when the API answers WAV instead of the requested raw PCM. */
export function pcmOf(bytes: Uint8Array): Uint8Array {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.byteLength < 12 || view.toString("ascii", 0, 4) !== "RIFF" || view.toString("ascii", 8, 12) !== "WAVE") return bytes;
  for (let offset = 12; offset + 8 <= view.byteLength;) {
    const size = view.readUInt32LE(offset + 4);
    if (view.toString("ascii", offset, offset + 4) === "data") return bytes.subarray(offset + 8, Math.min(view.byteLength, offset + 8 + size));
    offset += 8 + size + (size % 2);
  }
  throw new ProviderError("invalid_audio", false);
}

/** Interactions API with `store: false`; the key goes only in the x-goog-api-key header and never into errors. */
export function geminiProvider(options: {
  readonly key: KeySource; readonly ttsModel?: string; readonly scriptModel?: string; readonly voice?: string; readonly podcastVoice?: string;
  readonly fetch?: (input: string, init: RequestInit) => Promise<Response>;
}): NarrationProvider {
  const send = options.fetch ?? ((input: string, init: RequestInit) => fetch(input, init));
  const ttsModel = options.ttsModel ?? GEMINI_TTS_MODEL;
  const scriptModel = options.scriptModel ?? GEMINI_SCRIPT_MODEL;
  const voice = options.voice ?? GEMINI_VOICE;
  const hosts = [voice, options.podcastVoice ?? GEMINI_PODCAST_VOICE] as const;
  async function output(body: unknown, signal: AbortSignal) {
    const key = await options.key();
    if (!key) throw new ProviderError("no_key", false);
    let response: Response;
    try {
      response = await send(ENDPOINT, { method: "POST", signal, body: JSON.stringify(body),
        headers: { "content-type": "application/json", "x-goog-api-key": key } });
    } catch (error) {
      if (signal.aborted) throw new ProviderError("timeout", true);
      if (error instanceof Error) throw new ProviderError("network", true);
      throw error;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ProviderError(`http_${response.status}`, response.status === 429 || response.status >= 500);
    }
    let json: unknown;
    try { json = await response.json(); }
    catch (error) {
      if (error instanceof Error) throw new ProviderError("invalid_response", false);
      throw error;
    }
    const parsed = responseSchema.safeParse(json);
    if (!parsed.success) throw new ProviderError("invalid_response", false);
    return parsed.data.steps.filter(step => step.type === "model_output").flatMap(step => step.content ?? []);
  }
  async function audioOf(input: unknown, speechConfig: unknown, signal: AbortSignal) {
    const content = await output({
      model: ttsModel, input,
      response_format: { type: "audio", mime_type: "audio/l16", sample_rate: 24000 },
      generation_config: { speech_config: speechConfig },
      store: false,
    }, signal);
    const audio = content.filter(part => part.type === "audio" && part.data).at(-1)?.data;
    if (!audio) throw new ProviderError("no_audio", false);
    return pcmOf(Buffer.from(audio, "base64"));
  }
  return {
    ttsModel, scriptModel, voice, hosts,
    available: async () => await options.key() !== null,
    async script(system, prompt, signal) {
      const content = await output({ model: scriptModel, system_instruction: system, input: prompt, store: false }, signal);
      const script = content.filter(part => part.type === "text").map(part => part.text ?? "").join("");
      if (!script.trim()) throw new ProviderError("empty_script", false);
      return script;
    },
    speak: (text, style, signal) => audioOf(
      [{ type: "user_input", content: [{ type: "text", text, annotations: [{ type: "speech_metadata", style }] }] }],
      [{ voice }], signal),
    // https://ai.google.dev/gemini-api/docs/speech-generation#multi-speaker: speakers as an object, every turn names its speaker.
    converse: (turns, style, signal) => audioOf(
      [{ type: "user_input", content: turns.map(turn => ({ type: "text", text: turn.text,
        annotations: [{ type: "speech_metadata", speaker: turn.speaker, style }] })) }],
      { mode: "conversational", speakers: [{ speaker: "A", voice: hosts[0] }, { speaker: "B", voice: hosts[1] }] }, signal),
  };
}

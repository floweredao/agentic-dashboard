import { z } from "zod";
import { ProviderError } from "./narration";
import type { NarrationProvider } from "./narration";

/** Gemini 3.8 Flash TTS (stable): https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash-tts */
export const GEMINI_TTS_MODEL = "gemini-3.8-flash-tts";
export const GEMINI_SCRIPT_MODEL = "gemini-3.8-flash";
/**
 * Writes the script when the script model stays overloaded (503 "high demand") or its free daily quota is used up: a stable
 * model on the free tier with its own per-model quota (https://ai.google.dev/gemini-api/docs/models, /pricing).
 */
export const GEMINI_SCRIPT_FALLBACK_MODEL = "gemini-3.5-flash-lite";
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

/** The parts of a Google error body that say how long to wait and which quota was hit; messages are never kept. */
const errorSchema = z.object({ error: z.object({
  details: z.array(z.object({
    retryDelay: z.string().optional(),
    violations: z.array(z.object({ quotaId: z.string().optional() }).passthrough()).optional(),
  }).passthrough()).optional(),
}).passthrough() }).passthrough();
const SECONDS = /^(\d+(?:\.\d+)?)s$/;

/**
 * A failed response as a code. 429/408/5xx are transient and carry the wait Google asked for (RetryInfo `retryDelay`, else
 * Retry-After); a 429 on a per-day quota (quotaId `...PerDay...`, e.g. the free tier's requests per day) is `quota_daily`,
 * which no retry fixes until the quota resets (https://ai.google.dev/gemini-api/docs/rate-limits).
 */
export async function failureOf(response: Response): Promise<ProviderError> {
  const status = response.status;
  let details: z.infer<typeof errorSchema>["error"]["details"] = [];
  try {
    const parsed = errorSchema.safeParse(JSON.parse(await response.text()));
    if (parsed.success) details = parsed.data.error.details ?? [];
  } catch (error) {
    if (!(error instanceof Error)) throw error;
  }
  if (status === 429 && details.some(detail => detail.violations?.some(violation => /PerDay/i.test(violation.quotaId ?? "")))) {
    return new ProviderError("quota_daily", false);
  }
  const transient = status === 429 || status === 408 || status >= 500;
  if (!transient) return new ProviderError(`http_${status}`, false);
  const delay = details.map(detail => SECONDS.exec(detail.retryDelay ?? "")).find(match => match !== null);
  const header = response.headers.get("retry-after");
  const retryAfterMs = delay ? Math.round(Number(delay[1]) * 1000)
    : header !== null && /^\d+$/.test(header.trim()) ? Number(header.trim()) * 1000 : undefined;
  return new ProviderError(`http_${status}`, true, retryAfterMs);
}

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
  readonly key: KeySource; readonly ttsModel?: string; readonly scriptModel?: string; readonly fallbackScriptModel?: string;
  readonly voice?: string; readonly podcastVoice?: string;
  readonly fetch?: (input: string, init: RequestInit) => Promise<Response>;
}): NarrationProvider {
  const send = options.fetch ?? ((input: string, init: RequestInit) => fetch(input, init));
  const ttsModel = options.ttsModel ?? GEMINI_TTS_MODEL;
  const scriptModel = options.scriptModel ?? GEMINI_SCRIPT_MODEL;
  const fallbackScriptModel = options.fallbackScriptModel ?? GEMINI_SCRIPT_FALLBACK_MODEL;
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
    if (!response.ok) throw await failureOf(response);
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
    ttsModel, scriptModel, fallbackScriptModel, voice, hosts,
    available: async () => await options.key() !== null,
    async script(system, prompt, signal, model = scriptModel) {
      const content = await output({ model, system_instruction: system, input: prompt, store: false }, signal);
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

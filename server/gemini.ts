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

/** One server-sent event of a streamed interaction (https://ai.google.dev/gemini-api/docs/interactions/streaming). */
const streamEventSchema = z.object({
  event_type: z.string(), index: z.number().optional(),
  step: z.object({ type: z.string() }).passthrough().optional(),
  delta: z.object({ type: z.string(), text: z.string().optional() }).passthrough().optional(),
}).passthrough();

/**
 * The model output's text from a streamed interaction, reporting the characters received after each text delta. An `error`
 * event, or a stream that ends before `interaction.completed`, is a dropped connection and worth a retry.
 */
async function streamedText(body: ReadableStream<Uint8Array>, signal: AbortSignal, onText?: (chars: number) => void) {
  const decoder = new TextDecoder();
  const stepTypes = new Map<number, string>();
  let buffer = "";
  let text = "";
  let completed = false;
  const take = (block: string) => {
    const data = block.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") return;
    let parsed: z.infer<typeof streamEventSchema>;
    try { parsed = streamEventSchema.parse(JSON.parse(data)); }
    catch (error) {
      if (error instanceof Error) throw new ProviderError("invalid_response", false);
      throw error;
    }
    if (parsed.event_type === "error") throw new ProviderError("network", true);
    if (parsed.event_type === "interaction.completed") completed = true;
    if (parsed.event_type === "step.start" && parsed.index !== undefined && parsed.step) stepTypes.set(parsed.index, parsed.step.type);
    const output = parsed.index === undefined || (stepTypes.get(parsed.index) ?? "model_output") === "model_output";
    if (parsed.event_type === "step.delta" && output && parsed.delta?.type === "text" && parsed.delta.text) {
      text += parsed.delta.text;
      onText?.(text.length);
    }
  };
  try {
    const reader = body.getReader();
    for (let read = await reader.read(); !read.done; read = await reader.read()) {
      buffer += decoder.decode(read.value, { stream: true });
      for (let end = buffer.search(/\r?\n\r?\n/); end >= 0; end = buffer.search(/\r?\n\r?\n/)) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end).replace(/^\r?\n\r?\n/, "");
        take(block);
      }
    }
    buffer += decoder.decode();
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if (signal.aborted) throw new ProviderError("timeout", true);
    if (error instanceof Error) throw new ProviderError("network", true);
    throw error;
  }
  if (buffer.trim()) take(buffer);
  if (!completed) throw new ProviderError("network", true);
  return text;
}

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
  async function post(body: unknown, signal: AbortSignal) {
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
    return response;
  }
  async function contentOf(response: Response) {
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
    const content = await contentOf(await post({
      model: ttsModel, input,
      response_format: { type: "audio", mime_type: "audio/l16", sample_rate: 24000 },
      generation_config: { speech_config: speechConfig },
      store: false,
    }, signal));
    const audio = content.filter(part => part.type === "audio" && part.data).at(-1)?.data;
    if (!audio) throw new ProviderError("no_audio", false);
    return pcmOf(Buffer.from(audio, "base64"));
  }
  return {
    ttsModel, scriptModel, fallbackScriptModel, voice, hosts,
    available: async () => await options.key() !== null,
    // Streamed, so the job can report the script's characters as they arrive; a plain JSON answer is read whole.
    async script(system, prompt, signal, model = scriptModel, onText) {
      const response = await post({ model, system_instruction: system, input: prompt, stream: true, store: false }, signal);
      const streamed = response.body !== null && (response.headers.get("content-type") ?? "").includes("text/event-stream");
      const script = streamed && response.body ? await streamedText(response.body, signal, onText)
        : (await contentOf(response)).filter(part => part.type === "text").map(part => part.text ?? "").join("");
      if (!streamed) onText?.(script.length);
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

import { z } from "zod";
import { ProviderError } from "./narration";
import type { NarrationProvider } from "./narration";
import { VERTEX_LOCATION } from "./vertex";
import type { AdcSource } from "./vertex";

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
async function streamedText(body: ReadableStream<Uint8Array>, signal: AbortSignal, idleMs: number, stop: () => void, onText?: (chars: number) => void) {
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
    // A stream that goes quiet for `idleMs` is a stuck model: the connection is dropped and the call fails as `stalled`.
    const next = () => new Promise<Awaited<ReturnType<typeof reader.read>>>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new ProviderError("stalled", true));
        stop();
        reader.cancel().catch(() => undefined);
      }, idleMs);
      reader.read().then(read => { clearTimeout(timer); resolve(read); }, (error: unknown) => { clearTimeout(timer); reject(error); });
    });
    for (let read = await next(); !read.done; read = await next()) {
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
  // A used-up daily quota can answer 429 with a Retry-After of hours and no quota details; a wait that long is the day's quota.
  if (status === 429 && retryAfterMs !== undefined && retryAfterMs >= DAILY_WAIT_MS) return new ProviderError("quota_daily", false);
  return new ProviderError(`http_${status}`, true, retryAfterMs);
}
const DAILY_WAIT_MS = 60 * 60 * 1000;
/**
 * How long a script call may wait for the response to start, and then for the next piece of its stream. A streamed answer starts
 * within about a second; on 2026-10-07 gemini-3.8-flash sent nothing for minutes, so each try sat out the whole call timeout.
 */
export const SCRIPT_FIRST_BYTE_MS = 30_000;
export const SCRIPT_IDLE_MS = 90_000;

const vertexErrorSchema = z.object({ error: z.object({
  details: z.array(z.object({ reason: z.string().optional() }).passthrough()).optional(),
}).passthrough() }).passthrough();

/**
 * A failed Vertex AI response as a code the failure alert can explain: 401, or a 403 other than a switched-off API or billing,
 * is the ADC login (`vertex_auth`); ErrorInfo SERVICE_DISABLED / BILLING_DISABLED is `vertex_disabled`; 429 is the project's
 * Vertex quota (`vertex_quota`), retried after the wait it asks for. Anything else reads like the AI Studio failures.
 */
export async function vertexFailureOf(response: Response): Promise<ProviderError> {
  const status = response.status;
  if (status === 429) {
    const failure = await failureOf(response);
    return new ProviderError("vertex_quota", true, failure.retryAfterMs);
  }
  if (status !== 401 && status !== 403) return failureOf(response);
  let reasons: string[] = [];
  try {
    const parsed = vertexErrorSchema.safeParse(JSON.parse(await response.text()));
    if (parsed.success) reasons = (parsed.data.error.details ?? []).map(detail => detail.reason ?? "");
  } catch (error) {
    if (!(error instanceof Error)) throw error;
  }
  if (status === 403 && reasons.some(reason => reason === "SERVICE_DISABLED" || reason === "BILLING_DISABLED")) {
    return new ProviderError("vertex_disabled", false);
  }
  return new ProviderError("vertex_auth", false);
}

const vertexResponseSchema = z.object({
  candidates: z.array(z.object({ content: z.object({ parts: z.array(z.object({
    inlineData: z.object({ mimeType: z.string().optional(), data: z.string() }).passthrough().optional(),
  }).passthrough()).optional() }).passthrough().optional() }).passthrough()).optional(),
  usageMetadata: z.object({ candidatesTokenCount: z.number().optional() }).passthrough().optional(),
}).passthrough();

/** Speech through Vertex AI (billed to the Google Cloud project) instead of the AI Studio key; the script stays on the key. */
export interface VertexSpeech {
  readonly project: string;
  readonly location?: string;
  readonly credentials: AdcSource;
  /** One line per call: host, model, location, status and audio tokens (25 per second of audio), never a token. */
  readonly log?: (line: string) => void;
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
  readonly voice?: string; readonly podcastVoice?: string; readonly vertex?: VertexSpeech;
  readonly fetch?: (input: string, init: RequestInit) => Promise<Response>;
  /** Script calls only: the wait for the response to start and the longest quiet gap in its stream before it fails as `stalled`. */
  readonly firstByteMs?: number; readonly idleMs?: number;
}): NarrationProvider {
  const send = options.fetch ?? ((input: string, init: RequestInit) => fetch(input, init));
  const ttsModel = options.ttsModel ?? GEMINI_TTS_MODEL;
  const scriptModel = options.scriptModel ?? GEMINI_SCRIPT_MODEL;
  const fallbackScriptModel = options.fallbackScriptModel ?? GEMINI_SCRIPT_FALLBACK_MODEL;
  const voice = options.voice ?? GEMINI_VOICE;
  const hosts = [voice, options.podcastVoice ?? GEMINI_PODCAST_VOICE] as const;
  const firstByteMs = options.firstByteMs ?? SCRIPT_FIRST_BYTE_MS;
  const idleMs = options.idleMs ?? SCRIPT_IDLE_MS;
  /** `stall` aborts the request early when the response has not started by then (script calls; speech may take longer). */
  async function post(body: unknown, signal: AbortSignal, stall?: { readonly ms: number; readonly controller: AbortController }) {
    const key = await options.key();
    if (!key) throw new ProviderError("no_key", false);
    let response: Response;
    const timer = stall ? setTimeout(() => stall.controller.abort(), stall.ms) : undefined;
    try {
      response = await send(ENDPOINT, { method: "POST", signal: stall ? AbortSignal.any([signal, stall.controller.signal]) : signal,
        body: JSON.stringify(body), headers: { "content-type": "application/json", "x-goog-api-key": key } });
    } catch (error) {
      if (signal.aborted) throw new ProviderError("timeout", true);
      if (stall?.controller.signal.aborted) throw new ProviderError("stalled", true);
      if (error instanceof Error) throw new ProviderError("network", true);
      throw error;
    } finally {
      clearTimeout(timer);
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
  // https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/text-to-speech/overview: generateContent, turn styling in
  // parts[].speechMetadata, unary answers a whole WAV.
  async function vertexAudioOf(vertex: VertexSpeech, parts: unknown[], speechConfig: unknown, signal: AbortSignal) {
    const location = vertex.location ?? VERTEX_LOCATION;
    const host = location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
    const url = `https://${host}/v1/projects/${vertex.project}/locations/${location}/publishers/google/models/${ttsModel}:generateContent`;
    const token = await vertex.credentials.token(signal);
    let response: Response;
    try {
      response = await send(url, { method: "POST", signal, headers: { "content-type": "application/json",
        authorization: `Bearer ${token}`, "x-goog-user-project": vertex.project },
      body: JSON.stringify({ contents: [{ role: "user", parts }],
        generationConfig: { responseModalities: ["AUDIO"], speechConfig } }) });
    } catch (error) {
      if (signal.aborted) throw new ProviderError("timeout", true);
      if (error instanceof Error) throw new ProviderError("network", true);
      throw error;
    }
    if (!response.ok) {
      (vertex.log ?? console.log)(`narration tts: ${host} ${ttsModel} ${location} ${response.status}`);
      throw await vertexFailureOf(response);
    }
    let json: unknown;
    try { json = await response.json(); }
    catch (error) {
      if (error instanceof Error) throw new ProviderError("invalid_response", false);
      throw error;
    }
    const parsed = vertexResponseSchema.safeParse(json);
    if (!parsed.success) throw new ProviderError("invalid_response", false);
    const tokens = parsed.data.usageMetadata?.candidatesTokenCount ?? 0;
    (vertex.log ?? console.log)(`narration tts: ${host} ${ttsModel} ${location} ${response.status} audio_tokens=${tokens}`);
    const audio = (parsed.data.candidates ?? []).flatMap(candidate => candidate.content?.parts ?? [])
      .filter(part => part.inlineData?.data).at(-1)?.inlineData?.data;
    if (!audio) throw new ProviderError("no_audio", false);
    return pcmOf(Buffer.from(audio, "base64"));
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
    available: async () => await options.key() !== null && (!options.vertex || await options.vertex.credentials.exists()),
    // Streamed, so the job can report the script's characters as they arrive; a plain JSON answer is read whole.
    async script(system, prompt, signal, model = scriptModel, onText) {
      const controller = new AbortController();
      const response = await post({ model, system_instruction: system, input: prompt, stream: true, store: false }, signal, { ms: firstByteMs, controller });
      const streamed = response.body !== null && (response.headers.get("content-type") ?? "").includes("text/event-stream");
      const script = streamed && response.body ? await streamedText(response.body, signal, idleMs, () => controller.abort(), onText)
        : (await contentOf(response)).filter(part => part.type === "text").map(part => part.text ?? "").join("");
      if (!streamed) onText?.(script.length);
      if (!script.trim()) throw new ProviderError("empty_script", false);
      return script;
    },
    speak: (text, style, signal, chosen = voice) => options.vertex
      ? vertexAudioOf(options.vertex, [{ text, speechMetadata: { style } }], { voiceConfig: { voice: chosen } }, signal)
      : audioOf([{ type: "user_input", content: [{ type: "text", text, annotations: [{ type: "speech_metadata", style }] }] }],
        [{ voice: chosen }], signal),
    // https://ai.google.dev/gemini-api/docs/speech-generation#multi-speaker: speakers as an object, every turn names its speaker.
    converse: (turns, style, signal, [hostA, hostB] = hosts) => options.vertex
      ? vertexAudioOf(options.vertex, turns.map(turn => ({ text: turn.text, speechMetadata: { speaker: turn.speaker, style } })),
        { multiSpeakerVoiceConfig: { speakerVoiceConfigs: [
          { speaker: "A", voiceConfig: { voice: hostA } }, { speaker: "B", voiceConfig: { voice: hostB } }] } }, signal)
      : audioOf(
      [{ type: "user_input", content: turns.map(turn => ({ type: "text", text: turn.text,
        annotations: [{ type: "speech_metadata", speaker: turn.speaker, style }] })) }],
      { mode: "conversational", speakers: [{ speaker: "A", voice: hostA }, { speaker: "B", voice: hostB }] }, signal),
  };
}

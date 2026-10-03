import { expect, test } from "bun:test";
import { z } from "zod";
import { geminiProvider, pcmOf } from "../server/gemini";
import { ProviderError } from "../server/narration";

const KEY = "AIza-test-key";
type Sent = { url: string; headers: Headers; body: unknown };
function provider(reply: () => Response) {
  const sent: Sent[] = [];
  const gemini = geminiProvider({ key: async () => KEY, fetch: async (url, init) => {
    sent.push({ url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
    return reply();
  } });
  return { gemini, sent };
}
const steps = (content: unknown[]) => Response.json({ id: "i", steps: [{ type: "user_input", content: [] }, { type: "model_output", content }] });
const signal = () => AbortSignal.timeout(5000);

test("speech requests raw PCM with the voice and style as metadata, and returns the decoded audio", async () => {
  const pcm = new Uint8Array([1, 2, 3, 4]);
  const { gemini, sent } = provider(() => steps([{ type: "audio", data: Buffer.from(pcm).toString("base64"), mime_type: "audio/l16" }]));
  expect(await gemini.speak("안녕하세요.", "차분하게", signal())).toEqual(pcm);
  expect(sent[0]?.url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
  expect(sent[0]?.headers.get("x-goog-api-key")).toBe(KEY);
  expect(sent[0]?.body).toEqual({
    model: "gemini-3.8-flash-tts",
    input: [{ type: "user_input", content: [{ type: "text", text: "안녕하세요.", annotations: [{ type: "speech_metadata", style: "차분하게" }] }] }],
    response_format: { type: "audio", mime_type: "audio/l16", sample_rate: 24000 },
    generation_config: { speech_config: [{ voice: "Kore" }] },
    store: false,
  });
});

test("a dialogue is one conversational request with each turn tagged by speaker and the two hosts' voices", async () => {
  const pcm = new Uint8Array([5, 6]);
  const { gemini, sent } = provider(() => steps([{ type: "audio", data: Buffer.from(pcm).toString("base64") }]));
  expect(gemini.hosts).toEqual(["Kore", "Puck"]);
  expect(await gemini.converse([{ speaker: "A", text: "Hello." }, { speaker: "B", text: "Hi there." }], "relaxed", signal())).toEqual(pcm);
  expect(sent[0]?.body).toEqual({
    model: "gemini-3.8-flash-tts",
    input: [{ type: "user_input", content: [
      { type: "text", text: "Hello.", annotations: [{ type: "speech_metadata", speaker: "A", style: "relaxed" }] },
      { type: "text", text: "Hi there.", annotations: [{ type: "speech_metadata", speaker: "B", style: "relaxed" }] },
    ] }],
    response_format: { type: "audio", mime_type: "audio/l16", sample_rate: 24000 },
    generation_config: { speech_config: { mode: "conversational", speakers: [
      { speaker: "A", voice: "Kore" }, { speaker: "B", voice: "Puck" },
    ] } },
    store: false,
  });
});

test("the podcast host voices are configuration", () => {
  const custom = geminiProvider({ key: async () => KEY, voice: "Charon", podcastVoice: "Aoede" });
  expect(custom.hosts).toEqual(["Charon", "Aoede"]);
});

test("the script call sends the system instruction and joins the model's text output", async () => {
  const { gemini, sent } = provider(() => steps([{ type: "thought", text: "x" }, { type: "text", text: "첫 문장. " }, { type: "text", text: "둘째 문장." }]));
  expect(await gemini.script("규칙", "[기록]", signal())).toBe("첫 문장. 둘째 문장.");
  expect(z.object({ model: z.string(), system_instruction: z.string(), store: z.boolean() }).passthrough().parse(sent[0]?.body))
    .toMatchObject({ model: "gemini-3.8-flash", system_instruction: "규칙", input: "[기록]", store: false });
});

test("HTTP failures become codes: 429 and 5xx are transient, and the key never appears in the error", async () => {
  for (const [status, transient] of [[429, true], [503, true], [400, false], [402, false], [403, false]] as const) {
    const { gemini } = provider(() => new Response(`{"error":"bad key ${KEY}"}`, { status }));
    const error = await gemini.speak("가", "", signal()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ code: `http_${status}`, transient });
    expect(String(error instanceof Error ? error.message : error)).not.toContain(KEY);
  }
  const empty = provider(() => steps([{ type: "text", text: "" }]));
  expect(await empty.gemini.speak("가", "", signal()).catch((caught: unknown) => caught)).toMatchObject({ code: "no_audio" });
});

const quota = (quotaId: string, retryDelay?: string) => Response.json({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: `Quota exceeded ${KEY}`, details: [
  { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaMetric: "generativelanguage.googleapis.com/generate_requests", quotaId }] },
  ...(retryDelay ? [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay }] : []),
] } }, { status: 429 });

test("a 429 says how long to wait: RetryInfo or Retry-After; a used-up daily free quota is its own, final code", async () => {
  // Given: a per-minute quota with a RetryInfo delay, a bare 429 with Retry-After, a daily quota, and an overloaded 503.
  const answers: [string, () => Response][] = [
    ["minute", () => quota("GenerateRequestsPerMinutePerProjectPerModel-FreeTier", "17.4s")],
    ["header", () => new Response("busy", { status: 429, headers: { "retry-after": "5" } })],
    ["daily", () => quota("GenerateRequestsPerDayPerProjectPerModel-FreeTier", "40s")],
    ["busy", () => Response.json({ error: { code: 503, status: "UNAVAILABLE", message: "This model is currently experiencing high demand." } }, { status: 503 })],
  ];
  const errors: Record<string, unknown> = {};
  for (const [name, reply] of answers) errors[name] = await provider(reply).gemini.script("", "", signal()).catch((caught: unknown) => caught);
  // Then: the waits come through in milliseconds, the daily quota is not retried, and no message text (or key) is kept.
  expect(errors.minute).toMatchObject({ code: "http_429", transient: true, retryAfterMs: 17400 });
  expect(errors.header).toMatchObject({ code: "http_429", transient: true, retryAfterMs: 5000 });
  expect(errors.daily).toMatchObject({ code: "quota_daily", transient: false });
  expect(errors.busy).toMatchObject({ code: "http_503", transient: true });
  for (const error of Object.values(errors)) {
    expect(error).toBeInstanceOf(ProviderError);
    expect(String(error instanceof Error ? error.message : error)).not.toContain(KEY);
  }
});

test("a script can be asked of another model, and the provider names its lighter fallback", async () => {
  const { gemini, sent } = provider(() => steps([{ type: "text", text: "Script" }]));
  expect(gemini.fallbackScriptModel).toBe("gemini-3.5-flash-lite");
  await gemini.script("Rules", "[Record]", signal(), "gemini-3.5-flash-lite");
  expect(sent[0]?.body).toMatchObject({ model: "gemini-3.5-flash-lite" });
});

test("no key means unavailable and no request", async () => {
  let calls = 0;
  const gemini = geminiProvider({ key: async () => null, fetch: async () => { calls += 1; return new Response("{}"); } });
  expect(await gemini.available()).toBe(false);
  expect(await gemini.script("", "", signal()).catch((caught: unknown) => caught)).toMatchObject({ code: "no_key" });
  expect(calls).toBe(0);
});

test("a WAV answer is reduced to its PCM data chunk", () => {
  const pcm = Buffer.from([9, 8, 7, 6]);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + pcm.byteLength, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.write("data", 36); header.writeUInt32LE(pcm.byteLength, 40);
  expect(Buffer.from(pcmOf(Buffer.concat([header, pcm])))).toEqual(pcm);
  expect(pcmOf(pcm)).toBe(pcm);
});

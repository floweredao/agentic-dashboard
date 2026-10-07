import { expect, test } from "bun:test";
import { z } from "zod";
import { geminiProvider, pcmOf, failureOf } from "../server/gemini";
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

/** A server-sent event stream as the Interactions API sends it, cut into `size`-byte pieces (splitting events and characters). */
function sse(events: readonly Record<string, unknown>[], size = 7) {
  const body = new TextEncoder().encode(events.map(event => `event: ${String(event.event_type)}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
  return () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
    for (let offset = 0; offset < body.byteLength; offset += size) controller.enqueue(body.slice(offset, offset + size));
    controller.close();
  } }), { headers: { "content-type": "text/event-stream" } });
}
const delta = (index: number, value: Record<string, unknown>) => ({ index, delta: value, event_type: "step.delta" });
const opening = [
  { interaction: { id: "v1_x", status: "in_progress" }, event_type: "interaction.created" },
  { index: 0, step: { type: "thought" }, event_type: "step.start" },
  delta(0, { type: "thought_summary", content: { type: "text", text: "생각" } }),
  { index: 0, event_type: "step.stop" },
  { index: 1, step: { type: "model_output" }, event_type: "step.start" },
];

test("the script streams: the model output's text deltas are joined and the characters received so far are reported as they arrive", async () => {
  const first = "첫 문장입니다. ";
  const second = "둘째 문장이에요.";
  const { gemini, sent } = provider(sse([...opening, delta(1, { type: "text", text: first }), delta(1, { type: "text", text: second }),
    { index: 1, event_type: "step.stop" }, { interaction: { id: "v1_x", status: "completed" }, event_type: "interaction.completed" }]));
  const received: number[] = [];
  expect(await gemini.script("규칙", "[기록]", signal(), undefined, chars => received.push(chars))).toBe(first + second);
  expect(received).toEqual([first.length, first.length + second.length]);
  expect(sent[0]?.body).toMatchObject({ stream: true, store: false });
});

test("a stream that reports an error or stops before the interaction completes fails as a transient network error", async () => {
  const broken = [
    sse([...opening, delta(1, { type: "text", text: "반쯤" }), { error: { message: `Deadline expired ${KEY}`, code: "gateway_timeout" }, event_type: "error" }]),
    sse([...opening, delta(1, { type: "text", text: "반쯤" })]),
  ];
  for (const reply of broken) {
    const error = await provider(reply).gemini.script("", "", signal()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ code: "network", transient: true });
    expect(String(error instanceof Error ? error.message : error)).not.toContain(KEY);
  }
});

test("a script model that answers nothing, or goes quiet mid-stream, fails as stalled after the stall limit instead of the call's timeout", async () => {
  // 2026-10-07: gemini-3.8-flash sent no response headers for minutes while the lighter model answered in a second.
  const silent = geminiProvider({ key: async () => KEY, firstByteMs: 30, idleMs: 30, fetch: async (_url, init) => await new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  }) });
  const quiet = geminiProvider({ key: async () => KEY, firstByteMs: 30, idleMs: 30, fetch: async () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new TextEncoder().encode(opening.map(event => `event: ${event.event_type}\ndata: ${JSON.stringify(event)}\n\n`).join("")));
  } }), { headers: { "content-type": "text/event-stream" } }) });
  for (const gemini of [silent, quiet]) {
    const started = Date.now();
    const error = await gemini.script("", "", signal()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ code: "stalled", transient: true });
    expect(Date.now() - started).toBeLessThan(2000);
  }
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

const vertexAdc = { exists: async () => true, token: async () => "ya29.test-token" };
const vertexSse = (chunks: unknown[]) => new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\r\n\r\n`).join(""), { headers: { "content-type": "text/event-stream" } });

test("there is no lighter script model: without Vertex the script has one route, the key, always with the script model", async () => {
  const { gemini, sent } = provider(() => steps([{ type: "text", text: "원고" }]));
  expect("fallbackScriptModel" in gemini).toBe(false);
  expect(gemini.scriptRoutes).toEqual(["gemini"]);
  await gemini.script("규칙", "[기록]", signal(), "gemini");
  expect(sent[0]?.body).toMatchObject({ model: "gemini-3.8-flash" });
});

test("with Vertex, the script is streamed from the same model on Vertex AI (global) first, and the key is the second route", async () => {
  const sent: Sent[] = [];
  const lines: string[] = [];
  const gemini = geminiProvider({ key: async () => KEY, vertex: { project: "p-1", credentials: vertexAdc, log: line => lines.push(line) }, fetch: async (url, init) => {
    sent.push({ url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
    return url.includes("aiplatform")
      ? vertexSse([{ candidates: [{ content: { role: "model", parts: [{ text: "안녕" }] } }], modelVersion: "gemini-3.8-flash" },
        { candidates: [{ content: { role: "model", parts: [{ text: "하세요." }] }, finishReason: "STOP" }], modelVersion: "gemini-3.8-flash" }])
      : steps([{ type: "text", text: "키 원고" }]);
  } });
  expect(gemini.scriptRoutes).toEqual(["vertex", "gemini"]);
  const received: number[] = [];
  expect(await gemini.script("규칙", "[기록]", signal(), undefined, chars => received.push(chars))).toBe("안녕하세요.");
  expect(received).toEqual([2, 6]);
  expect(sent[0]?.url).toBe("https://aiplatform.googleapis.com/v1/projects/p-1/locations/global/publishers/google/models/gemini-3.8-flash:streamGenerateContent?alt=sse");
  expect(sent[0]?.headers.get("authorization")).toBe("Bearer ya29.test-token");
  expect(sent[0]?.headers.get("x-goog-api-key")).toBeNull();
  expect(sent[0]?.body).toEqual({ systemInstruction: { parts: [{ text: "규칙" }] }, contents: [{ role: "user", parts: [{ text: "[기록]" }] }] });
  // One log line names the host and the model that wrote it, never the token.
  expect(lines).toEqual(["narration script: aiplatform.googleapis.com gemini-3.8-flash global 200 model=gemini-3.8-flash chars=6"]);
  expect(await gemini.script("규칙", "[기록]", signal(), "gemini")).toBe("키 원고");
  expect(sent[1]?.body).toMatchObject({ model: "gemini-3.8-flash" });
  expect(lines.join("\n")).not.toContain("ya29");
});

test("a Vertex script that answers nothing, goes quiet, or ends without finishing fails as stalled or network, never with text", async () => {
  const silent = geminiProvider({ key: async () => KEY, vertex: { project: "p", credentials: vertexAdc, log: () => undefined }, firstByteMs: 30, idleMs: 30,
    fetch: async (_url, init) => await new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }) });
  const quiet = geminiProvider({ key: async () => KEY, vertex: { project: "p", credentials: vertexAdc, log: () => undefined }, firstByteMs: 30, idleMs: 30,
    fetch: async () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "가" }] } }] })}\n\n`));
    } }), { headers: { "content-type": "text/event-stream" } }) });
  for (const gemini of [silent, quiet]) {
    const started = Date.now();
    expect(await gemini.script("", "", signal()).catch((caught: unknown) => caught)).toMatchObject({ code: "stalled", transient: true });
    expect(Date.now() - started).toBeLessThan(2000);
  }
  const cut = geminiProvider({ key: async () => KEY, vertex: { project: "p", credentials: vertexAdc, log: () => undefined },
    fetch: async () => vertexSse([{ candidates: [{ content: { parts: [{ text: "가" }] } }] }]) });
  expect(await cut.script("", "", signal()).catch((caught: unknown) => caught)).toMatchObject({ code: "network", transient: true });
  const missing = geminiProvider({ key: async () => KEY, vertex: { project: "p", credentials: vertexAdc, log: () => undefined },
    fetch: async () => Response.json({ error: { code: 404 } }, { status: 404 }) });
  expect(await missing.script("", "", signal()).catch((caught: unknown) => caught)).toMatchObject({ code: "http_404", transient: false });
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

test("a 429 asking to wait an hour or more is the day's quota, not a per-minute limit", async () => {
  const daily = await failureOf(new Response("{}", { status: 429, headers: { "retry-after": "30814" } }));
  expect(daily.code).toBe("quota_daily");
  expect(daily.transient).toBe(false);
  const minute = await failureOf(new Response("{}", { status: 429, headers: { "retry-after": "40" } }));
  expect(minute).toMatchObject({ code: "http_429", transient: true, retryAfterMs: 40000 });
});

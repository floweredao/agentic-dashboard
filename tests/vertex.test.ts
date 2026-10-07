import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { geminiProvider } from "../server/gemini";
import { ProviderError } from "../server/narration";
import { adcCredentials } from "../server/vertex";
import type { AdcSource } from "../server/vertex";

type Sent = { url: string; headers: Headers; body: unknown };
const signal = () => AbortSignal.timeout(5000);
const URL = "https://aiplatform.googleapis.com/v1/projects/demo-project/locations/global/publishers/google/models/gemini-3.8-flash-tts:generateContent";
const wav = (pcm: Uint8Array) => {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii"); header.writeUInt32LE(36 + pcm.byteLength, 4); header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii"); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24); header.writeUInt32LE(48000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii"); header.writeUInt32LE(pcm.byteLength, 40);
  return Buffer.concat([header, Buffer.from(pcm)]).toString("base64");
};
const audioReply = (pcm: Uint8Array) => Response.json({
  candidates: [{ content: { role: "model", parts: [{ inlineData: { mimeType: "audio/wav", data: wav(pcm) } }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 42 },
});
const credentials = (token = "ya29.test"): AdcSource => ({ exists: async () => true, token: async () => token });

function provider(reply: (url: string) => Response, adc: AdcSource = credentials()) {
  const sent: Sent[] = [];
  const logs: string[] = [];
  const gemini = geminiProvider({
    key: async () => "AIza-test-key",
    vertex: { project: "demo-project", credentials: adc, log: line => logs.push(line) },
    fetch: async (url, init) => {
      sent.push({ url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
      return reply(url);
    },
  });
  return { gemini, sent, logs };
}

test("with Vertex, speech goes to aiplatform generateContent in global with the ADC token, the voice and style as metadata", async () => {
  const pcm = new Uint8Array([1, 2, 3, 4]);
  const { gemini, sent, logs } = provider(() => audioReply(pcm));
  expect(await gemini.speak("안녕하세요.", "차분하게", signal())).toEqual(pcm);
  expect(sent[0]?.url).toBe(URL);
  expect(sent[0]?.headers.get("authorization")).toBe("Bearer ya29.test");
  expect(sent[0]?.headers.get("x-goog-user-project")).toBe("demo-project");
  expect(sent[0]?.headers.get("x-goog-api-key")).toBeNull();
  expect(sent[0]?.body).toEqual({
    contents: [{ role: "user", parts: [{ text: "안녕하세요.", speechMetadata: { style: "차분하게" } }] }],
    generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { voice: "Kore" } } },
  });
  expect(logs).toEqual(["narration tts: aiplatform.googleapis.com gemini-3.8-flash-tts global 200 audio_tokens=42"]);
});

test("with Vertex, a dialogue is one multi-speaker request with every turn naming its speaker", async () => {
  const pcm = new Uint8Array([5, 6]);
  const { gemini, sent } = provider(() => audioReply(pcm));
  expect(await gemini.converse([{ speaker: "A", text: "안녕하세요." }, { speaker: "B", text: "네." }], "편안하게", signal())).toEqual(pcm);
  expect(sent[0]?.body).toEqual({
    contents: [{ role: "user", parts: [
      { text: "안녕하세요.", speechMetadata: { speaker: "A", style: "편안하게" } },
      { text: "네.", speechMetadata: { speaker: "B", style: "편안하게" } },
    ] }],
    generationConfig: { responseModalities: ["AUDIO"], speechConfig: { multiSpeakerVoiceConfig: { speakerVoiceConfigs: [
      { speaker: "A", voiceConfig: { voice: "Kore" } }, { speaker: "B", voiceConfig: { voice: "Puck" } },
    ] } } },
  });
});

test("with Vertex, the script's second route still goes to the AI Studio Interactions API with the key, same model", async () => {
  const { gemini, sent } = provider(() => Response.json({ steps: [{ type: "model_output", content: [{ type: "text", text: "원고" }] }] }));
  expect(gemini.scriptRoutes).toEqual(["vertex", "gemini"]);
  expect(await gemini.script("규칙", "[기록]", signal(), "gemini")).toBe("원고");
  expect(sent[0]?.url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
  expect(sent[0]?.headers.get("x-goog-api-key")).toBe("AIza-test-key");
  expect(sent[0]?.body).toMatchObject({ model: "gemini-3.8-flash" });
});

test("with Vertex, narration is available only when the key and the ADC file both exist", async () => {
  expect(await provider(() => audioReply(new Uint8Array([1]))).gemini.available()).toBe(true);
  const missing = { exists: async () => false, token: async () => "x" };
  expect(await provider(() => audioReply(new Uint8Array([1])), missing).gemini.available()).toBe(false);
});

const failure = (status: number, body: unknown, headers: Record<string, string> = {}) => () => Response.json(body, { status, headers });
test.each([
  ["401 is an expired or missing ADC login", failure(401, { error: { code: 401, status: "UNAUTHENTICATED" } }), "vertex_auth", false],
  ["403 for a disabled API", failure(403, { error: { code: 403, status: "PERMISSION_DENIED",
    details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "SERVICE_DISABLED" }] } }), "vertex_disabled", false],
  ["403 for disabled billing", failure(403, { error: { code: 403, status: "PERMISSION_DENIED",
    details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "BILLING_DISABLED" }] } }), "vertex_disabled", false],
  ["403 otherwise is a permission the ADC account lacks", failure(403, { error: { code: 403, status: "PERMISSION_DENIED" } }), "vertex_auth", false],
  ["429 is the Vertex quota and worth a retry", failure(429, { error: { code: 429, status: "RESOURCE_EXHAUSTED" } }, { "retry-after": "7" }), "vertex_quota", true],
] as const)("Vertex %s", async (_name, reply, code, transient) => {
  const { gemini } = provider(reply);
  const caught = await gemini.speak("안녕", "차분하게", signal()).catch((error: unknown) => error);
  expect(caught).toBeInstanceOf(ProviderError);
  expect(caught).toMatchObject({ code, transient });
});

test("a Vertex 429 keeps the wait it asked for", async () => {
  const { gemini } = provider(failure(429, { error: { code: 429 } }, { "retry-after": "7" }));
  expect(await gemini.speak("안녕", "차분하게", signal()).catch((error: unknown) => error)).toMatchObject({ retryAfterMs: 7000 });
});

let dir: string | null = null;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = null; });
function adcFile(content: unknown) {
  dir = mkdtempSync(join(tmpdir(), "adc-"));
  const path = join(dir, "adc.json");
  writeFileSync(path, JSON.stringify(content));
  return path;
}
const USER = { type: "authorized_user", client_id: "id.apps", client_secret: "shh", refresh_token: "1//refresh", quota_project_id: "demo-project" };

test("ADC refreshes the user's token once and reuses it until shortly before it expires", async () => {
  const sent: { url: string; body: string }[] = [];
  let clock = 0;
  const adc = adcCredentials({ path: adcFile(USER), now: () => clock, fetch: async (url, init) => {
    sent.push({ url, body: String(init.body) });
    return Response.json({ access_token: `ya29.${sent.length}`, expires_in: 3599, token_type: "Bearer" });
  } });
  expect(await adc.exists()).toBe(true);
  expect(await adc.token(signal())).toBe("ya29.1");
  clock = 3000 * 1000;
  expect(await adc.token(signal())).toBe("ya29.1");
  clock = 3400 * 1000;
  expect(await adc.token(signal())).toBe("ya29.2");
  expect(sent[0]?.url).toBe("https://oauth2.googleapis.com/token");
  expect(Object.fromEntries(new URLSearchParams(sent[0]?.body))).toEqual({
    grant_type: "refresh_token", client_id: "id.apps", client_secret: "shh", refresh_token: "1//refresh" });
});

test("a revoked ADC login, an unreadable file or a missing file is vertex_auth", async () => {
  const revoked = adcCredentials({ path: adcFile(USER), fetch: async () => Response.json({ error: "invalid_grant" }, { status: 400 }) });
  expect(await revoked.token(signal()).catch((error: unknown) => error)).toMatchObject({ code: "vertex_auth", transient: false });
  const odd = adcCredentials({ path: adcFile({ type: "external_account" }), fetch: async () => Response.json({}) });
  expect(await odd.token(signal()).catch((error: unknown) => error)).toMatchObject({ code: "vertex_auth" });
  const missing = adcCredentials({ path: "/nonexistent/adc.json" });
  expect(await missing.exists()).toBe(false);
  expect(await missing.token(signal()).catch((error: unknown) => error)).toMatchObject({ code: "vertex_auth" });
});

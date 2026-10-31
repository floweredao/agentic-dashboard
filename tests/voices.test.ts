import { expect, test } from "bun:test";
import { NarrationVoicesSchema, VoiceSchema } from "../shared/contracts";
import { GEMINI_PODCAST_VOICE, GEMINI_VOICE, geminiProvider } from "../server/gemini";
import { PODCAST_STYLE, previewText, SPEECH_STYLE } from "../server/narration";
import { KOREAN_VOICES } from "../shared/voices";

const KEY = "test-gemini-key";
// Each family of the Korean voice library and the display name its numbered voices carry.
const FAMILIES: Record<string, string> = {
  advisor: "Authoritative Advisor", assistant: "Digital Assistant", commercial: "Commercial Voiceover", concierge: "Concierge",
  csagent: "Call Center Agent", podcaster: "Podcaster", storyteller: "Storyteller", techagent: "Tech Advisor",
  training: "Training Voiceover", tutor: "Tutor",
};

test("every Korean voice is a ko-kr voice the API accepts, named after its family and number, listed once", () => {
  expect(KOREAN_VOICES.length).toBe(117);
  expect(new Set(KOREAN_VOICES.map(voice => voice.id)).size).toBe(KOREAN_VOICES.length);
  expect(new Set(KOREAN_VOICES.map(voice => voice.name)).size).toBe(KOREAN_VOICES.length);
  for (const voice of KOREAN_VOICES) {
    // The voices response is parsed with VoiceSchema in the app, so a malformed entry would hide the whole voice settings.
    expect(VoiceSchema.safeParse(voice).success).toBe(true);
    const match = /^ko-kr-([a-z]+)-([1-9]\d*)$/.exec(voice.id);
    expect([voice.id, match !== null]).toEqual([voice.id, true]);
    const family = FAMILIES[match?.[1] ?? ""];
    expect([voice.id, voice.name]).toEqual([voice.id, `${family} ${match?.[2]}`]);
    // The id prefix is the voice's locale: its preview speaks Korean.
    expect(previewText(voice.id)).toStartWith("안녕하세요");
  }
});

test("a voice outside the Korean list previews in English", () => {
  expect(previewText(GEMINI_VOICE)).toStartWith("Hello");
});

test("the default voices give two different podcast hosts even when the read voice is set to the podcast default", () => {
  for (const [voice, podcastVoice] of [[GEMINI_PODCAST_VOICE, undefined], [GEMINI_VOICE, GEMINI_VOICE], ["Charon", "Charon"]] as const) {
    const provider = geminiProvider({ key: async () => KEY, voice, ...(podcastVoice ? { podcastVoice } : {}) });
    expect(provider.voice).toBe(voice);
    expect(provider.hosts[0]).toBe(voice);
    expect(provider.hosts[1]).not.toBe(provider.hosts[0]);
    // What GET /api/v1/narration/voices answers as `defaults` before the owner saves a choice.
    const defaults = { readVoice: provider.voice, hostA: provider.hosts[0], hostB: provider.hosts[1], readStyle: SPEECH_STYLE, podcastStyle: PODCAST_STYLE };
    expect(NarrationVoicesSchema.safeParse(defaults).success).toBe(true);
  }
  // A podcast voice that already differs is kept.
  expect(geminiProvider({ key: async () => KEY, voice: GEMINI_PODCAST_VOICE, podcastVoice: "Aoede" }).hosts).toEqual([GEMINI_PODCAST_VOICE, "Aoede"]);
});

import { expect, test } from "bun:test";
import { KOREAN_VOICES } from "../../shared/voices";
import { genderOf, voicesFor } from "./VoiceSettings";

const voices = [...KOREAN_VOICES.map(voice => ({ ...voice })), { id: "Kore", name: "Kore", gender: "neutral" as const, pitch: null }];

test("the gender switch lists only that gender's Korean voices, and a provider voice of unknown gender under both", () => {
  const male = voicesFor(voices, "male");
  const female = voicesFor(voices, "female");
  expect(male.every(voice => voice.gender === "male" || voice.gender === "neutral")).toBe(true);
  expect(female.every(voice => voice.gender === "female" || voice.gender === "neutral")).toBe(true);
  expect(male.length + female.length).toBe(voices.length + voices.filter(voice => voice.gender === "neutral").length);
  expect(male.some(voice => voice.id === "ko-kr-podcaster-8")).toBe(true);
  expect(female.some(voice => voice.id === "ko-kr-podcaster-8")).toBe(false);
  expect(male.map(voice => voice.id)).toContain("Kore");
  expect(female.map(voice => voice.id)).toContain("Kore");
});

test("a saved voice opens under its own gender", () => {
  expect(genderOf(voices, "ko-kr-podcaster-8")).toBe("male");
  expect(genderOf(voices, "ko-kr-podcaster-1")).toBe("female");
});

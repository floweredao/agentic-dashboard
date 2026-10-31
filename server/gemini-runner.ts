import ky from "ky";
import { z } from "zod";
import type { ModelRunner } from "./ai-fill";
import type { KeySource } from "./gemini";
import { ApiError } from "./errors";

export const AI_FILL_MODEL = "gemini-3.5-flash-lite";
const response = z.object({ candidates: z.array(z.object({ content: z.object({ parts: z.array(z.object({ text: z.string().optional() })) }) })) });

export function geminiRunner(key: KeySource, model = AI_FILL_MODEL): ModelRunner {
  return async (system, prompt, signal) => {
    const credential = await key();
    if (!credential) throw new ApiError(409, "gemini_key_required", "Add a Gemini key in Settings.");
    try {
      const result = await ky.post(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        headers: { "x-goog-api-key": credential }, signal, timeout: 60000, retry: 0,
        json: { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json" } },
      }).json();
      return response.parse(result).candidates[0]?.content.parts.map(part => part.text ?? "").join("") ?? "";
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      throw new ApiError(502, "gemini_fill_failed", "The title provider could not complete this request.");
    }
  };
}

import { existsSync, rmSync } from "node:fs";
import { type Encoder } from "./narration-types";

export function wav(pcm: Uint8Array) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + pcm.byteLength, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24); header.writeUInt32LE(48000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(pcm.byteLength, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * AAC in an M4A container through ffmpeg from PATH, else macOS afconvert when it exists, and the WAV is
 * kept when neither is there or the encode fails.
 */
export function audioEncoder(tools: { readonly afconvert?: string; readonly ffmpeg?: string | null } = {}): Encoder {
  const afconvertPath = tools.afconvert ?? "/usr/bin/afconvert";
  const ffmpegPath = tools.ffmpeg === undefined ? Bun.which("ffmpeg") : tools.ffmpeg;
  return async (wavPath, signal) => {
    const out = wavPath.replace(/\.wav$/, ".m4a");
    const command = ffmpegPath ? [ffmpegPath, "-nostdin", "-loglevel", "error", "-y", "-i", wavPath, "-c:a", "aac", "-b:a", "64k", out]
      : existsSync(afconvertPath) ? [afconvertPath, "-f", "m4af", "-d", "aac", "-b", "64000", wavPath, out] : null;
    if (command) {
      try {
        const child = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore", signal });
        if (await child.exited === 0 && existsSync(out)) {
          rmSync(wavPath, { force: true });
          return { path: out, mime: "audio/mp4" };
        }
      } catch (error) {
        if (!(error instanceof Error)) throw error;
      }
    }
    rmSync(out, { force: true });
    return { path: wavPath, mime: "audio/wav" };
  };
}

export const afconvert: Encoder = audioEncoder();

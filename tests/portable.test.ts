import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { audioEncoder } from "../server/narration";

test("audio uses ffmpeg when afconvert is absent and keeps WAV when neither exists", async () => {
  // Given: an isolated encoder executable with ffmpeg's input/output argument contract.
  const dir = mkdtempSync(join(tmpdir(), "encoder-"));
  try {
    const ffmpeg = join(dir, "ffmpeg");
    writeFileSync(ffmpeg, '#!/bin/sh\nfor a; do last=$a; done\nwhile [ "$1" != "-i" ]; do shift; done\ncp "$2" "$last"\n');
    chmodSync(ffmpeg, 0o755);
    const source = join(dir, "audio.wav");
    writeFileSync(source, "RIFF-test");
    // When: encoding without the macOS tool.
    const result = await audioEncoder({ afconvert: join(dir, "missing"), ffmpeg })(source, AbortSignal.timeout(5000));
    // Then: the encoder's output is stored as AAC and the source is removed.
    expect(result).toEqual({ path: join(dir, "audio.m4a"), mime: "audio/mp4" });
    expect(readFileSync(result.path, "utf8")).toBe("RIFF-test");
    expect(existsSync(source)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("audio remains WAV when no encoder is installed", async () => {
  // Given: a WAV and no installed tools.
  const dir = mkdtempSync(join(tmpdir(), "encoder-"));
  try {
    const source = join(dir, "audio.wav");
    writeFileSync(source, "RIFF-test");
    // When: encoding without either tool.
    const result = await audioEncoder({ afconvert: join(dir, "missing"), ffmpeg: null })(source, AbortSignal.timeout(5000));
    // Then: the original file stays usable.
    expect(result).toEqual({ path: source, mime: "audio/wav" });
    expect(readFileSync(source, "utf8")).toBe("RIFF-test");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ffmpeg takes precedence when the macOS encoder also exists", async () => {
  // Given both tool paths exist, but only the ffmpeg fixture produces audio.
  const dir = mkdtempSync(join(tmpdir(), "encoder-order-"));
  try {
    const ffmpeg = join(dir, "ffmpeg");
    writeFileSync(ffmpeg, '#!/bin/sh\nfor a; do last=$a; done\nwhile [ "$1" != "-i" ]; do shift; done\ncp "$2" "$last"\n');
    chmodSync(ffmpeg, 0o755);
    const source = join(dir, "audio.wav");
    writeFileSync(source, "RIFF-test");
    // When both encoders are offered.
    const result = await audioEncoder({ afconvert: "/usr/bin/false", ffmpeg })(source, AbortSignal.timeout(5000));
    // Then ffmpeg's valid output wins over afconvert.
    expect(result.mime).toBe("audio/mp4");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

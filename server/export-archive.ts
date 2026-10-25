import { createWriteStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import type { BunFile } from "bun";
import { ApiError } from "./errors";

export const EXPORT_MAX_BYTES = 64 * 1024 * 1024;
export const exportTooLarge = () => new ApiError(413, "account_export_too_large", "Account export exceeds the 64 MiB limit");
export async function* chunks(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) return;
      yield result.value;
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
}
function byteLimit(maximum: number) {
  let bytes = 0;
  return new Transform({
    transform(chunk: Uint8Array, _encoding, callback) {
      bytes += chunk.byteLength;
      callback(bytes > maximum ? exportTooLarge() : null, chunk);
    },
  });
}
export async function spoolAudio(stream: ReadableStream<Uint8Array>, path: string, maximum: number, signal: AbortSignal) {
  await pipeline(Readable.from(chunks(stream), { objectMode: false, highWaterMark: 65536 }),
    byteLimit(maximum), createWriteStream(path, { mode: 0o600 }), { signal });
}

/** POSIX ustar entries; generated audio names fit its 100-byte name field. */
function header(name: string, size: number) {
  if (Buffer.byteLength(name) > 100) throw new ApiError(503, "account_export_unavailable", "Export entry name is too long");
  const block = Buffer.alloc(512);
  block.write(name, 0, 100);
  block.write("0000600\0", 100);
  block.write("0000000\0", 108);
  block.write("0000000\0", 116);
  block.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
  block.write("00000000000\0", 136);
  block.fill(32, 148, 156);
  block.write("0", 156);
  block.write("ustar\0", 257);
  block.write("00", 263);
  const checksum = block.reduce((sum, value) => sum + value, 0);
  block.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148);
  return block;
}
export async function writeArchive(entries: AsyncIterable<{ name: string; file: BunFile }>, path: string, signal: AbortSignal) {
  async function* tar() {
    let bytes = 0;
    const count = (chunk: Uint8Array) => {
      bytes += chunk.byteLength;
      if (bytes > EXPORT_MAX_BYTES) throw exportTooLarge();
      return chunk;
    };
    for await (const { name, file } of entries) {
      signal.throwIfAborted();
      yield count(header(name, file.size));
      for await (const chunk of chunks(file.stream())) yield count(chunk);
      if (file.size % 512) yield count(Buffer.alloc(512 - file.size % 512));
    }
    yield count(Buffer.alloc(1024));
  }
  await pipeline(Readable.from(tar(), { objectMode: false, highWaterMark: 65536 }), createGzip(),
    byteLimit(EXPORT_MAX_BYTES), createWriteStream(path, { mode: 0o600 }), { signal });
}

export function exportResponse(file: BunFile, signal: AbortSignal, cleanup: () => Promise<void>) {
  const reader = file.stream().getReader();
  let ended = false, finished: Promise<void> | undefined;
  let abort: () => void;
  const finish = () => finished ??= (async () => {
    signal.removeEventListener("abort", abort);
    try { await reader.cancel(); } finally { await cleanup(); }
  })();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      abort = () => {
        ended = true;
        void finish().then(() => controller.error(signal.reason), error => controller.error(error));
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    },
    async pull(controller) {
      if (ended) return;
      try {
        const result = await reader.read();
        if (ended) return;
        if (result.done) { ended = true; await finish(); controller.close(); }
        else controller.enqueue(result.value);
      } catch (error) { ended = true; await finish(); controller.error(error); }
    },
    async cancel() { ended = true; await finish(); },
  });
  return new Response(body, { headers: {
    "Content-Type": "application/gzip", "Content-Length": String(file.size),
    "Content-Disposition": 'attachment; filename="agentic-dashboard-export.tar.gz"', "Cache-Control": "private, no-store",
  } });
}

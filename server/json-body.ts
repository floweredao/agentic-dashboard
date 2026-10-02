import { ApiError } from "./errors";

export async function json(request: Request, limit = 32768): Promise<unknown> {
  const tooLarge = () => new ApiError(413, "too_large", `Body exceeds ${limit / 1024} KiB`);
  if (Number(request.headers.get("content-length")) > limit) throw tooLarge();
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    throw new ApiError(415, "unsupported_media_type", "Content-Type must be application/json");
  }
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw tooLarge(); }
      chunks.push(value);
    }
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch (error) { if (error instanceof SyntaxError) throw new ApiError(400, "invalid_json", "Malformed JSON"); throw error; }
}

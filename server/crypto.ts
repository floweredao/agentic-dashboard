import { ApiError } from "./errors";

/** Versioned AES-256-GCM envelopes. Moving a value between account rows invalidates its tag. */
export function createKeyCipher(kek: Readonly<Record<string, string>>) {
  const versions = Object.keys(kek).map(Number);
  const current = Math.max(...versions);
  if (!Number.isSafeInteger(current) || current < 1) throw new ApiError(500, "key_configuration", "A versioned encryption key is required");
  const keyFor = async (version: number) => {
    const encoded = kek[String(version)];
    if (!encoded || !/^[A-Za-z0-9+/]{43}=$/.test(encoded)) throw new ApiError(500, "key_configuration", "Encryption key version is unavailable");
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.byteLength !== 32) throw new ApiError(500, "key_configuration", "Encryption keys must have 32 bytes");
    return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
  };
  return {
    version: current,
    async encrypt(userId: string, value: string) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv,
        additionalData: new TextEncoder().encode(`${userId}:gemini`) }, await keyFor(current), new TextEncoder().encode(value));
      return { version: current, ciphertext: `v${current}.${Buffer.from(iv).toString("base64url")}.${Buffer.from(ciphertext).toString("base64url")}` };
    },
    async decrypt(userId: string, value: string) {
      const match = /^v([1-9]\d*)\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]+)$/.exec(value);
      if (!match?.[1] || !match[2] || !match[3]) throw new ApiError(500, "key_ciphertext", "The stored key could not be opened");
      try {
        const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(match[2], "base64url"),
          additionalData: new TextEncoder().encode(`${userId}:gemini`) }, await keyFor(Number(match[1])), Buffer.from(match[3], "base64url"));
        return new TextDecoder().decode(plaintext);
      } catch (error) {
        if (error instanceof DOMException) throw new ApiError(500, "key_ciphertext", "The stored key could not be opened");
        throw error;
      }
    },
  };
}

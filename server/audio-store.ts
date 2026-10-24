import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { hash } from "./agents";
import { ApiError } from "./errors";
import type { CloudClient } from "./cloud-client";

export interface AudioStore {
  readonly remote: boolean;
  put(userId: string, name: string, file: Blob): Promise<void>;
  url(userId: string, name: string): Promise<string>;
  read(userId: string, name: string): Promise<ReadableStream<Uint8Array>>;
  remove(userId: string, name: string): Promise<void>;
  removeAll(userId: string): Promise<void>;
}
const filename = (name: string) => {
  if (!name || name === "." || name === ".." || /[/\\\u0000]/.test(name)) throw new ApiError(400, "invalid_audio_name", "Invalid audio name");
  return name;
};
export function localAudioStore(directory: string) {
  const root = (userId: string) => userId === "local" ? directory : join(directory, "users", hash(userId));
  const path = (userId: string, name: string) => join(root(userId), filename(name));
  return {
    remote: false, path,
    async put(userId: string, name: string, file: Blob) {
      const target = path(userId, name);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      await Bun.write(target, file);
      chmodSync(target, 0o600);
    },
    async url(userId: string, name: string) { return path(userId, name); },
    async read(userId: string, name: string) { return Bun.file(path(userId, name)).stream(); },
    async remove(userId: string, name: string) { rmSync(path(userId, name), { force: true }); },
    async removeAll(userId: string) {
      // "local" shares the root with hosted account directories. Delete only its files.
      if (userId === "local") {
        for await (const name of new Bun.Glob("*").scan({ cwd: directory, onlyFiles: true })) rmSync(join(directory, name), { force: true });
      } else rmSync(root(userId), { recursive: true, force: true });
    },
  } satisfies AudioStore & { readonly path: (userId: string, name: string) => string };
}

const encode = (text: string) => encodeURIComponent(text).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
export function signingRequest(input: { readonly bucket: string; readonly object: string; readonly account: string; readonly now: number }) {
  const date = new Date(input.now).toISOString().replace(/[:-]|\.\d{3}/g, "");
  const scope = `${date.slice(0, 8)}/auto/storage/goog4_request`;
  const path = `/${encode(input.bucket)}/${input.object.split("/").map(encode).join("/")}`;
  const query = Object.entries({
    "X-Goog-Algorithm": "GOOG4-RSA-SHA256", "X-Goog-Credential": `${input.account}/${scope}`,
    "X-Goog-Date": date, "X-Goog-Expires": "600", "X-Goog-SignedHeaders": "host",
  }).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${encode(key)}=${encode(value)}`).join("&");
  const canonical = `GET\n${path}\n${query}\nhost:storage.googleapis.com\n\nhost\nUNSIGNED-PAYLOAD`;
  return { canonical, stringToSign: `GOOG4-RSA-SHA256\n${date}\n${scope}\n${sha256(canonical)}`, path, query };
}

/** The bucket is private. Only authenticated routes request a ten-minute GET capability. */
export function gcsAudioStore(options: { readonly bucket: string; readonly client: CloudClient; readonly now?: () => number }): AudioStore {
  const { bucket, client } = options;
  const base = `${client.storageOrigin}/storage/v1/b/${encode(bucket)}/o`;
  const object = (userId: string, name: string) => `u/${encode(userId)}/${filename(name)}`;
  const objectUrl = (name: string) => `${base}/${encode(name)}`;
  return {
    remote: true,
    async put(userId, name, file) {
      const key = object(userId, name);
      await client.request(`${client.storageOrigin}/upload/storage/v1/b/${encode(bucket)}/o?uploadType=media&name=${encode(key)}`, {
        method: "POST", body: file, headers: { "Content-Type": file.type || (name.endsWith(".wav") ? "audio/wav" : "audio/mp4") },
      });
      await client.request(objectUrl(key), { method: "PATCH", json: { cacheControl: "private, max-age=600" } });
    },
    async url(userId, name) {
      const account = await client.account();
      const vector = signingRequest({ bucket, object: object(userId, name), account, now: (options.now ?? Date.now)() });
      const result = z.object({ signedBlob: z.string() }).parse(await (await client.request(
        `${client.iamOrigin}/v1/projects/-/serviceAccounts/${encode(account)}:signBlob`, {
          method: "POST", json: { payload: Buffer.from(vector.stringToSign).toString("base64") },
        })).json());
      return `https://storage.googleapis.com${vector.path}?${vector.query}&X-Goog-Signature=${Buffer.from(result.signedBlob, "base64").toString("hex")}`;
    },
    async read(userId, name) {
      const response = await client.request(`${objectUrl(object(userId, name))}?alt=media`);
      if (!response.body) throw new ApiError(502, "audio_storage", "Audio storage returned no body");
      return response.body;
    },
    async remove(userId, name) {
      const response = await client.request(objectUrl(object(userId, name)), { method: "DELETE", throwHttpErrors: false });
      if (!response.ok && response.status !== 404) throw new ApiError(502, "audio_storage", "Audio storage deletion failed");
    },
    async removeAll(userId) {
      const prefix = `u/${encode(userId)}/`;
      let page: string | undefined;
      do {
        const query = new URLSearchParams({ prefix, ...(page ? { pageToken: page } : {}) });
        const result = z.object({ items: z.array(z.object({ name: z.string() })).default([]), nextPageToken: z.string().optional() })
          .parse(await (await client.request(`${base}?${query}`)).json());
        for (const item of result.items) {
          if (!item.name.startsWith(prefix)) throw new ApiError(502, "audio_storage", "Invalid storage prefix");
          const response = await client.request(objectUrl(item.name), { method: "DELETE", throwHttpErrors: false });
          if (!response.ok && response.status !== 404) throw new ApiError(502, "audio_storage", "Audio storage deletion failed");
        }
        page = result.nextPageToken;
      } while (page);
    },
  };
}

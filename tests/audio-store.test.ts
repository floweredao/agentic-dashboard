import { expect, test } from "bun:test";
import { generateKeyPairSync, sign, verify } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localAudioStore, gcsAudioStore, signingRequest } from "../server/audio-store";
import { cloudClient } from "../server/cloud-client";
import { fake, wavOnly, research, narration } from "./narration-helper";
import { fixture } from "./backend-helper";
import { z } from "zod";

test("local audio preserves bytes and isolates account directories", async () => {
  // Given: an isolated directory and two account namespaces.
  const dir = mkdtempSync(join(tmpdir(), "dpw-d-audio-"));
  const store = localAudioStore(dir);
  try {
    await store.put("a", "one.wav", new Blob(["A"]));
    await store.put("b", "one.wav", new Blob(["B"]));
    // When: one account removes all its audio.
    await store.removeAll("a");
    // Then: the other account's file still has its original bytes.
    expect(await (await store.read("b", "one.wav")).text()).toBe("B");
    expect(await Bun.file(store.path("a", "one.wav")).exists()).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("V4 signing uses the fixed canonical request and a verifiable RSA signature", async () => {
  // Given: fixed request inputs and a generated local signing key, never a cloud credential.
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const now = () => Date.parse("2026-01-02T03:04:05.000Z");
  const vector = signingRequest({ bucket: "test-bucket", object: "u/a/file name.wav",
    account: "signer@example.test", now: now() });
  const expectedQuery = "X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Credential=signer%40example.test%2F20260102%2Fauto%2Fstorage%2Fgoog4_request&X-Goog-Date=20260102T030405Z&X-Goog-Expires=600&X-Goog-SignedHeaders=host";
  expect(vector.canonical).toBe(`GET\n/test-bucket/u/a/file%20name.wav\n${expectedQuery}\nhost:storage.googleapis.com\n\nhost\nUNSIGNED-PAYLOAD`);
  const issuer = Bun.serve({ port: 0, fetch: async request => {
    const body = z.object({ payload: z.string() }).parse(await request.json());
    return Response.json({ signedBlob: sign("RSA-SHA256", Buffer.from(body.payload, "base64"), privateKey).toString("base64") });
  } });
  try {
    const client = cloudClient({ accessToken: async () => "fixture", account: async () => "signer@example.test",
      iamOrigin: issuer.url.origin });
    // When: the store signs the same fixed object.
    const url = new URL(await gcsAudioStore({ bucket: "test-bucket", client, now }).url("a", "file name.wav"));
    // Then: the signature verifies against the independently asserted canonical input.
    expect(url.searchParams.get("X-Goog-Expires")).toBe("600");
    expect(verify("RSA-SHA256", Buffer.from(vector.stringToSign), publicKey,
      Buffer.from(url.searchParams.get("X-Goog-Signature") ?? "", "hex"))).toBe(true);
  } finally { issuer.stop(true); }
});

test("audio authenticates before redirecting to private short lived storage", async () => {
  // Given: fake speech and a remote store with no external calls.
  const tts = fake();
  let urls = 0;
  const audioStore = { remote: true, put: async () => undefined, read: async () => new Blob(["audio"]),
    remove: async () => undefined, removeAll: async () => undefined,
    url: async () => { urls++; return "https://storage.googleapis.com/test/file?fixture=1"; } };
  const f = await fixture(10000, Date.now, { audioStore, audioBucket: "test",
    narration: { provider: tts.provider, encode: wavOnly, retryDelayMs: 0 } });
  try {
    const owner = await f.login();
    const record = await research(f, owner);
    await f.call(narration(record.id), "POST", {}, owner);
    await f.app.narration.idle();
    // When: an unauthenticated visitor requests audio, no capability is minted.
    expect((await f.call(`${narration(record.id)}/audio`)).status).toBe(401);
    expect(urls).toBe(0);
    // Then: the authenticated response is a non-cacheable redirect.
    const response = await f.call(`${narration(record.id)}/audio`, "GET", undefined, owner);
    expect(response.status).toBe(302);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Location")).toStartWith("https://storage.googleapis.com/");
  } finally { await f.close(); }
});

test("GCS upload metadata and deletion stay inside the requested account prefix", async () => {
  // Given: a local wire fake recording object API calls.
  const calls: { method: string; url: URL; body: string }[] = [];
  const server = Bun.serve({ port: 0, fetch: async request => {
    const url = new URL(request.url);
    calls.push({ method: request.method, url, body: await request.text() });
    if (request.method === "GET") return Response.json({ items: [{ name: "u/a/one.wav" }] });
    return Response.json({});
  } });
  try {
    const client = cloudClient({ storageOrigin: server.url.origin, accessToken: async () => "fixture", account: async () => "signer@example.test" });
    const store = gcsAudioStore({ bucket: "test-bucket", client });
    // When: uploading and removing A's objects.
    await store.put("a", "one.wav", new Blob(["audio"]));
    await store.removeAll("a");
    // Then: uploads carry private caching and deletion never enumerates B.
    expect(calls[0]?.url.searchParams.get("name")).toBe("u/a/one.wav");
    expect(calls[1]?.body).toBe(JSON.stringify({ cacheControl: "private, max-age=600" }));
    expect(calls.find(call => call.method === "GET")?.url.searchParams.get("prefix")).toBe("u/a/");
    expect(calls.find(call => call.method === "DELETE")?.url.pathname).toEndWith("u%2Fa%2Fone.wav");
  } finally { server.stop(true); }
});

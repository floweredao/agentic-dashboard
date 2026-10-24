import { expect, test } from "bun:test";
import { z } from "zod";
import { createKeyCipher } from "../server/crypto";
import { hostedFixture } from "./helpers/hosted";
import { secret } from "../server/agents";
import { createGeminiKeys } from "../server/gemini-settings";
import { RecordInputSchema } from "../shared/contracts";

const kek = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");

test("AES-GCM binds ciphertext to its user and detects tampering and missing KEK versions", async () => {
  // Given generated keys and account-bound encryption.
  const keys = { "1": kek() };
  const cipher = createKeyCipher(keys);
  const plaintext = secret();
  const sealed = await cipher.encrypt("a", plaintext);
  // When the ciphertext is opened under correct and incorrect identities.
  expect(sealed.ciphertext).not.toContain(plaintext);
  expect(await cipher.decrypt("a", sealed.ciphertext)).toBe(plaintext);
  // Then only its account and authentic bytes decrypt.
  await expect(cipher.decrypt("b", sealed.ciphertext)).rejects.toThrow();
  const parts = sealed.ciphertext.split(".");
  const bytes = Buffer.from(parts[2] ?? "", "base64url");
  bytes[0] = (bytes[0] ?? 0) ^ 1;
  await expect(cipher.decrypt("a", `${parts[0]}.${parts[1]}.${bytes.toString("base64url")}`)).rejects.toThrow();
  await expect(createKeyCipher({ "2": kek() }).decrypt("a", sealed.ciphertext)).rejects.toThrow();
});

test("Gemini settings validate before storage, never reveal a key, and remain account scoped", async () => {
  const accepted = secret();
  const f = await hostedFixture({ geminiKeys: { kek: { "1": kek() },
    selectedModels: { script: "script-qa", speech: "speech-qa" },
    validate: async key => ({ accepted: key === accepted, models: ["script-qa"] }) } });
  try {
    expect((await f.call("/api/v1/settings/gemini", { method: "PUT", body: { key: "invalid" } })).status).toBe(422);
    expect(await (await f.call("/api/v1/settings/gemini")).json()).toEqual({ configured: false, last4: null });
    const saved = await f.call("/api/v1/settings/gemini", { method: "PUT", body: { key: accepted } });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ configured: true, last4: accepted.slice(-4),
      modelAvailability: { script: { name: "script-qa", listed: true }, speech: { name: "speech-qa", listed: false } } });
    expect(await (await f.call("/api/v1/settings/gemini", { headers: f.b.headers })).json()).toEqual({ configured: false, last4: null });
    const row = z.object({ gemini_key_ct: z.string() }).parse(await f.app.sql.get("SELECT gemini_key_ct FROM users WHERE id=?", ["a"]));
    expect(row.gemini_key_ct).not.toContain(accepted);
    expect((await f.call("/api/v1/settings/gemini", { method: "DELETE" })).status).toBe(204);
    expect(await (await f.call("/api/v1/settings/gemini")).json()).toEqual({ configured: false, last4: null });
  } finally { await f.close(); }
});

test("missing personal key gives actionable conflict while reading and saving still work", async () => {
  const f = await hostedFixture({ geminiKeys: { kek: { "1": kek() }, validate: async () => ({ accepted: true, models: [] }) } });
  try {
    const saved = await f.call("/api/v1/records", { method: "POST", body: { requestId: "no-key",
      record: { kind: "note", title: "A readable note", body: "Plain text works without a provider key." } } });
    expect(saved.status).toBe(201);
    const record = z.object({ record: z.object({ id: z.string() }) }).parse(await saved.json()).record;
    const response = await f.call(`/api/v1/records/${record.id}/narration`, { method: "POST", body: {} });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "gemini_key_required" } });
    expect((await f.call(`/api/v1/records/${record.id}`)).status).toBe(200);
  } finally { await f.close(); }
});

test("rotating KEKs preserves personal keys while replacing every envelope version", async () => {
  const old = kek();
  const next = kek();
  const key = secret();
  const f = await hostedFixture({ geminiKeys: { kek: { "1": old }, validate: async () => ({ accepted: true, models: [] }) } });
  try {
    await f.call("/api/v1/settings/gemini", { method: "PUT", body: { key } });
    const vault = createGeminiKeys(f.app.sql, { kek: { "1": old, "2": next } });
    expect(await vault.rotateKek()).toBe(1);
    expect(await createGeminiKeys(f.app.sql, { kek: { "2": next } }).keyFor("a")).toBe(key);
    const row = z.object({ gemini_key_kek: z.number() }).parse(await f.app.sql.get("SELECT gemini_key_kek FROM users WHERE id=?", ["a"]));
    expect(row.gemini_key_kek).toBe(2);
  } finally { await f.close(); }
});

test("narration obtains only its tenant's key at generation time", async () => {
  const used: (string | null)[] = [];
  const f = await hostedFixture({
    geminiKeys: { kek: { "1": kek() }, validate: async () => ({ accepted: true, models: [] }) },
    personalProvider: key => ({
      voice: "Kore", hosts: ["Kore", "Puck"], scriptModel: "test-script", ttsModel: "test-speech",
      available: async () => await key() !== null,
      script: async () => { used.push(await key()); return "A sentence for the test."; },
      speak: async () => new Uint8Array(480), converse: async () => new Uint8Array(480),
    }),
  });
  try {
    const aKey = secret();
    const bKey = secret();
    await f.call("/api/v1/settings/gemini", { method: "PUT", body: { key: aKey } });
    await f.call("/api/v1/settings/gemini", { method: "PUT", body: { key: bKey }, headers: f.b.headers });
    const input = RecordInputSchema.parse({ kind: "note", title: "Audio", body: "A complete test sentence." });
    const record = (await f.a.scope.store.create({ id: "owner", source: "manual" }, "audio", input, input)).record;
    expect((await f.call(`/api/v1/records/${record.id}/narration`, { method: "POST", body: {} })).status).toBe(202);
    await f.a.scope.narration.idle();
    expect(used).toEqual([aKey]);
  } finally { await f.close(); }
});

test("another account's key replacement and removal leave the first account unchanged", async () => {
  const f = await hostedFixture({ geminiKeys: { kek: { "1": kek() }, validate: async () => ({ accepted: true, models: [] }) } });
  try {
    const aKey = secret();
    await f.call("/api/v1/settings/gemini", { method: "PUT", body: { key: aKey } });
    const storedKey = z.object({ gemini_key_ct: z.string() });
    const before = storedKey.parse(await f.app.sql.get("SELECT gemini_key_ct FROM users WHERE id=?", ["a"]));
    await f.call("/api/v1/settings/gemini", { method: "PUT", body: { key: secret() }, headers: f.b.headers });
    await f.call("/api/v1/settings/gemini", { method: "DELETE", headers: f.b.headers });
    expect(storedKey.parse(await f.app.sql.get("SELECT gemini_key_ct FROM users WHERE id=?", ["a"]))).toEqual(before);
    expect(await (await f.call("/api/v1/settings/gemini")).json()).toEqual({ configured: true, last4: aKey.slice(-4) });
  } finally { await f.close(); }
});

test("agent bearers and missing CSRF cannot manage personal provider keys", async () => {
  const f = await hostedFixture({ geminiKeys: { kek: { "1": kek() }, validate: async () => ({ accepted: true, models: [] }) } });
  try {
    const token = await f.a.scope.agents.add("writer");
    for (const method of ["GET", "PUT", "DELETE"]) {
      expect((await f.call("/api/v1/settings/gemini", { method, headers: { Authorization: `Bearer ${token}` },
        ...(method === "PUT" ? { body: { key: secret() } } : {}) })).status).toBe(403);
    }
    expect((await f.call("/api/v1/settings/gemini", { method: "PUT", headers: { Cookie: f.a.headers.Cookie, Origin: f.a.headers.Origin },
      body: { key: secret() } })).status).toBe(403);
  } finally { await f.close(); }
});

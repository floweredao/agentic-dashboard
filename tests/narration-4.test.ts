
import { afterEach, expect, test } from "bun:test";

import { digestPartId, NARRATION_LIMITS, NarrationStateSchema } from "../shared/contracts";
import { normalizeScript, splitChunks } from "../server/narration";

import { agentRecord, bearer, payload, recordResult } from "./backend-helper";
import { cleanupNarration, setup, read, research, narration } from "./narration-helper";
afterEach(cleanupNarration);

test("a failed TTS reuses the saved script, retries each chunk, and stops after the attempt limit", async () => {
  const { f, tts, idle } = (await setup());
  const owner = await f.login();
  const record = await research(f, owner);

  // A transient error is retried once inside the run.
  tts.failSpeak = 1;
  await f.call(narration(record.id), "POST", {}, owner);
  await idle();
  expect((await read(await f.call(narration(record.id), "GET", undefined, owner))).narration?.status).toBe("ready");
  expect(tts.calls.speak).toHaveLength(2);

  // Persistent failures count attempts; the script is written once per record and reused.
  const other = await research(f, owner);
  tts.failSpeak = "always";
  for (let attempt = 1; attempt <= NARRATION_LIMITS.attempts; attempt += 1) {
    expect((await f.call(narration(other.id), "POST", {}, owner)).status).toBe(202);
    await idle();
    expect((await read(await f.call(narration(other.id), "GET", undefined, owner))).narration).toMatchObject({ status: "failed", attempts: attempt, error: "http_500" });
  }
  expect(tts.calls.script).toBe(2);

  // An agent cannot start a fourth paid attempt; the owner can, by forcing it.
  const blocked = await f.call(narration(other.id), "POST", {}, bearer("omo"));
  expect(blocked.status).toBe(409);
  expect(await blocked.text()).toContain("narration_attempts_exhausted");
  tts.failSpeak = 0;
  expect((await f.call(narration(other.id), "POST", { force: true }, owner)).status).toBe(202);
  await idle();
  expect((await read(await f.call(narration(other.id), "GET", undefined, owner))).narration?.status).toBe("ready");
});

test("errors keep only a code: provider messages never reach the response", async () => {
  const { f, tts, idle } = (await setup());
  const owner = await f.login();
  const record = await research(f, owner);
  tts.error = new Error("leaked AIza-SECRET-KEY and script text");
  await f.call(narration(record.id), "POST", {}, owner);
  await idle();
  const response = await f.call(narration(record.id), "GET", undefined, owner);
  const text = await response.text();
  expect(text).not.toContain("SECRET");
  expect(NarrationStateSchema.parse(JSON.parse(text)).narration).toMatchObject({ status: "failed", error: "provider" });
});

test("narration access follows the record read scope; only the owner deletes", async () => {
  const { f, idle } = (await setup());
  const owner = await f.login();
  const record = await research(f, owner);
  const { Cookie, Origin } = owner;

  expect((await f.call(narration(record.id))).status).toBe(401);
  expect((await f.call(narration(record.id), "POST", {}, { Cookie, Origin })).status).toBe(403);
  expect((await f.call(narration(record.id), "POST", {}, {}, true)).status).toBe(404);

  // omo may narrate its own report and the owner's research it can read.
  const own = recordResult.parse(await (await f.call("/api/v1/records", "POST", payload(agentRecord()), bearer("omo"))).json()).record;
  expect((await f.call(narration(own.id), "POST", {}, bearer("omo"))).status).toBe(202);
  expect((await f.call(narration(record.id), "POST", {}, bearer("omo"))).status).toBe(202);
  await idle();
  const audio = (await read(await f.call(narration(own.id), "GET", undefined, bearer("omo")))).narration?.audio?.url ?? "";
  expect((await f.call(audio, "GET", undefined, bearer("omo"))).status).toBe(200);

  // codex cannot see omo's task; tasks are not narrated at all; agents cannot delete audio.
  const task = recordResult.parse(await (await f.call("/api/v1/records", "POST", payload({ kind: "task", title: "할 일", tags: ["테스트"] }), bearer("omo"))).json()).record;
  expect((await f.call(narration(task.id), "POST", {}, bearer("codex"))).status).toBe(404);
  const unsupported = await f.call(narration(task.id), "POST", {}, bearer("omo"));
  expect(unsupported.status).toBe(400);
  expect(await unsupported.text()).toContain("narration_unsupported");
  expect((await f.call(narration(own.id), "DELETE", undefined, bearer("omo"))).status).toBe(403);
});

test("no TTS key answers 503 and makes nothing", async () => {
  const { f, tts, audioFiles } = (await setup());
  const owner = await f.login();
  const record = await research(f, owner);
  tts.available = false;
  expect((await read(await f.call(narration(record.id), "GET", undefined, owner))).available).toBe(false);
  const refused = await f.call(narration(record.id), "POST", {}, owner);
  expect(refused.status).toBe(503);
  expect(await refused.text()).toContain("narration_unavailable");
  expect(tts.calls.script).toBe(0);
  expect(audioFiles()).toEqual([]);
});

test("the daily limit refuses further generations with 429", async () => {
  const { f, idle } = (await setup(1));
  const owner = await f.login();
  const first = await research(f, owner);
  const second = await research(f, owner);
  expect((await f.call(narration(first.id), "POST", {}, owner)).status).toBe(202);
  await idle();
  const refused = await f.call(narration(second.id), "POST", {}, owner);
  expect(refused.status).toBe(429);
  expect(await refused.text()).toContain("narration_daily_limit");
});

test("audio survives the trash and is removed with the record or on request", async () => {
  const { f, audioFiles, idle } = (await setup());
  const owner = await f.login();
  const record = await research(f, owner);
  await f.call(narration(record.id), "POST", {}, owner);
  await idle();

  // Owner delete of the narration removes the file and the state.
  expect((await f.call(narration(record.id), "DELETE", undefined, owner)).status).toBe(204);
  expect(audioFiles()).toEqual([]);
  expect((await read(await f.call(narration(record.id), "GET", undefined, owner))).narration).toBeNull();

  // Moving the record to the trash keeps the audio for a restore; deleting it for good removes it.
  await f.call(narration(record.id), "POST", {}, owner);
  await idle();
  const current = recordResult.parse(await (await f.call(`/api/v1/records/${record.id}`, "GET", undefined, owner)).json()).record;
  expect((await f.call(`/api/v1/records/${record.id}`, "DELETE", { expectedVersion: current.version }, owner)).status).toBe(204);
  expect(audioFiles()).toHaveLength(1);
  expect((await f.call(`/api/v1/trash/${record.id}/restore`, "POST", undefined, owner)).status).toBe(200);
  expect((await read(await f.call(narration(record.id), "GET", undefined, owner))).narration?.status).toBe("ready");
  const restored = recordResult.parse(await (await f.call(`/api/v1/records/${record.id}`, "GET", undefined, owner)).json()).record;
  await f.call(`/api/v1/records/${record.id}`, "DELETE", { expectedVersion: restored.version }, owner);
  expect((await f.call(`/api/v1/trash/${record.id}`, "DELETE", undefined, owner)).status).toBe(204);
  expect(audioFiles()).toEqual([]);
});

test("deleting one narration removes only that record's audio file and row", async () => {
  const { f, audioFiles, idle } = (await setup());
  const owner = await f.login();
  const kept = await research(f, owner);
  const deleted = await research(f, owner);
  await f.call(narration(kept.id), "POST", {}, owner);
  await idle();
  await f.call(narration(deleted.id), "POST", {}, owner);
  await idle();
  const keptFile = (await read(await f.call(narration(kept.id), "GET", undefined, owner))).narration?.audio?.url ?? "";
  expect(audioFiles()).toHaveLength(2);

  expect((await f.call(narration(deleted.id), "DELETE", undefined, owner)).status).toBe(204);

  // The other record keeps its ready narration and its one file, which still plays; the deleted one is gone and can be made again.
  expect(audioFiles()).toHaveLength(1);
  expect(audioFiles()[0]?.startsWith(kept.id)).toBe(true);
  const after = await read(await f.call(narration(kept.id), "GET", undefined, owner));
  expect(after.narration?.status).toBe("ready");
  expect((await f.call(keptFile, "GET", undefined, owner)).status).toBe(200);
  expect((await read(await f.call(narration(deleted.id), "GET", undefined, owner))).narration).toBeNull();
  expect((await f.call(narration(deleted.id), "POST", {}, owner)).status).toBe(202);
});

test("the listening script drops URLs and Markdown and splits into bounded chunks", () => {
  expect(normalizeScript("## 결론\n- **A** 앱이 [가장 싸다](https://a.example)\n```\ncode\n```\n원문: www.example.com/x")).toBe("결론\nA 앱이 가장 싸다\n\n원문:");
  const long = Array.from({ length: 40 }, (_, index) => `${index + 1}번째 문장은 비교 결과를 설명합니다.`).join(" ");
  const script = normalizeScript(`${long}\n\n${long}\n\n${"가".repeat(NARRATION_LIMITS.scriptChars)}`);
  expect(script.length).toBeLessThanOrEqual(NARRATION_LIMITS.scriptChars);
  const chunks = splitChunks(script);
  expect(chunks.every(chunk => chunk.length > 0 && chunk.length <= NARRATION_LIMITS.chunkChars)).toBe(true);
  expect(chunks.join("").replace(/\s/g, "")).toBe(script.replace(/\s/g, ""));
});

test("the owner narrates a digest's articles; its audio lives under the digest, survives pruning and goes stale when articles are added", async () => {
  const { f, tts, idle } = (await setup());
  const owner = await f.login();
  const upload = (sections: unknown[]) => f.call("/api/v1/digests", "POST", { date: "2026-10-01", slot: "morning", notify: false, sections }, bearer("omo"));
  const created = await upload([{ key: "domestic", title: "Domestic", kind: "articles", items: [{ key: "a", title: "국내 소식", source: "연합뉴스", summary: "요약", url: "https://news.example.com/a" }] }]);
  const id = (await created.json() as { digest: { id: string } }).digest.id;
  const path = `/api/v1/digests/${id}/narration`;
  // When: the owner asks for the digest's narration.
  expect((await f.call(path, "POST", {}, owner)).status).toBe(202);
  await idle();
  (await f.app.purgeTrash());
  // Then: it is ready, made from the digest's articles, with audio under the digest's path.
  const state = await read(await f.call(path, "GET", undefined, owner));
  expect(state.narration).toMatchObject({ status: "ready", stale: false });
  expect(state.narration?.audio?.url).toStartWith(`${path}/audio?v=`);
  expect((await f.call(state.narration?.audio?.url ?? "", "GET", undefined, owner)).status).toBe(200);
  expect(tts.calls.script).toBe(1);
  expect(tts.calls.prompts[0]).toContain("국내 소식");
  // When: messages arrive later the articles audio stays current; more articles make it stale. Agents and unknown digests get no narration.
  await upload([{ key: "inbox", title: "Inbox", kind: "messages", items: [{ key: "m", importance: "check", from: "Carrier", subject: "접속 알림" }] }]);
  expect((await read(await f.call(path, "GET", undefined, owner))).narration?.stale).toBe(false);
  await upload([{ key: "ai", title: "AI", kind: "articles", items: [{ key: "z", title: "AI 소식", source: "Blog", summary: "요약", url: "https://news.example.com/z" }] }]);
  expect((await read(await f.call(path, "GET", undefined, owner))).narration?.stale).toBe(true);
  expect((await f.call(path, "GET", undefined, bearer("omo"))).status).toBe(403);
  expect((await f.call(`/api/v1/digests/${crypto.randomUUID()}/narration`, "GET", undefined, owner)).status).toBe(404);
});

test("the owner narrates a digest's messages on their own: the messages part has its own id, script and audio", async () => {
  const { f, tts, idle } = (await setup());
  const owner = await f.login();
  const created = await f.call("/api/v1/digests", "POST", { date: "2026-10-01", slot: "morning", notify: false, sections: [
    { key: "domestic", title: "Domestic", kind: "articles", items: [{ key: "a", title: "국내 소식", source: "연합뉴스", summary: "요약", url: "https://news.example.com/a" }] },
    { key: "inbox", title: "Inbox", kind: "messages", items: [{ key: "m", importance: "urgent", from: "Carrier", subject: "접속 알림" }] }] }, bearer("omo"));
  const id = (await created.json() as { digest: { id: string } }).digest.id;
  const mailId = digestPartId(id, "messages");
  expect(mailId).not.toBe(id);
  expect(digestPartId(id, "articles")).toBe(id);
  const path = `/api/v1/digests/${mailId}/narration`;
  // When: the owner asks for the messages' narration.
  expect((await f.call(path, "POST", {}, owner)).status).toBe(202);
  await idle();
  (await f.app.purgeTrash());
  // Then: it is made from the messages alone, labelled as digest messages, and its audio lives under the messages part's path.
  expect(tts.calls.prompts[0]).toContain("접속 알림");
  expect(tts.calls.prompts[0]).toContain("Digest messages");
  expect(tts.calls.prompts[0]).not.toContain("국내 소식");
  const state = await read(await f.call(path, "GET", undefined, owner));
  expect(state.narration).toMatchObject({ recordId: mailId, status: "ready", stale: false });
  expect(state.narration?.audio?.url).toStartWith(`${path}/audio?v=`);
  expect((await f.call(state.narration?.audio?.url ?? "", "GET", undefined, owner)).status).toBe(200);
  // And: the articles have no narration yet, and a digest without messages has no messages part.
  expect((await read(await f.call(`/api/v1/digests/${id}/narration`, "GET", undefined, owner))).narration).toBeNull();
  const evening = await f.call("/api/v1/digests", "POST", { date: "2026-10-01", slot: "evening", notify: false, sections: [
    { key: "domestic", title: "Domestic", kind: "articles", items: [{ key: "e", title: "저녁 소식", source: "", summary: "", url: "https://news.example.com/e" }] }] }, bearer("omo"));
  const eveningId = (await evening.json() as { digest: { id: string } }).digest.id;
  expect((await f.call(`/api/v1/digests/${digestPartId(eveningId, "messages")}/narration`, "GET", undefined, owner)).status).toBe(404);
});

test("a digest part whose sections have no items has nothing to narrate: 404 and no script call", async () => {
  const { f, tts, idle } = (await setup());
  const owner = await f.login();
  // Given: a digest with articles and a messages section that only says why it is empty.
  const created = await f.call("/api/v1/digests", "POST", { date: "2026-10-01", slot: "morning", notify: false, sections: [
    { key: "domestic", title: "Domestic", kind: "articles", items: [{ key: "a", title: "국내 소식", source: "연합뉴스", summary: "요약", url: "https://news.example.com/a" }] },
    { key: "inbox", title: "Inbox", kind: "messages", items: [], shortfall: "메일을 읽지 못했어요" }] }, bearer("omo"));
  const id = (await created.json() as { digest: { id: string } }).digest.id;
  const path = `/api/v1/digests/${digestPartId(id, "messages")}/narration`;
  // When: the owner asks for the empty messages part.
  const response = await f.call(path, "POST", {}, owner);
  await idle();
  // Then: there is no such part to narrate, and no script was paid for.
  expect(response.status).toBe(404);
  expect((await f.call(path, "GET", undefined, owner)).status).toBe(404);
  expect(tts.calls.script).toBe(0);
  // And: the part that does have items is still narrated.
  expect((await f.call(`/api/v1/digests/${id}/narration`, "POST", {}, owner)).status).toBe(202);
  await idle();
  expect(tts.calls.script).toBe(1);
});

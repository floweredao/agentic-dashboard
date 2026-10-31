
import { afterEach, expect, test } from "bun:test";

import { bearer } from "./backend-helper";
import { cleanupNarration, deferred, setup, read, research, narration, hold, TWO_CHUNKS } from "./narration-helper";
afterEach(cleanupNarration);

test("with two job slots, two records' audio is made at the same time, a third waits its turn, and one record never runs twice", async () => {
  // Given: two slots and a speech provider that holds every call.
  const { f, tts, idle } = (await setup(undefined, { concurrency: 2 }));
  const owner = await f.login();
  const held = hold(tts);
  const twoSpeaking = deferred<void>();
  let speaking = 0;
  const speak = tts.provider.speak;
  Object.assign(tts.provider, { speak: async (...args: Parameters<typeof speak>) => {
    speaking += 1;
    if (speaking === 2) twoSpeaking.resolve();
    return await speak(...args);
  } });
  const records = [await research(f, owner), await research(f, owner), await research(f, owner)];
  // When: the owner asks for all three.
  for (const record of records) expect((await f.call(narration(record.id), "POST", { style: "read" }, owner)).status).toBe(202);
  // Then: the first two speak at once while the third is still queued, and asking for the first again starts nothing.
  await twoSpeaking.promise;
  expect(speaking).toBe(2);
  expect((await read(await f.call(narration(records[2]?.id ?? ""), "GET", undefined, owner))).narration?.status).toBe("queued");
  expect((await f.call(narration(records[0]?.id ?? ""), "POST", { style: "read" }, owner)).status).not.toBe(202);
  // When: the provider answers.
  held.release.resolve();
  await idle();
  // Then: all three are ready, each scripted once.
  for (const record of records) expect((await read(await f.call(narration(record.id), "GET", undefined, owner))).narration?.status).toBe("ready");
  expect(tts.calls.script).toBe(3);
});

test("cancelling while speaking aborts the call, makes no further call and fails as cancelled without an attempt", async () => {
  const { f, tts, audioFiles, idle } = (await setup());
  const owner = await f.login();
  const record = await research(f, owner);
  tts.scriptText = TWO_CHUNKS;
  const gate = hold(tts);
  // Given: the first of two chunks is being spoken.
  expect((await f.call(narration(record.id), "POST", {}, owner)).status).toBe(202);
  const signal = await gate.entered.promise;
  expect(tts.calls.speak).toHaveLength(1);

  // When: the owner cancels.
  const cancelled = await f.call(`${narration(record.id)}/cancel`, "POST", {}, owner);

  // Then: the in-flight call is aborted, the job fails as cancelled without counting an attempt, and nothing more is spoken.
  expect(cancelled.status).toBe(200);
  expect((await read(cancelled)).narration).toMatchObject({ status: "failed", error: "cancelled", attempts: 0, progress: null });
  expect(signal.aborted).toBe(true);
  await idle();
  expect(tts.calls.speak).toHaveLength(1);
  const after = await read(await f.call(narration(record.id), "GET", undefined, owner));
  expect(after.narration).toMatchObject({ status: "failed", error: "cancelled", attempts: 0, audio: null });
  expect(after.narration?.script).toBeTruthy();
  expect(audioFiles()).toEqual([]);
});

test("while the script streams in, the job reports the characters received against the expected length and when the step began", async () => {
  const { f, tts, idle } = (await setup());
  const owner = await f.login();
  const record = await research(f, owner);
  tts.scriptText = TWO_CHUNKS;
  const gate = (tts.scriptHold = { entered: deferred<AbortSignal>(), release: deferred<void>() });
  // Given: half of the script has streamed in.
  expect((await f.call(narration(record.id), "POST", {}, owner)).status).toBe(202);
  await gate.entered.promise;

  // When: the dashboard asks how far the job is.
  const during = (await read(await f.call(narration(record.id), "GET", undefined, owner))).narration;

  // Then: it reports the characters received over the expected length, and when writing the script began.
  expect(during).toMatchObject({ status: "scripting", progress: { done: Math.floor(TWO_CHUNKS.length / 2) } });
  expect(during?.progress?.total).toBeGreaterThan(0);
  // A first try is not named: the state keeps the shape older clients know.
  expect(Object.keys(during ?? {})).not.toContain("scriptTry");
  expect(Date.parse(during?.stepAt ?? "")).toBeLessThanOrEqual(Date.now());
  gate.release.resolve();
  await idle();
  expect((await read(await f.call(narration(record.id), "GET", undefined, owner))).narration).toMatchObject({ status: "ready", progress: null, stepAt: null });
});

test("while speaking, the step began when the chunk being made started", async () => {
  const { f, tts, idle } = (await setup());
  const owner = await f.login();
  const record = await research(f, owner);
  tts.scriptText = TWO_CHUNKS;
  const gate = hold(tts);
  expect((await f.call(narration(record.id), "POST", {}, owner)).status).toBe(202);
  await gate.entered.promise;
  const speaking = (await read(await f.call(narration(record.id), "GET", undefined, owner))).narration;
  expect(speaking).toMatchObject({ status: "speaking", progress: { done: 0, total: 2 } });
  expect(speaking?.stepAt).toBeString();
  gate.release.resolve();
  await idle();
});

test("cancelling a regeneration keeps the earlier audio ready and playable", async () => {
  const { f, tts, audioFiles, idle } = (await setup());
  const owner = await f.login();
  const record = await research(f, owner);
  await f.call(narration(record.id), "POST", {}, owner);
  await idle();
  const earlier = (await read(await f.call(narration(record.id), "GET", undefined, owner))).narration?.audio?.url ?? "";
  // Given: a forced regeneration is speaking.
  const gate = hold(tts);
  expect((await f.call(narration(record.id), "POST", { force: true }, owner)).status).toBe(202);
  await gate.entered.promise;

  // When: the owner cancels it.
  const cancelled = await read(await f.call(`${narration(record.id)}/cancel`, "POST", {}, owner));
  await idle();

  // Then: the earlier audio is ready again and still served.
  expect(cancelled.narration).toMatchObject({ status: "ready", error: null, progress: null, attempts: 0 });
  expect(cancelled.narration?.audio?.url).toBe(earlier);
  expect((await read(await f.call(narration(record.id), "GET", undefined, owner))).narration).toMatchObject({ status: "ready" });
  expect((await f.call(earlier, "GET", undefined, owner)).status).toBe(200);
  expect(audioFiles()).toHaveLength(1);
});

test("a job cancelled while queued behind another never reaches the provider", async () => {
  const { f, tts, idle } = (await setup());
  const owner = await f.login();
  const first = await research(f, owner);
  const second = await research(f, owner);
  // Given: the first job is speaking and the second waits behind it.
  const gate = hold(tts);
  await f.call(narration(first.id), "POST", {}, owner);
  expect((await read(await f.call(narration(second.id), "POST", {}, owner))).narration?.status).toBe("queued");
  await gate.entered.promise;

  // When: the waiting job is cancelled and the first one finishes.
  const cancelled = await read(await f.call(`${narration(second.id)}/cancel`, "POST", {}, owner));
  gate.release.resolve();
  await idle();

  // Then: only the first job was scripted and spoken.
  expect(cancelled.narration).toMatchObject({ status: "failed", error: "cancelled", attempts: 0 });
  expect((await read(await f.call(narration(first.id), "GET", undefined, owner))).narration?.status).toBe("ready");
  expect((await read(await f.call(narration(second.id), "GET", undefined, owner))).narration).toMatchObject({ status: "failed", error: "cancelled" });
  expect(tts.calls.script).toBe(1);
  expect(tts.calls.speak).toHaveLength(1);
});

test("a new request after a cancel runs to ready and reuses the saved script", async () => {
  const { f, tts, idle } = (await setup());
  const owner = await f.login();
  const record = await research(f, owner);
  const gate = hold(tts);
  await f.call(narration(record.id), "POST", {}, owner);
  await gate.entered.promise;
  await f.call(`${narration(record.id)}/cancel`, "POST", {}, owner);
  tts.hold = null;

  // When: the owner asks again.
  expect((await f.call(narration(record.id), "POST", {}, owner)).status).toBe(202);
  await idle();

  // Then: the new job is not stopped by the old cancel, and the script was not paid for twice.
  expect((await read(await f.call(narration(record.id), "GET", undefined, owner))).narration).toMatchObject({ status: "ready", error: null, attempts: 0 });
  expect(tts.calls.script).toBe(1);
  expect(tts.calls.speak).toHaveLength(2);
});

test("cancel is owner-only with CSRF, answers 404 for unknown ids and works for digests", async () => {
  const { f, tts, idle } = (await setup());
  const owner = await f.login();
  const record = await research(f, owner);
  const { Cookie, Origin } = owner;
  const cancel = `${narration(record.id)}/cancel`;

  // Owner with CSRF: 200 with the state (nothing to stop here), with {} or without a body.
  const idleState = await f.call(cancel, "POST", {}, owner);
  expect(idleState.status).toBe(200);
  expect((await read(idleState)).narration).toBeNull();
  expect((await f.call(cancel, "POST", undefined, owner)).status).toBe(200);
  expect((await f.call(cancel, "POST", { force: true }, owner)).status).toBe(400);
  // Missing CSRF, an agent that can read the record, and an unknown record are refused.
  expect((await f.call(cancel, "POST", {}, { Cookie, Origin })).status).toBe(403);
  const agent = await f.call(cancel, "POST", {}, bearer("omo"));
  expect(agent.status).toBe(403);
  expect(await agent.text()).toContain("Owner session required");
  expect((await f.call(`${narration(crypto.randomUUID())}/cancel`, "POST", {}, owner)).status).toBe(404);

  // A digest's narration is cancelled through its own route.
  const created = await f.call("/api/v1/digests", "POST", { date: "2026-10-01", slot: "morning", notify: false, sections: [
    { key: "domestic", title: "Domestic", kind: "articles", items: [{ key: "a", title: "국내 소식", source: "연합뉴스", summary: "요약", url: "https://news.example.com/a" }] }] }, bearer("omo"));
  const id = (await created.json() as { digest: { id: string } }).digest.id;
  const path = `/api/v1/digests/${id}/narration`;
  const gate = hold(tts);
  expect((await f.call(path, "POST", {}, owner)).status).toBe(202);
  await gate.entered.promise;
  expect((await f.call(`${path}/cancel`, "POST", {}, { Cookie, Origin })).status).toBe(403);
  expect((await f.call(`${path}/cancel`, "POST", {}, bearer("omo"))).status).toBe(403);
  const stopped = await f.call(`${path}/cancel`, "POST", {}, owner);
  expect(stopped.status).toBe(200);
  expect((await read(stopped)).narration).toMatchObject({ status: "failed", error: "cancelled" });
  await idle();
  expect(tts.calls.speak).toHaveLength(1);
  expect((await f.call(`/api/v1/digests/${crypto.randomUUID()}/narration/cancel`, "POST", {}, owner)).status).toBe(404);
});


import { afterEach, expect, test } from "bun:test";

import { NARRATION_LIMITS } from "../shared/contracts";
import { DIGEST_SCRIPT_SYSTEM, missingFigures, normalizeScript, oneSidedTone, plainSentences, ProviderError, SCRIPT_SYSTEM } from "../server/narration";

import { bearer, recordResult } from "./backend-helper";
import { cleanupNarration, deferred, setup, read, research, narration, korean, HAEYO_ONLY, HAMNIDA_ONLY, KYIV, KYIV_SHORT, KYIV_FULL } from "./narration-helper";
afterEach(cleanupNarration);

test("while a retry waits, the narration says until when, and the wait clears once the call goes through", async () => {
  const gate = deferred<void>();
  const entered = deferred<number>();
  const { f, tts, idle } = (await setup(undefined, { sleep: async (ms: number) => { entered.resolve(ms); await gate.promise; } }));
  const owner = await f.login();
  const record = await research(f, owner);
  // Given: the first chunk is rate limited and the provider asks for 7 seconds.
  tts.speakErrors = [Object.assign(new ProviderError("http_429", true), { retryAfterMs: 7000 })];
  await f.call(narration(record.id), "POST", {}, owner);
  expect(await entered.promise).toBe(7000);
  // Then: during the wait the state names the moment the next try starts.
  const waiting = (await read(await f.call(narration(record.id), "GET", undefined, owner))).narration;
  expect(waiting?.status).toBe("speaking");
  const until = Date.parse(waiting?.waitUntil ?? "");
  expect(until - Date.now()).toBeGreaterThan(5000);
  expect(until - Date.now()).toBeLessThanOrEqual(7000);
  // When: the wait ends, the job finishes and no wait is reported.
  gate.resolve();
  await idle();
  expect((await read(await f.call(narration(record.id), "GET", undefined, owner))).narration).toMatchObject({ status: "ready", waitUntil: null });
});

test("a digest is written with the digest instructions (a one- or two-sentence opening, every item), a record with the record ones", async () => {
  const { f, tts, idle } = (await setup());
  const owner = await f.login();
  const created = await f.call("/api/v1/digests", "POST", { date: "2026-10-02", slot: "evening", notify: false, sections: [
    { key: "domestic", title: "Domestic", kind: "articles", items: [{ key: "a", title: "Local news", source: "Wire", summary: "Summary", url: "https://news.example.com/a" }] }] }, bearer("omo"));
  const id = (await created.json() as { digest: { id: string } }).digest.id;
  await f.call(`/api/v1/digests/${id}/narration`, "POST", {}, owner);
  await f.call(narration((await research(f, owner)).id), "POST", {}, owner);
  await idle();
  expect(tts.calls.systems).toEqual([DIGEST_SCRIPT_SYSTEM, korean(SCRIPT_SYSTEM)]);
  expect(DIGEST_SCRIPT_SYSTEM).toContain("one or two sentences");
  expect(tts.calls.prompts[0]).toContain("2026-10-02 evening");
  expect(tts.calls.prompts[0]).toContain("Domestic 1");
});

test("plain (반말) Korean sentence endings are found; 해요체, 습니다체 and lines without an ending are not", () => {
  expect(plainSentences("10월 2일 아침 다이제스트다. 국내 1건이에요.\n\n메일이 왔다! 확인했나요? 확인했습니다.\n\nB: 좋죠. A: 그런가?\n\n국내 소식"))
    .toEqual(["10월 2일 아침 다이제스트다.", "메일이 왔다!", "그런가?"]);
  expect(plainSentences("This is a plain English sentence. Is it?")).toEqual([]);
});

test("a Korean script mixing 해요체 and 습니다체 has no plain sentence and costs one script call", async () => {
  const mixed = "10월 2일 저녁 다이제스트예요. 국내 2건, 해외 1건입니다.\n\n서울시가 지하철을 하루 40회 늘린다고 밝혔습니다. 한국은행은 기준금리를 연 2.5퍼센트로 유지했습니다.\n\n"
    + "해외 소식이에요. 엔화 약세가 이어지고 있습니다. 메시지도 하나 있어요! 서류를 준비하시면 됩니다. 확인하셨나요? 그렇죠. 맞습니까?";
  expect(plainSentences(mixed)).toEqual([]);
  const { f, tts, idle } = (await setup());
  const owner = await f.login();
  tts.scriptText = mixed;
  const record = await research(f, owner);
  await f.call(narration(record.id), "POST", {}, owner);
  await idle();
  expect(tts.calls.script).toBe(1);
  expect(tts.calls.systems).toEqual([korean(SCRIPT_SYSTEM)]);
  expect((await read(await f.call(narration(record.id), "GET", undefined, owner))).narration).toMatchObject({ status: "ready", script: mixed });
});

test("a script of six or more polite sentences with under a fifth in 습니다체 or in 해요체 is one-sided; a mixed or short one is not", () => {
  expect(oneSidedTone(HAEYO_ONLY)).toBe("haeyo");
  expect(oneSidedTone(HAMNIDA_ONLY)).toBe("hamnida");
  // Only the count sentence in 습니다체 among nine others in 해요체.
  expect(oneSidedTone(`${HAEYO_ONLY} 국내 3건입니다. 메일이 왔어요. 확인하셨나요? 그렇죠.`)).toBe("haeyo");
  expect(oneSidedTone("A: 오늘은 금리 이야기예요. 한국은행이 금리를 동결했습니다.\n\nB: 왜 동결했죠? A: 물가가 아직 높습니다. B: 그렇군요. A: 다음 회의는 11월입니다.")).toBeNull();
  expect(oneSidedTone("다이제스트이에요. 국내 1건이에요. 서울 소식이에요. 날씨가 맑아요. 끝이에요.")).toBeNull();
});

test("a one-sided script is written once more with a reminder for the missing tone; a mixed one costs one call", async () => {
  const { f, tts, idle } = (await setup());
  const owner = await f.login();
  const mixed = "10월 3일 저녁 다이제스트이에요. 국내 2건입니다.\n\n서울시가 지하철을 늘린다고 밝혔습니다. 출근길이 조금 나아질 것 같아요.\n\n해외 소식이에요. 엔화 약세가 이어지고 있습니다.";
  expect(oneSidedTone(mixed)).toBeNull();
  // Given: the model first answers in 해요체 only, then mixes both.
  tts.scriptTexts = [HAEYO_ONLY, mixed];
  const first = await research(f, owner);
  await f.call(narration(first.id), "POST", {}, owner);
  await idle();
  // Then: a second call carries the same instructions plus a reminder, and the mixed script is kept.
  expect(tts.calls.script).toBe(2);
  expect(tts.calls.systems[1]?.startsWith(korean(SCRIPT_SYSTEM))).toBe(true);
  const haeyoReminder = tts.calls.systems[1]?.slice(korean(SCRIPT_SYSTEM).length) ?? "";
  expect(haeyoReminder.trim().length).toBeGreaterThan(0);
  expect((await read(await f.call(narration(first.id), "GET", undefined, owner))).narration?.script).toBe(mixed);
  // And: a 습니다체-only script is written again with a different reminder; a second one-sided script is kept rather than paid for again.
  tts.scriptTexts = [HAMNIDA_ONLY, HAMNIDA_ONLY];
  const second = await research(f, owner);
  await f.call(narration(second.id), "POST", {}, owner);
  await idle();
  expect(tts.calls.script).toBe(4);
  const hamnidaReminder = tts.calls.systems[3]?.slice(korean(SCRIPT_SYSTEM).length) ?? "";
  expect(hamnidaReminder.trim().length).toBeGreaterThan(0);
  expect(hamnidaReminder).not.toBe(haeyoReminder);
  expect((await read(await f.call(narration(second.id), "GET", undefined, owner))).narration).toMatchObject({ status: "ready", script: HAMNIDA_ONLY });
  // And: a mixed script costs one call.
  tts.scriptTexts = [mixed];
  await f.call(narration((await research(f, owner)).id), "POST", {}, owner);
  await idle();
  expect(tts.calls.script).toBe(5);
});

test("a Korean script with 반말 endings is written once more with a polite-speech reminder; the second script is used even if it slips again", async () => {
  const { f, tts, idle } = (await setup());
  const owner = await f.login();
  // Given: the model first answers with plain endings, then politely.
  tts.scriptTexts = ["시험 기록이다.\n\n결론은 A가 싸다.", "시험 기록이에요.\n\n결론은 A가 쌉니다."];
  const record = await research(f, owner);
  await f.call(narration(record.id), "POST", {}, owner);
  await idle();
  // Then: a second script call carries the same instructions plus the reminder, and its script is kept.
  expect(tts.calls.script).toBe(2);
  expect(tts.calls.systems[0]).toBe(korean(SCRIPT_SYSTEM));
  expect(tts.calls.systems[1]?.startsWith(korean(SCRIPT_SYSTEM))).toBe(true);
  expect(tts.calls.systems[1]?.length).toBeGreaterThan(korean(SCRIPT_SYSTEM).length);
  expect((await read(await f.call(narration(record.id), "GET", undefined, owner))).narration?.script).toBe("시험 기록이에요.\n\n결론은 A가 쌉니다.");
  // And: a second slip is used rather than failing or paying again.
  tts.scriptTexts = ["반말이다.", "또 반말이다."];
  const twice = await research(f, owner);
  await f.call(narration(twice.id), "POST", {}, owner);
  await idle();
  expect(tts.calls.script).toBe(4);
  expect((await read(await f.call(narration(twice.id), "GET", undefined, owner))).narration).toMatchObject({ status: "ready", script: "또 반말이다." });
});

test("an English record gets no Korean rule and is never asked twice", async () => {
  const { f, tts, idle } = (await setup());
  const owner = await f.login();
  const created = await f.call("/api/v1/records", "POST", { requestId: crypto.randomUUID(), record: {
    kind: "research", title: "Price comparison", body: "App A is the cheapest at five dollars a month.", fields: { summary: "Summary", conclusion: "Pick app A" },
  } }, owner);
  const record = recordResult.parse(await created.json()).record;
  tts.scriptText = "This is the comparison. App A is cheapest.";
  await f.call(narration(record.id), "POST", {}, owner);
  await idle();
  expect(tts.calls.systems).toEqual([SCRIPT_SYSTEM]);
  expect(tts.calls.script).toBe(1);
});

test("the article numbers a digest script never says are found, as digits or as read; messages and model names are not checked", () => {
  const body = `## 국내\n- ${KYIV.title} (${KYIV.source}): ${KYIV.summary}\n- G7 합의 (예시뉴스): G7이 5곳에 1억 배럴을 풀기로 했다.\n\n## 메일\n- [info] 예시은행: 거래내역. 생년월일 6자리로 엽니다.`;
  expect(missingFigures(body, `${KYIV_SHORT} G7이 다섯 곳에 일억 배럴을 풀기로 했습니다.`)).toEqual([{ title: KYIV.title, figures: ["5시", "40분"] }]);
  expect(missingFigures(body, `${KYIV_FULL} G7이 5곳에 1억 배럴을 풀기로 했습니다.`)).toEqual([]);
});

test("a Korean digest script that drops a summary's middle sentence is written once more naming what it lost; a full one costs one call", async () => {
  const { f, tts, idle } = (await setup());
  const owner = await f.login();
  const digest = async (date: string) => {
    const created = await f.call("/api/v1/digests", "POST", { date, slot: "morning", notify: false,
      sections: [{ key: "domestic", title: "국내", kind: "articles", items: [KYIV] }] }, bearer("omo"));
    return (await created.json() as { digest: { id: string } }).digest.id;
  };
  // Given: the model first reads the first and last sentences only, then the whole summary.
  tts.scriptTexts = [KYIV_SHORT, KYIV_FULL];
  const first = await digest("2026-10-04");
  await f.call(`/api/v1/digests/${first}/narration`, "POST", {}, owner);
  await idle();
  // Then: the second call carries the digest instructions plus the item and the time it lost, and its script is kept.
  expect(tts.calls.script).toBe(2);
  expect(tts.calls.systems[1]?.startsWith(korean(DIGEST_SCRIPT_SYSTEM))).toBe(true);
  expect(tts.calls.systems[1]?.slice(korean(DIGEST_SCRIPT_SYSTEM).length)).toContain(`'${KYIV.title}'의 5시, 40분`);
  expect((await read(await f.call(`/api/v1/digests/${first}/narration`, "GET", undefined, owner))).narration?.script).toBe(KYIV_FULL);
  // And: a script with every fact costs one call.
  tts.scriptTexts = [KYIV_FULL];
  await f.call(`/api/v1/digests/${await digest("2026-10-05")}/narration`, "POST", {}, owner);
  await idle();
  expect(tts.calls.script).toBe(3);
});

test("what is spoken reads each number by its unit, while the saved script keeps the digits", async () => {
  const { f, tts, idle } = (await setup());
  const owner = await f.login();
  tts.scriptText = "올해 5곳의 전셋값이 10% 넘게 올랐습니다. 다음 발표는 6월 3일 오후 12시예요.";
  const record = await research(f, owner);
  await f.call(narration(record.id), "POST", {}, owner);
  await idle();
  expect(tts.calls.speak).toEqual(["올해 다섯 곳의 전셋값이 십 퍼센트 넘게 올랐습니다. 다음 발표는 유월 삼 일 오후 열두 시예요."]);
  expect((await read(await f.call(narration(record.id), "GET", undefined, owner))).narration?.script).toBe(tts.scriptText);
  // And: a podcast turn is read the same way.
  tts.scriptText = "A: 후보는 3곳입니다.\n\nB: 2명이 골랐죠?";
  const podcast = await research(f, owner);
  await f.call(narration(podcast.id), "POST", { style: "podcast" }, owner);
  await idle();
  expect(tts.calls.converse.at(-1)).toEqual([{ speaker: "A", text: "후보는 세 곳입니다." }, { speaker: "B", text: "두 명이 골랐죠?" }]);
});

test("a digest script may run past a record's cap up to the digest cap", () => {
  const long = Array.from({ length: 80 }, (_, index) => `${index}번 항목의 사실을 빠짐없이 전합니다. ${"가".repeat(90)}.`).join("\n\n");
  expect(normalizeScript(long).length).toBeLessThanOrEqual(NARRATION_LIMITS.scriptChars);
  const digest = normalizeScript(long, NARRATION_LIMITS.digestScriptChars);
  expect(digest.length).toBeGreaterThan(NARRATION_LIMITS.scriptChars);
  expect(digest.length).toBeLessThanOrEqual(NARRATION_LIMITS.digestScriptChars);
});

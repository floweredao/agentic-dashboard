
import { afterEach, expect, test } from "bun:test";

import { digestOfPartId, digestPartId, NARRATION_LIMITS } from "../shared/contracts";
import { dialogueChunks, listeningSource, normalizeScript, PODCAST_SCRIPT_SYSTEM, SCRIPT_SYSTEM, scriptParts } from "../server/narration";

import { agentRecord, bearer, recordResult } from "./backend-helper";
import { cleanupNarration, SCRIPT, setup, read, research, narration, korean, hold, DIALOGUE, SOURCES_BODY } from "./narration-helper";
afterEach(cleanupNarration);

test("the owner narrates a whole digest at once, articles then messages, under its own id beside the separate parts", async () => {
  const { f, tts, idle } = (await setup());
  const owner = await f.login();
  const upload = (sections: unknown[]) => f.call("/api/v1/digests", "POST", { date: "2026-10-01", slot: "morning", notify: false, sections }, bearer("omo"));
  const created = await upload([
    { key: "domestic", title: "Domestic", kind: "articles", items: [{ key: "a", title: "Local news", source: "Wire", summary: "Summary", url: "https://news.example.com/a" }] },
    { key: "inbox", title: "Inbox", kind: "messages", items: [{ key: "m", importance: "urgent", from: "Carrier", subject: "Sign-in alert" }] }]);
  const id = (await created.json() as { digest: { id: string } }).digest.id;
  const allId = digestPartId(id, "all");
  // The whole digest has an id of its own that maps back, distinct from both parts.
  expect(new Set([allId, id, digestPartId(id, "messages")]).size).toBe(3);
  expect(digestOfPartId(allId)).toEqual({ id, part: "all" });
  const path = `/api/v1/digests/${allId}/narration`;
  // When: the owner asks for the whole digest.
  expect((await f.call(path, "POST", {}, owner)).status).toBe(202);
  await idle();
  // Then: one script covers the articles, then the messages.
  const prompt = tts.calls.prompts[0] ?? "";
  expect(prompt).toContain("Whole digest");
  expect(prompt.indexOf("Local news")).toBeGreaterThan(-1);
  expect(prompt.indexOf("Sign-in alert")).toBeGreaterThan(prompt.indexOf("Local news"));
  const state = await read(await f.call(path, "GET", undefined, owner));
  expect(state.narration).toMatchObject({ recordId: allId, status: "ready", stale: false });
  expect(state.narration?.audio?.url).toStartWith(`${path}/audio?v=`);
  expect((await f.call(state.narration?.audio?.url ?? "", "GET", undefined, owner)).status).toBe(200);
  // And: the parts keep their own (still empty) narrations, and new messages make the whole audio stale.
  expect((await read(await f.call(`/api/v1/digests/${id}/narration`, "GET", undefined, owner))).narration).toBeNull();
  await upload([{ key: "inbox", title: "Inbox", kind: "messages", items: [{ key: "n", importance: "todo", from: "Bank", subject: "Deposit notice" }] }]);
  expect((await read(await f.call(path, "GET", undefined, owner))).narration?.stale).toBe(true);
  expect((await f.call(path, "POST", { style: "podcast" }, owner)).status).toBe(400);
});

test("a podcast narration writes a two-host script, speaks it as dialogue turns and becomes the default for the next request", async () => {
  const { f, tts, idle } = (await setup());
  const owner = await f.login();
  const record = await research(f, owner);
  tts.scriptText = DIALOGUE;

  // When: the owner picks Podcast.
  const queued = await f.call(narration(record.id), "POST", { style: "podcast" }, owner);
  expect(queued.status).toBe(202);
  expect((await read(queued)).narration?.style).toBe("podcast");
  await idle();

  // Then: the script was asked for as a dialogue and reached the provider as A/B turns with both hosts, not read by one voice.
  expect(tts.calls.systems).toEqual([korean(PODCAST_SCRIPT_SYSTEM)]);
  expect(tts.calls.speak).toEqual([]);
  expect(tts.calls.converse).toEqual([[
    { speaker: "A", text: "Today we look at the app price comparison." },
    { speaker: "B", text: "Shall we start with the conclusion?" },
    { speaker: "A", text: "The cheapest is app A.\nIt costs five dollars a month." },
  ]]);
  const ready = await read(await f.call(narration(record.id), "GET", undefined, owner));
  expect(ready.narration).toMatchObject({ status: "ready", style: "podcast", stale: false });
  expect(ready.narration?.audio).toMatchObject({ style: "podcast", voice: "Kore, Puck" });

  // And: a request without a style keeps Podcast and, for unchanged content, makes nothing new.
  const again = await f.call(narration(record.id), "POST", {}, owner);
  expect(again.status).toBe(200);
  expect((await read(again)).narration?.style).toBe("podcast");
  expect(tts.calls.script).toBe(1);

  // And: switching to Read aloud makes a new read script and audio, which then becomes the default.
  tts.scriptText = SCRIPT;
  expect((await f.call(narration(record.id), "POST", { style: "read" }, owner)).status).toBe(202);
  await idle();
  expect(tts.calls.systems).toEqual([korean(PODCAST_SCRIPT_SYSTEM), korean(SCRIPT_SYSTEM)]);
  expect(tts.calls.speak).toHaveLength(1);
  const read2 = await read(await f.call(narration(record.id), "GET", undefined, owner));
  expect(read2.narration).toMatchObject({ status: "ready", style: "read" });
  expect(read2.narration?.audio).toMatchObject({ style: "read", voice: "Kore" });
  expect((await f.call(narration(record.id), "POST", {}, owner)).status).toBe(200);
});

test("cancelling a podcast over earlier read audio keeps Read aloud as the default", async () => {
  const { f, tts, idle } = (await setup());
  const owner = await f.login();
  const record = await research(f, owner);
  await f.call(narration(record.id), "POST", {}, owner);
  await idle();
  tts.scriptText = DIALOGUE;
  // Given: a podcast is being spoken over the earlier read audio.
  const gate = hold(tts);
  const started = await read(await f.call(narration(record.id), "POST", { style: "podcast" }, owner));
  expect(started.narration?.style).toBe("podcast");
  await gate.entered.promise;
  // When: the owner cancels it.
  const cancelled = await read(await f.call(`${narration(record.id)}/cancel`, "POST", {}, owner));
  await idle();
  // Then: the earlier read audio is ready and Read aloud stays the default.
  expect(tts.calls.converse).toHaveLength(1);
  expect(cancelled.narration).toMatchObject({ status: "ready", style: "read" });
  expect(cancelled.narration?.audio?.style).toBe("read");
});

test("digests are always read aloud: a podcast request is refused, and an unknown style is invalid", async () => {
  const { f, tts, idle } = (await setup());
  const owner = await f.login();
  const created = await f.call("/api/v1/digests", "POST", { date: "2026-10-01", slot: "morning", notify: false, sections: [
    { key: "domestic", title: "Domestic", kind: "articles", items: [{ key: "a", title: "Local news", source: "Wire", summary: "Summary", url: "https://news.example.com/a" }] }] }, bearer("omo"));
  const id = (await created.json() as { digest: { id: string } }).digest.id;
  const path = `/api/v1/digests/${id}/narration`;
  const refused = await f.call(path, "POST", { style: "podcast" }, owner);
  expect(refused.status).toBe(400);
  expect(await refused.text()).toContain("narration_style_unsupported");
  expect(tts.calls.script).toBe(0);
  expect((await f.call(path, "POST", { style: "read" }, owner)).status).toBe(202);
  await idle();
  expect((await read(await f.call(path, "GET", undefined, owner))).narration).toMatchObject({ status: "ready", style: "read" });
  expect(tts.calls.converse).toEqual([]);
  const record = await research(f, owner);
  expect((await f.call(narration(record.id), "POST", { style: "radio" }, owner)).status).toBe(400);
  // An agent may choose the style too.
  expect((await f.call(narration(record.id), "POST", { style: "podcast" }, bearer("omo"))).status).toBe(202);
});

test("a dialogue script becomes speaker turns packed into bounded chunks", () => {
  // Unlabelled lines continue the previous speaker (A at the start); full-width colons and spaces are accepted.
  expect(dialogueChunks("Opening\n\nB： A question?\n\nA line that carries on\n\nA:An answer.")).toEqual([[
    { speaker: "A", text: "Opening" }, { speaker: "B", text: "A question?\n\nA line that carries on" }, { speaker: "A", text: "An answer." },
  ]]);
  const long = Array.from({ length: 12 }, (_, index) => `${index % 2 ? "B" : "A"}: ${"This is a sentence. ".repeat(25)}`).join("\n\n");
  const chunks = dialogueChunks(normalizeScript(long));
  expect(chunks.length).toBeGreaterThan(1);
  for (const chunk of chunks) expect(chunk.reduce((sum, turn) => sum + turn.text.length, 0)).toBeLessThanOrEqual(NARRATION_LIMITS.chunkChars);
  expect(chunks.flat().every(turn => turn.text.length > 0 && !/^[AB]\s*[:：]/.test(turn.text))).toBe(true);
});

test("the listening source leaves out code, tables, link-only lines and the source list, and keeps every prose section", () => {
  const source = listeningSource(SOURCES_BODY);
  for (const kept of ["## 배경", "본문 첫 문단입니다.", "## 관찰", "관찰 문단입니다.", "## 다음", "마지막 문단입니다."]) expect(source).toContain(kept);
  for (const dropped of ["secret", "| A | 1 |", "링크만", "## 출처", "예시뉴스 기사", "논문 원문"]) expect(source).not.toContain(dropped);
  expect(listeningSource("## References\n- a\n## 참고 자료\n- b\n## 결론\n남는 문단")).toBe("## 결론\n남는 문단");
  expect(listeningSource("## 13. 질문\n질문과 답\n## 15. 출처\n- 논문 원문\n### 원문 링크\n- 참고 링크\n## 16. 결론\n마지막 내용"))
    .toBe("## 13. 질문\n질문과 답\n## 16. 결론\n마지막 내용");
});

for (const style of ["read", "podcast"] as const) test(`a ${style} script keeps the last answer beyond the former 6000-character cap`, async () => {
  const { f, tts, idle } = (await setup());
  const owner = await f.login();
  const body = `${"원문의 문단입니다. 설명이 이어져요.\n\n".repeat(200)}## 끝 질문\n답은 마지막 확인입니다.`;
  const response = await f.call("/api/v1/records", "POST", {
    requestId: crypto.randomUUID(), record: agentRecord({ body }),
  }, owner);
  expect(response.status).toBe(201);
  const record = recordResult.parse(await response.json()).record;
  const paragraphs = Array.from({ length: 180 }, () => style === "podcast"
    ? "A: 원문의 사실을 빠짐없이 전합니다.\n\nB: 이어지는 설명도 그대로 들어요."
    : "원문의 사실을 빠짐없이 전합니다. 이어지는 설명도 그대로 들어요.");
  const lastAnswer = "답은 마지막 확인입니다. 이 답까지 들어요.";
  tts.scriptText = [...paragraphs, `${style === "podcast" ? "A: " : ""}${lastAnswer}`].join("\n\n");
  expect(tts.scriptText.length).toBeGreaterThan(6000);
  expect((await f.call(narration(record.id), "POST", { style }, owner)).status).toBe(202);
  await idle();
  const state = await read(await f.call(narration(record.id), "GET", undefined, owner));
  expect(state.narration?.status).toBe("ready");
  expect(state.narration?.audio?.style).toBe(style);
  expect(state.narration?.script?.endsWith(lastAnswer)).toBe(true);
  const spoken = style === "podcast" ? tts.calls.converse.flat().map(turn => turn.text) : tts.calls.speak;
  expect(spoken.at(-1)).toContain(lastAnswer);
});

test("an oversized record script fails instead of speaking a silently truncated document", async () => {
  const { f, tts, idle } = (await setup());
  const owner = await f.login();
  const record = await research(f, owner);
  tts.scriptText = "원문의 설명입니다. 내용이 이어져요. ".repeat(1000);
  expect(tts.scriptText.length).toBeGreaterThan(NARRATION_LIMITS.partScriptChars);
  expect((await f.call(narration(record.id), "POST", {}, owner)).status).toBe(202);
  await idle();
  const state = await read(await f.call(narration(record.id), "GET", undefined, owner));
  expect(state.narration).toMatchObject({ status: "failed", error: "script_too_long", audio: null });
  expect(tts.calls.speak).toHaveLength(0);
});

test("a long body is split into parts at its headings, each within the part length, together covering the whole body", () => {
  const sections = Array.from({ length: 6 }, (_, index) => `## 절 ${index + 1}\n${`절 ${index + 1}의 문장입니다. `.repeat(400).trim()}`);
  const body = sections.join("\n\n");
  const parts = scriptParts(body);
  expect(parts.length).toBeGreaterThan(1);
  for (const part of parts) expect(part.length).toBeLessThanOrEqual(NARRATION_LIMITS.partChars);
  for (const section of sections) expect(parts.some(part => part.includes(section))).toBe(true);
  expect(parts.every(part => part.startsWith("## 절"))).toBe(true);
  expect(scriptParts("짧은 본문")).toEqual(["짧은 본문"]);
  const oneParagraph = "긴 문단입니다. ".repeat(4000);
  expect(scriptParts(oneParagraph).every(part => part.length <= NARRATION_LIMITS.partChars)).toBe(true);
  expect(scriptParts(oneParagraph).join("").replace(/\s/g, "")).toBe(oneParagraph.replace(/\s/g, ""));
});

test("a record past the part length is scripted part by part: every part reaches the script model, the audio covers all of them", async () => {
  const { f, tts, idle } = (await setup());
  const owner = await f.login();
  const sections = Array.from({ length: 4 }, (_, index) => `## 절 ${index + 1}\n${`절 ${index + 1}의 내용입니다. `.repeat(500)}`);
  const body = [...sections, "## 출처\n- 원문 https://example.com/source"].join("\n\n");
  const response = await f.call("/api/v1/records", "POST", { requestId: crypto.randomUUID(), record: {
    kind: "research", title: "긴 조사", body, fields: { summary: "요약", conclusion: "결론", nextActions: "- 다음 할 일" } } }, owner);
  const record = recordResult.parse(await response.json()).record;
  const partCount = scriptParts(listeningSource(body)).length;
  expect(partCount).toBeGreaterThan(1);
  tts.scriptTexts = Array.from({ length: partCount }, (_, index) => `${index + 1}번째 부분을 전합니다. 내용이 이어져요. ${"본문의 문장을 그대로 전합니다. 이어서 들어요. ".repeat(160)}`.trim());
  expect((await f.call(narration(record.id), "POST", {}, owner)).status).toBe(202);
  await idle();
  const state = await read(await f.call(narration(record.id), "GET", undefined, owner));
  expect(state.narration?.status).toBe("ready");
  expect(tts.calls.script).toBe(partCount);
  for (const [index, section] of sections.entries()) expect(tts.calls.prompts.some(prompt => prompt.includes(section.split("\n")[0] ?? "") && prompt.includes(`절 ${index + 1}의 내용입니다.`))).toBe(true);
  expect(tts.calls.prompts.every(prompt => !prompt.includes("example.com/source"))).toBe(true);
  expect(tts.calls.prompts[0]).toContain(`[Body 1/${partCount}]`);
  expect(tts.calls.systems[0]).not.toBe(tts.calls.systems[partCount - 1]);
  for (let index = 0; index < partCount; index += 1) expect(state.narration?.script).toContain(`${index + 1}번째 부분을 전합니다.`);
});

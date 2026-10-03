import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { NarrationStateSchema } from "../../shared/contracts";
import type { NarrationState } from "../../shared/contracts";
import { clock, initialRate, NarrationBar, narrationFailure, narrationItems, StyleChoice } from "./Listen";

const record = { id: "00000000-0000-4000-8000-000000000201", title: "조사" };
const base = {
  recordId: record.id, style: "read" as const, stale: false, progress: null, attempts: 0, error: null, requestedBy: "owner",
  requestedAt: "2026-10-01T12:00:00Z", updatedAt: "2026-10-01T12:00:00Z", audio: null, script: null,
};
const audio = { url: `/api/v1/records/${record.id}/narration/audio?v=abcd1234`, mime: "audio/mp4", bytes: 1000, durationMs: 754_000,
  model: "gemini-3.8-flash-tts", voice: "Kore", style: "read" as const, createdAt: "2026-10-01T12:01:00Z" };
const noop = () => {};
const parse = (state: NarrationState) => NarrationStateSchema.parse(state);
const bar = (state: NarrationState, extra: { cancelling?: boolean; open?: boolean; label?: string } = {}) => renderToStaticMarkup(
  <NarrationBar record={record} state={parse(state)} label={extra.label} pending={false} cancelling={extra.cancelling ?? false}
    dismissed={false} open={extra.open ?? false} playNonce={0}
    onCancel={noop} onRetry={noop} onDismiss={noop} onOpen={noop} onFold={noop} />);
const items = (state: NarrationState, label?: string) => narrationItems(parse(state), {
  pending: false, cancelling: false, label, onRequest: noop, onMake: noop, onCancel: noop, onListen: noop, onScript: noop, onRemove: noop,
});
const labels = (state: NarrationState, label?: string) => items(state, label).map(item => item.label);
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

test("without narration there is no bar and the menu offers 음성 만들기, disabled with the reason when no key is set", () => {
  // Given no narration
  // When the bar and the menu items are built
  // Then nothing is shown and the menu has the make command
  expect(bar({ narration: null, available: true })).toBe("");
  expect(labels({ narration: null, available: true })).toEqual(["음성 만들기"]);
  const missing = items({ narration: null, available: false });
  expect(missing.map(item => [item.label, item.disabled])).toEqual([["음성 만들기 · 키 필요", true]]);
});

test("a running job shows one compact row with its stage, honest progress and a cancel x", () => {
  // Given a job that is drafting the script, then one speaking part 2 of 5
  const scripting = bar({ narration: { ...base, status: "scripting" }, available: true });
  const speaking = bar({ narration: { ...base, status: "speaking", progress: { done: 2, total: 5 } }, available: true });
  // Then the stage is stated, progress is determinate only with a real count, and x cancels
  expect(scripting).toContain('class="listen-bar listen-working" role="status"');
  expect(text(scripting)).toContain("원고를 다듬는 중");
  expect(scripting).toMatch(/<progress aria-label="[^"]+"><\/progress>/);
  expect(speaking).toMatch(/<progress aria-label="[^"]+" max="5" value="2"><\/progress>/);
  expect(text(speaking)).toContain("음성을 만드는 중 2/5");
  expect(speaking).toMatch(/<button[^>]*aria-label="음성 만들기 취소"/);
  expect(labels({ narration: { ...base, status: "queued" }, available: true })).toEqual(["음성 만들기 취소"]);
});

test("while the cancel is in flight the row says 취소하는 중 and the x is disabled", () => {
  // Given x was pressed and the server has not answered yet
  const html = bar({ narration: { ...base, status: "speaking", progress: { done: 1, total: 5 } }, available: true }, { cancelling: true });
  // Then nothing claims it is cancelled
  expect(text(html)).toContain("취소하는 중");
  expect(html).not.toContain("<progress");
  expect(html).toMatch(/<button[^>]*aria-label="음성 만들기 취소"[^>]*disabled=""/);
});

test("finished audio shows a folded player, and the menu offers 듣기, 다시 만들기, 원고 보기 and 음성 삭제", () => {
  // Given finished audio with a script
  const state = { narration: { ...base, status: "ready" as const, audio, script: "첫 문단.\n\n둘째 문단." }, available: true };
  // When folded, then opened
  const folded = bar(state);
  const open = bar(state, { open: true });
  // Then folded is a button with the length; open is one row with seek, time, rate and fold
  expect(text(folded)).toContain("듣기 · 13분");
  expect(folded).not.toContain('type="range"');
  expect(folded).toContain(`src="${audio.url}"`);
  expect(folded).not.toContain("예전 내용");
  expect(open).toContain('class="listen-bar listen-player"');
  expect(open).toContain('type="range"');
  expect(open).toContain('aria-label="재생"');
  expect(open).toContain('aria-label="플레이어 접기"');
  expect(text(open)).toContain("0:00 / 12:34");
  expect(labels(state)).toEqual(["듣기", "다시 만들기", "원고 보기", "음성 삭제"]);
  expect(items(state).find(item => item.label === "음성 삭제")?.danger).toBe(true);
});

test("stale audio is tagged 예전 내용 and offers 새로 만들기 instead of 다시 만들기", () => {
  const state = { narration: { ...base, status: "ready" as const, stale: true, audio }, available: true };
  expect(text(bar(state))).toContain("듣기 · 13분 예전 내용");
  expect(labels(state)).toEqual(["듣기", "새로 만들기", "음성 삭제"]);
});

test("a failure is an alert in Korean with 다시 시도; a cancel is not a failure", () => {
  // Given a failed job, and a cancelled one without earlier audio
  const failed = { narration: { ...base, status: "failed" as const, attempts: 3, error: "http_403" }, available: true };
  const cancelled = { narration: { ...base, status: "failed" as const, attempts: 0, error: "cancelled" }, available: true };
  // Then only the failure shows a row; the cancel leaves nothing but 음성 만들기
  const html = bar(failed);
  expect(html).toContain('role="alert"');
  expect(text(html)).toContain("Gemini가 API 키를 거절했어요. 다시 시도");
  expect(labels(failed)).toEqual(["다시 시도"]);
  expect(bar(cancelled)).toBe("");
  expect(labels(cancelled)).toEqual(["음성 만들기"]);
});

test("each cause of a failure reads differently: a busy server, a per-minute limit, today's free quota used up, depleted credits", () => {
  const [busy, server, minute, daily, credits] = ["http_503", "http_500", "http_429", "quota_daily", "http_402"].map(code => narrationFailure(code));
  expect(busy).toBe(server);
  expect(new Set([busy, minute, daily, credits, narrationFailure(null)]).size).toBe(5);
  expect(daily).toContain("무료 한도");
  expect(daily).toContain("내일");
});

test("a label prefixes the commands and the row text for the digest 전체 view", () => {
  expect(labels({ narration: null, available: true }, "메일")).toEqual(["메일 음성 만들기"]);
  const html = bar({ narration: { ...base, status: "queued" }, available: true }, { label: "뉴스" });
  expect(text(html)).toContain("뉴스 만들 차례를 기다리는 중");
  expect(html).toContain('aria-label="뉴스 음성 만들기 취소"');
});

test("the player starts at 1x unless the owner chose a rate, and a rate the owner chose is kept", () => {
  // Given nothing stored, a rate the owner picked, the old key's value, and junk
  const from = (values: Record<string, string>) => initialRate(key => values[key] ?? null);
  // Then the default is 1x, a picked rate wins over the old key, and junk falls back to 1x
  expect(from({})).toBe(1);
  expect(from({ "agentic:listen-rate-v2": "1.25" })).toBe(1.25);
  expect(from({ "agentic:listen-rate-v2": "2", "agentic:listen-rate": "1.5" })).toBe(2);
  expect(from({ "agentic:listen-rate": "1" })).toBe(1);
  expect(from({ "agentic:listen-rate": "1.5" })).toBe(1.5);
  expect(from({ "agentic:listen-rate-v2": "3" })).toBe(1);
  // And the open player shows the default on its rate button
  const html = bar({ narration: { ...base, status: "ready", audio }, available: true }, { open: true });
  expect(html).toContain('aria-label="재생 속도 1배"');
});

test("making, remaking and renewing go through the style choice; 다시 시도 retries with the saved style", () => {
  // Given a recorder for the two kinds of request
  const calls: string[] = [];
  const recorded = (state: NarrationState) => narrationItems(parse(state), {
    pending: false, cancelling: false, onCancel: noop, onListen: noop, onScript: noop, onRemove: noop,
    onRequest: force => calls.push(`request:${force}`), onMake: force => calls.push(`make:${force}`),
  });
  const pick = (state: NarrationState, label: string) => recorded(state).find(item => item.label === label)?.onSelect();
  // When each command is chosen
  pick({ narration: null, available: true }, "음성 만들기");
  pick({ narration: { ...base, status: "ready", audio }, available: true }, "다시 만들기");
  pick({ narration: { ...base, status: "ready", stale: true, audio }, available: true }, "새로 만들기");
  pick({ narration: { ...base, status: "failed", attempts: 1, error: "http_500" }, available: true }, "다시 시도");
  // Then only 다시 시도 skips the choice
  expect(calls).toEqual(["make:false", "make:true", "make:false", "request:false"]);
});

test("the style choice offers 낭독 and 팟캐스트 with the saved style checked, and warns about the cost when remaking", () => {
  // Given the choice for a record last made as a podcast, once fresh and once as a remake
  const fresh = renderToStaticMarkup(<StyleChoice initial="podcast" force={false} pending={false} onSubmit={noop} onClose={noop} />);
  const remake = renderToStaticMarkup(<StyleChoice initial="read" force pending={false} onSubmit={noop} onClose={noop} />);
  // Then both options are radios in one group, the saved one checked
  const checked = (html: string) => [...html.matchAll(/<input[^>]*>/g)].filter(tag => tag[0].includes('checked=""'))
    .map(tag => /value="(\w+)"/.exec(tag[0])?.[1]);
  expect([...fresh.matchAll(/<input[^>]*>/g)].filter(tag => tag[0].includes('type="radio"') && tag[0].includes('name="narration-style"'))).toHaveLength(2);
  expect(checked(fresh)).toEqual(["podcast"]);
  expect(text(fresh)).toContain("낭독");
  expect(text(fresh)).toContain("팟캐스트");
  expect(text(fresh)).not.toContain("요금");
  expect(checked(remake)).toEqual(["read"]);
  expect(text(remake)).toContain("요금이 한 번 더 들어요");
});

test("podcast audio is tagged 팟캐스트 on the folded player", () => {
  const state = { narration: { ...base, status: "ready" as const, style: "podcast" as const, audio: { ...audio, style: "podcast" as const } }, available: true };
  expect(text(bar(state))).toContain("듣기 · 13분 팟캐스트");
  expect(text(bar({ narration: { ...base, status: "ready", audio }, available: true }))).not.toContain("팟캐스트");
});

test("clock formats seconds as m:ss and h:mm:ss", () => {
  expect([clock(0), clock(65.9), clock(3725), clock(Number.NaN)]).toEqual(["0:00", "1:05", "1:02:05", "0:00"]);
});

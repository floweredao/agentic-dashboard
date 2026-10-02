import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { NarrationStateSchema } from "../../shared/contracts";
import type { NarrationState } from "../../shared/contracts";
import { clock, NarrationBar, narrationItems } from "./Listen";

const record = { id: "00000000-0000-4000-8000-000000000201", title: "조사" };
const base = {
  recordId: record.id, stale: false, progress: null, attempts: 0, error: null, requestedBy: "owner",
  requestedAt: "2026-10-01T12:00:00Z", updatedAt: "2026-10-01T12:00:00Z", audio: null, script: null,
};
const audio = { url: `/api/v1/records/${record.id}/narration/audio?v=abcd1234`, mime: "audio/mp4", bytes: 1000, durationMs: 754_000,
  model: "gemini-3.8-flash-tts", voice: "Kore", createdAt: "2026-10-01T12:01:00Z" };
const noop = () => {};
const parse = (state: NarrationState) => NarrationStateSchema.parse(state);
const bar = (state: NarrationState, extra: { cancelling?: boolean; open?: boolean; label?: string } = {}) => renderToStaticMarkup(
  <NarrationBar record={record} state={parse(state)} label={extra.label} pending={false} cancelling={extra.cancelling ?? false}
    dismissed={false} open={extra.open ?? false} playNonce={0}
    onCancel={noop} onRetry={noop} onDismiss={noop} onOpen={noop} onFold={noop} />);
const items = (state: NarrationState, label?: string) => narrationItems(parse(state), {
  pending: false, cancelling: false, label, onRequest: noop, onCancel: noop, onListen: noop, onScript: noop, onRemove: noop,
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

test("a label prefixes the commands and the row text for the digest 전체 view", () => {
  expect(labels({ narration: null, available: true }, "메일")).toEqual(["메일 음성 만들기"]);
  const html = bar({ narration: { ...base, status: "queued" }, available: true }, { label: "뉴스" });
  expect(text(html)).toContain("뉴스 만들 차례를 기다리는 중");
  expect(html).toContain('aria-label="뉴스 음성 만들기 취소"');
});

test("clock formats seconds as m:ss and h:mm:ss", () => {
  expect([clock(0), clock(65.9), clock(3725), clock(Number.NaN)]).toEqual(["0:00", "1:05", "1:02:05", "0:00"]);
});

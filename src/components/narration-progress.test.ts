import { expect, test } from "bun:test";
import type { Narration } from "../../shared/contracts";
import { narrationStage } from "./narration-progress";

const since = Date.parse("2026-10-02T12:00:00.000Z");
const base: Narration = {
  recordId: "00000000-0000-4000-8000-000000000201", status: "queued", style: "read", stale: false, progress: null, waitUntil: null,
  stepAt: null, attempts: 0, error: null, requestedBy: "owner", requestedAt: "2026-10-02T12:00:00.000Z", updatedAt: "2026-10-02T12:00:00.000Z",
  audio: null, script: null,
};
const job = (changes: Partial<Narration>): Narration => ({ ...base, ...changes });

test("each real stage the server reports has its own value, in order, and time passing alone never moves it", () => {
  const jobs = [
    job({ status: "queued" }), job({ status: "scripting" }),
    job({ status: "speaking", progress: { done: 0, total: 2 } }), job({ status: "speaking", progress: { done: 1, total: 2 } }),
    job({ status: "speaking", progress: { done: 2, total: 2 } }), job({ status: "ready" }),
  ];
  expect(jobs.map(each => [narrationStage(each, since).label, narrationStage(each, since).value])).toEqual([
    ["차례를 기다리고 있어요", 0], ["원고를 쓰고 있어요", 4], ["음성을 만들고 있어요 1/2", 30], ["음성을 만들고 있어요 2/2", 62.5],
    ["파일로 저장하고 있어요", 95], ["다 만들었어요", 100],
  ]);
  // The same server state a minute later is the same value: nothing is filled in while nothing happens.
  for (const each of jobs) expect(narrationStage(each, since + 60_000).value).toBe(narrationStage(each, since).value);
  // One chunk is no count to show.
  expect(narrationStage(job({ status: "speaking", progress: { done: 0, total: 1 } }), since).label).toBe("음성을 만들고 있어요");
});

test("a finished chunk raises the bar by exactly its share of the speech", () => {
  const at = (done: number) => narrationStage(job({ status: "speaking", progress: { done, total: 4 } }), since).value;
  expect(at(2) - at(1)).toBe(16.25);
  expect(at(4) - at(3)).toBe(16.25);
});

test("the script's characters received so far over its expected length fill the script's share, never past it", () => {
  const at = (done: number, total: number) => narrationStage(job({ status: "scripting", progress: { done, total } }), since).value;
  expect(at(0, 1000)).toBe(4);
  expect(at(500, 1000)).toBe(17);
  expect(at(1000, 1000)).toBe(30);
  // A script longer than expected stays at the end of its share until speech starts.
  expect(at(1500, 1000)).toBe(30);
});

test("a long step says how long it has run, in words, while the value stays put", () => {
  const writing = job({ status: "scripting", progress: { done: 300, total: 1000 }, stepAt: "2026-10-02T12:00:00.000Z" });
  expect(narrationStage(writing, since + 5_000).label).toBe("원고를 쓰고 있어요");
  expect(narrationStage(writing, since + 40_000).label).toBe("원고를 쓰고 있어요 · 40초째");
  expect(narrationStage(writing, since + 65_000).label).toBe("원고를 쓰고 있어요 · 1분 5초째");
  expect(narrationStage(writing, since + 65_000).value).toBe(narrationStage(writing, since + 5_000).value);
  const speaking = job({ status: "speaking", progress: { done: 1, total: 3 }, stepAt: "2026-10-02T12:00:00.000Z" });
  expect(narrationStage(speaking, since + 120_000).label).toBe("음성을 만들고 있어요 2/3 · 2분째");
});

test("a retry wait says so while it lasts and keeps the reported value", () => {
  const waiting = job({ status: "speaking", progress: { done: 1, total: 4 }, waitUntil: "2026-10-02T12:00:57.000Z", stepAt: "2026-10-02T12:00:00.000Z" });
  expect(narrationStage(waiting, since + 50_000)).toEqual({ label: "요청이 많아 잠시 쉬었다가 이어서 만들어요", value: 46.25 });
  expect(narrationStage(waiting, since + 58_000)).toEqual({ label: "음성을 만들고 있어요 2/4 · 58초째", value: 46.25 });
});

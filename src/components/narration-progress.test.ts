import { expect, test } from "bun:test";
import type { Narration } from "../../shared/contracts";
import { narrationStage, stageValue } from "./narration-progress";

const since = Date.parse("2026-10-02T12:00:00.000Z");
const base: Narration = {
  recordId: "00000000-0000-4000-8000-000000000201", status: "queued", style: "read", stale: false, progress: null, waitUntil: null,
  attempts: 0, error: null, requestedBy: "owner", requestedAt: "2026-10-02T12:00:00.000Z", updatedAt: "2026-10-02T12:00:00.000Z",
  audio: null, script: null,
};
const job = (changes: Partial<Narration>): Narration => ({ ...base, ...changes });

test("each real stage owns its own band of the bar, in order, and the bands never overlap", () => {
  const stages = [
    job({ status: "queued" }), job({ status: "scripting" }),
    job({ status: "speaking", progress: { done: 0, total: 2 } }), job({ status: "speaking", progress: { done: 1, total: 2 } }),
    job({ status: "speaking", progress: { done: 2, total: 2 } }),
  ].map(each => narrationStage(each, since));
  expect(stages.map(stage => [stage.label, stage.from, stage.to])).toEqual([
    ["만들 차례를 기다리는 중", 0, 4], ["원고를 다듬는 중", 4, 30], ["음성을 만드는 중 1/2", 30, 62.5], ["음성을 만드는 중 2/2", 62.5, 95],
    ["파일로 저장하는 중", 95, 99],
  ]);
  stages.slice(1).forEach((stage, index) => expect(stage.from).toBeGreaterThanOrEqual(stages[index]?.to ?? Infinity));
  // One chunk is no count to show.
  expect(narrationStage(job({ status: "speaking", progress: { done: 0, total: 1 } }), since).label).toBe("음성을 만드는 중");
  expect(narrationStage(job({ status: "ready" }), since)).toMatchObject({ label: "다 만들었어요", from: 100, to: 100 });
});

test("within a stage the value creeps from its start toward, never onto, the next stage, slowing as it goes", () => {
  const stage = narrationStage(job({ status: "scripting" }), since);
  const at = (seconds: number) => stageValue(stage, since + seconds * 1000);
  expect(at(-5)).toBe(4);
  expect(at(0)).toBe(4);
  expect(at(10)).toBeGreaterThan(4);
  expect(at(20)).toBeGreaterThan(at(10));
  // Deceleration: the second ten seconds add less than the first.
  expect(at(20) - at(10)).toBeLessThan(at(10) - at(0));
  expect(at(3600)).toBeLessThan(30);
});

test("a retry wait says so while it lasts and keeps the stage's band", () => {
  const waiting = job({ status: "speaking", progress: { done: 1, total: 4 }, waitUntil: "2026-10-02T12:00:07.000Z" });
  expect(narrationStage(waiting, since + 3000)).toMatchObject({ label: "붐벼서 잠시 기다리는 중", from: 46.25, to: 62.5 });
  expect(narrationStage(waiting, since + 8000).label).toBe("음성을 만드는 중 2/4");
});

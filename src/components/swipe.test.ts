import { expect, test } from "bun:test";
import { swipeAxis, swipeDecision, swipeVelocity } from "./swipe";

test("the axis stays undecided until the pointer has moved 10px on either axis", () => {
  expect(swipeAxis(0, 0)).toBeNull();
  expect(swipeAxis(9, 0)).toBeNull();
  expect(swipeAxis(-9.9, 9.9)).toBeNull();
  expect(swipeAxis(6, -8)).toBeNull();
});

test("a diagonal drag that is not clearly wider than tall locks vertical, so the browser scrolls", () => {
  expect(swipeAxis(0, 10)).toBe("vertical");
  expect(swipeAxis(8, 12)).toBe("vertical");
  expect(swipeAxis(12, 11)).toBe("vertical");
  expect(swipeAxis(-12, -10)).toBe("vertical");
});

test("a drag wider than 1.2 times its height locks horizontal in both directions", () => {
  expect(swipeAxis(10, 0)).toBe("horizontal");
  expect(swipeAxis(13, 10)).toBe("horizontal");
  expect(swipeAxis(-30, 20)).toBe("horizontal");
  expect(swipeAxis(-10, 8)).toBe("horizontal");
});

test("reaching the distance threshold commits: right archives, left deletes", () => {
  // Given: a 400px row, so the threshold is 120px.
  expect(swipeDecision({ dx: 120, width: 400, velocity: 0 })).toBe("archive");
  expect(swipeDecision({ dx: -120, width: 400, velocity: 0 })).toBe("delete");
  // And: a 250px row, so the threshold is 40% = 100px.
  expect(swipeDecision({ dx: 100, width: 250, velocity: 0 })).toBe("archive");
  expect(swipeDecision({ dx: -100, width: 250, velocity: 0 })).toBe("delete");
});

test("a slow drag below the threshold settles back", () => {
  expect(swipeDecision({ dx: 119, width: 400, velocity: 0 })).toBeNull();
  expect(swipeDecision({ dx: -119, width: 400, velocity: 0.1 })).toBeNull();
  expect(swipeDecision({ dx: 99, width: 250, velocity: 0 })).toBeNull();
  expect(swipeDecision({ dx: 0, width: 400, velocity: 2 })).toBeNull();
});

test("a fling commits after 48px when it is fast enough in the drag direction", () => {
  expect(swipeDecision({ dx: 48, width: 400, velocity: 0.5 })).toBe("archive");
  expect(swipeDecision({ dx: -60, width: 400, velocity: -0.9 })).toBe("delete");
  // And: too short or too slow is still a settle.
  expect(swipeDecision({ dx: 47, width: 400, velocity: 1.5 })).toBeNull();
  expect(swipeDecision({ dx: 60, width: 400, velocity: 0.49 })).toBeNull();
});

test("a fling against the drag direction never commits", () => {
  expect(swipeDecision({ dx: 60, width: 400, velocity: -0.9 })).toBeNull();
  expect(swipeDecision({ dx: -60, width: 400, velocity: 0.9 })).toBeNull();
  // And: the distance threshold still commits on its own.
  expect(swipeDecision({ dx: 130, width: 400, velocity: -0.9 })).toBe("archive");
});

test("velocity comes from the samples inside the last 80ms and is 0 without two of them", () => {
  // Given: a slow start, then a fast finish in the last 60ms.
  const samples = [{ t: 0, x: 0 }, { t: 100, x: 20 }, { t: 140, x: 30 }, { t: 180, x: 70 }, { t: 200, x: 90 }];
  expect(swipeVelocity(samples, 200)).toBe(1);
  // And: a pause after the last move drops every sample out of the window.
  expect(swipeVelocity(samples, 300)).toBe(0);
  expect(swipeVelocity([{ t: 0, x: 0 }], 10)).toBe(0);
  expect(swipeVelocity([], 10)).toBe(0);
});

export type SwipeAxis = "horizontal" | "vertical";
/** The revealed command: dragging right archives (or restores), dragging left moves to the trash. */
export type SwipeAction = "archive" | "delete";
/** One pointer position with its event timestamp in ms. */
export type SwipeSample = { readonly t: number; readonly x: number };

/** Movement below this on both axes is still a tap. */
export const SWIPE_SLOP = 10;
/** A drag commits at this distance, or at 40% of the row width when the row is narrower than 300px. */
export const SWIPE_COMMIT_DISTANCE = 120;
export const SWIPE_COMMIT_FRACTION = 0.4;
/** A fling commits early: at least this speed (px/ms) in the drag direction after at least SWIPE_FLING_DISTANCE. */
export const SWIPE_FLING_VELOCITY = 0.5;
export const SWIPE_FLING_DISTANCE = 48;
/** Velocity is read from the samples inside this window (ms) before release. */
export const SWIPE_VELOCITY_WINDOW = 80;

/** Axis lock: null until the pointer has moved SWIPE_SLOP on either axis, then horizontal only when clearly wider than tall. */
export function swipeAxis(dx: number, dy: number): SwipeAxis | null {
  const horizontal = Math.abs(dx);
  const vertical = Math.abs(dy);
  if (horizontal < SWIPE_SLOP && vertical < SWIPE_SLOP) return null;
  return horizontal > vertical * 1.2 ? "horizontal" : "vertical";
}

/** The action a released drag commits to, or null when the row should settle back. */
export function swipeDecision({ dx, width, velocity }: { readonly dx: number; readonly width: number; readonly velocity: number }): SwipeAction | null {
  if (dx === 0) return null;
  const distance = Math.abs(dx);
  const byDistance = distance >= Math.min(SWIPE_COMMIT_DISTANCE, width * SWIPE_COMMIT_FRACTION);
  const byFling = Math.abs(velocity) >= SWIPE_FLING_VELOCITY && distance >= SWIPE_FLING_DISTANCE && Math.sign(velocity) === Math.sign(dx);
  if (!byDistance && !byFling) return null;
  return dx > 0 ? "archive" : "delete";
}

/** Horizontal velocity in px/ms over the samples inside the last SWIPE_VELOCITY_WINDOW before `now`; 0 without two samples there. */
export function swipeVelocity(samples: readonly SwipeSample[], now: number): number {
  const recent = samples.filter(sample => now - sample.t <= SWIPE_VELOCITY_WINDOW);
  const first = recent[0];
  const last = recent[recent.length - 1];
  if (!first || !last || last.t <= first.t) return 0;
  return (last.x - first.x) / (last.t - first.t);
}

import { useEffect, useRef } from "react";
import { flushSync } from "react-dom";
import { SWIPE_COMMIT_DISTANCE, SWIPE_COMMIT_FRACTION, SWIPE_FLING_DISTANCE, SWIPE_FLING_VELOCITY, SWIPE_VELOCITY_WINDOW, swipeAxis, swipeVelocity } from "./swipe";
import type { SwipeAxis, SwipeSample } from "./swipe";

/**
 * phone: one column and the tab bar. split: list and reader, the sidebar slides over them. wide: the sidebar docks beside them unless hidden.
 * Every iPad window (at most 1376pt wide) is split or phone; a full-screen desktop browser (1440px and up) is wide.
 */
export type ShellLayout = "phone" | "split" | "wide";
export const SPLIT_MIN = 768;
export const WIDE_MIN = 1400;
/** A touch that starts this close to the left edge drags a hidden sidebar out; record rows leave that strip to it. */
export const SIDEBAR_EDGE = 20;
export const SIDEBAR_KEY = "agentic:sidebar";

export const layoutOf = (width: number): ShellLayout => width < SPLIT_MIN ? "phone" : width < WIDE_MIN ? "split" : "wide";

export function readDocked(storage: Pick<Storage, "getItem">): boolean {
  try { return storage.getItem(SIDEBAR_KEY) !== "hidden"; } catch { return true; }
}
export function writeDocked(storage: Pick<Storage, "setItem">, docked: boolean) {
  try { storage.setItem(SIDEBAR_KEY, docked ? "shown" : "hidden"); } catch { /* Private mode without storage: the choice lasts for this page. */ }
}

export function drawerCommits({ distance, width, velocity }: { readonly distance: number; readonly width: number; readonly velocity: number }): boolean {
  if (distance <= 0) return false;
  return distance >= Math.min(SWIPE_COMMIT_DISTANCE, width * SWIPE_COMMIT_FRACTION)
    || (velocity >= SWIPE_FLING_VELOCITY && distance >= SWIPE_FLING_DISTANCE);
}

type Drag = { readonly opening: boolean; readonly x: number; readonly y: number; readonly width: number; axis: SwipeAxis | null; dx: number; samples: SwipeSample[] };

/**
 * Touch drags for the sliding sidebar: from the left edge while it is hidden, and leftwards on it or its scrim while it is open.
 * The panel follows the finger; on release it settles open or shut through the same CSS transition the buttons use.
 * Touch events rather than pointer events, so the drag can keep the page from scrolling once it is clearly horizontal.
 */
export function useSidebarDrag({ enabled, open, onOpen, onClose }: { readonly enabled: boolean; readonly open: boolean; readonly onOpen: () => void; readonly onClose: () => void }) {
  const latest = useRef({ open, onOpen, onClose });
  latest.current = { open, onOpen, onClose };
  useEffect(() => {
    if (!enabled) return;
    let drag: Drag | null = null;
    const panel = () => document.getElementById("sidebar");
    const scrim = () => document.querySelector<HTMLElement>(".sidebar-scrim");
    const paint = (offset: number, width: number) => {
      const [side, shade] = [panel(), scrim()];
      if (side) { side.style.transition = "none"; side.style.transform = `translateX(${offset}px)`; }
      if (shade) { shade.style.transition = "none"; shade.style.opacity = String(1 + offset / width); }
    };
    const clear = () => {
      for (const element of [panel(), scrim()]) if (element) { element.style.transition = ""; element.style.transform = ""; element.style.opacity = ""; }
    };
    const start = (event: TouchEvent) => {
      drag = null;
      const touch = event.touches[0];
      const side = panel();
      if (event.touches.length !== 1 || !touch || !side || document.querySelector("dialog[open]")) return;
      const target = event.target instanceof Node ? event.target : null;
      const opening = !latest.current.open;
      if (opening ? touch.clientX > SIDEBAR_EDGE : !target || !(side.contains(target) || target === scrim())) return;
      drag = { opening, x: touch.clientX, y: touch.clientY, width: side.offsetWidth, axis: null, dx: 0, samples: [{ t: event.timeStamp, x: touch.clientX }] };
    };
    const move = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!drag || !touch) return;
      const dx = touch.clientX - drag.x;
      if (drag.axis === null) {
        drag.axis = swipeAxis(dx, touch.clientY - drag.y);
        if (drag.axis === null) return;
        if (drag.axis === "vertical") { drag = null; return; }
      }
      event.preventDefault();
      drag.dx = dx;
      drag.samples = [...drag.samples.filter(sample => event.timeStamp - sample.t <= SWIPE_VELOCITY_WINDOW), { t: event.timeStamp, x: touch.clientX }];
      const offset = Math.max(-drag.width, Math.min(0, drag.opening ? dx - drag.width : dx));
      paint(offset, drag.width);
    };
    const end = (event: TouchEvent, cancelled: boolean) => {
      const done = drag;
      drag = null;
      if (!done || done.axis !== "horizontal") return;
      const direction = done.opening ? 1 : -1;
      const commits = !cancelled && drawerCommits({ distance: done.dx * direction, width: done.width, velocity: swipeVelocity(done.samples, event.timeStamp) * direction });
      // Commit the new state before the inline position goes, so the transition runs from the finger to where the panel now belongs.
      if (commits) flushSync(done.opening ? latest.current.onOpen : latest.current.onClose);
      clear();
    };
    const release = (event: TouchEvent) => end(event, false);
    const cancel = (event: TouchEvent) => end(event, true);
    window.addEventListener("touchstart", start, { passive: true });
    window.addEventListener("touchmove", move, { passive: false });
    window.addEventListener("touchend", release);
    window.addEventListener("touchcancel", cancel);
    return () => {
      window.removeEventListener("touchstart", start);
      window.removeEventListener("touchmove", move);
      window.removeEventListener("touchend", release);
      window.removeEventListener("touchcancel", cancel);
      clear();
    };
  }, [enabled]);
}

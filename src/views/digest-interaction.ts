import { useEffect, useRef, useState } from "react";
import { DigestSectionKeySchema } from "../../shared/contracts";
/** Collapsed section keys, shared by every digest and kept on this device. */
export const COLLAPSED_KEY = "agentic:digest-collapsed";

/** A stored JSON array of section keys; anything malformed means nothing is collapsed. */
export function parseCollapsed(raw: string | null): ReadonlySet<string> {
  try {
    const value: unknown = JSON.parse(raw ?? "[]");
    return new Set(Array.isArray(value) ? value.flatMap(key => { const parsed = DigestSectionKeySchema.safeParse(key); return parsed.success ? [parsed.data] : []; }) : []);
  } catch { return new Set(); }
}

// Storage can be unavailable (private mode, blocked); collapsing then lasts only for this screen.
const storage = () => { try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; } };

export function useCollapsed() {
  const [collapsed, setCollapsed] = useState(() => parseCollapsed(storage()?.getItem(COLLAPSED_KEY) ?? null));
  const setExpanded = (key: string, expanded: boolean) => setCollapsed(current => {
    if (current.has(key) !== expanded) return current;
    const next = new Set(current);
    if (expanded) next.delete(key); else next.add(key);
    try { storage()?.setItem(COLLAPSED_KEY, JSON.stringify([...next])); } catch { /* quota or blocked storage: keep the in-memory state */ }
    return next;
  });
  return [collapsed, setExpanded] as const;
}


/** Summary (every summary shown, the default) or titles (titles, sources and message actions only), kept on this device. */
export type DigestDensity = "summary" | "titles";

export const DENSITY_KEY = "agentic:digest-density";

export function useDensity() {
  const [density, setDensity] = useState<DigestDensity>(() => storage()?.getItem(DENSITY_KEY) === "titles" ? "titles" : "summary");
  const choose = (next: DigestDensity) => {
    setDensity(next);
    try { if (next === "titles") storage()?.setItem(DENSITY_KEY, next); else storage()?.removeItem(DENSITY_KEY); } catch { /* blocked storage: keep it for this screen */ }
  };
  return [density, choose] as const;
}


/** An agent marks a revised item with a leading "Update:" (in English or Korean); the view shows one tag instead. */
const UPDATE_PREFIX = /^\s*(?:update[sd]?|업데이트) *[:：]/i;
 // i18n-allow: agents write this prefix into content in either language
export function splitUpdate(text: string): { readonly updated: boolean; readonly text: string } {
  const match = UPDATE_PREFIX.exec(text);
  if (!match) return { updated: false, text };
  const rest = text.slice(match[0].length).trimStart();
  return rest ? { updated: true, text: rest } : { updated: false, text };
}

/** A summary's first sentence and the rest. A sentence ends at . ! ? 。 … (with closing quotes or brackets) before a space, so "2.5" never splits. */
export function splitLede(summary: string): readonly [lede: string, rest: string] {
  const end = /[.!?。…]["'”’)\]]*(?=\s)/.exec(summary);
  if (!end) return [summary.trim(), ""];
  const cut = end.index + end[0].length;
  return [summary.slice(0, cut).trim(), summary.slice(cut).trim()];
}


/** The scroll owner of the open digest: the reader pane on split layouts, the document on phones. */
function scrollerOf(element: Element): Element {
  const pane = element.closest(".reader-fullscreen, .pane");
  return pane && getComputedStyle(pane).overflowY !== "visible" && pane.scrollHeight > pane.clientHeight ? pane : document.scrollingElement ?? document.documentElement;
}

/** Where the section bar's bottom edge sits once it is stuck: the line a section has to reach to be the current one. */
function stuckLine(bar: HTMLElement, scroller: Element) {
  const top = scroller === document.scrollingElement ? 0 : scroller.getBoundingClientRect().top;
  return top + (Number.parseFloat(getComputedStyle(bar).top) || 0) + bar.offsetHeight;
}

/** Scrolls a section's head to just under the stuck section bar. */
export function jumpTo(key: string) {
  const section = document.getElementById(`section-${key}`);
  const bar = document.querySelector<HTMLElement>(".digest-bar");
  if (!section || !bar) return;
  const scroller = scrollerOf(section);
  const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
  const top = section.getBoundingClientRect().top - stuckLine(bar, scroller) - 12;
  if (scroller === document.scrollingElement) window.scrollBy({ top, behavior }); else scroller.scrollBy({ top, behavior });
}

/** The section being read: the last one whose head has reached the stuck bar, the last one once the end is reached. */
/** The section tab strip: keeps the current section's tab in view and marks which edges hide more tabs (`data-more`, they fade). */
export function useTabStrip(current: string | undefined, keys: string) {
  const strip = useRef<HTMLElement>(null);
  useEffect(() => {
    const element = strip.current;
    if (!element) return;
    const mark = () => {
      const max = element.scrollWidth - element.clientWidth;
      element.dataset["more"] = max <= 1 ? "" : element.scrollLeft <= 1 ? "end" : element.scrollLeft >= max - 1 ? "start" : "both";
    };
    mark();
    element.addEventListener("scroll", mark, { passive: true });
    const observer = new ResizeObserver(mark);
    observer.observe(element);
    return () => { element.removeEventListener("scroll", mark); observer.disconnect(); };
  }, [keys]);
  useEffect(() => {
    const element = strip.current;
    const tab = element?.querySelector<HTMLElement>('[aria-current="location"]');
    if (!element || !tab) return;
    const box = element.getBoundingClientRect(), place = tab.getBoundingClientRect();
    // Room for the fade, so the tab is fully readable once scrolled to.
    const edge = 28;
    const left = place.left < box.left + edge ? place.left - box.left - edge : place.right > box.right - edge ? place.right - box.right + edge : 0;
    if (left) element.scrollBy({ left, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [current, keys]);
  return strip;
}


export function useCurrentSection(keys: readonly string[], layout: unknown) {
  const [current, setCurrent] = useState<string | undefined>(keys[0]);
  const joined = keys.join(",");
  useEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
      const bar = document.querySelector<HTMLElement>(".digest-bar");
      const first = keys[0] && document.getElementById(`section-${keys[0]}`);
      if (!bar || !first) return;
      const scroller = scrollerOf(first);
      const line = stuckLine(bar, scroller) + 16;
      const atEnd = scroller.scrollTop > 0 && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
      let next = keys[0];
      for (const key of keys) {
        const section = document.getElementById(`section-${key}`);
        if (section && section.getBoundingClientRect().top <= line) next = key;
      }
      setCurrent(atEnd ? keys.at(-1) : next);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    measure();
    document.addEventListener("scroll", schedule, { capture: true, passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      document.removeEventListener("scroll", schedule, { capture: true });
      window.removeEventListener("resize", schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [joined, layout]);
  return current;
}

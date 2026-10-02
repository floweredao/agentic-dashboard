import { useEffect, useRef } from "react";
import type { DashboardRecord } from "../shared/contracts";
import { useDashboard } from "./state";

const typing = (target: EventTarget | null) => target instanceof HTMLElement
  && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

/** j/k move the selection through `items`, e confirms, s stars. Ignored while typing or with modifiers. */
export function useListShortcuts(items: readonly DashboardRecord[]) {
  const dashboard = useDashboard();
  const latest = useRef({ items, dashboard });
  latest.current = { items, dashboard };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || typing(event.target) || document.querySelector("dialog[open]")) return;
      const { items: list, dashboard: current } = latest.current;
      const index = list.findIndex(item => item.id === current.route.id);
      const selected = index >= 0 ? list[index] : undefined;
      if (event.key === "j" || event.key === "k") {
        const next = list[event.key === "j" ? Math.min(list.length - 1, index + 1) : Math.max(0, index - 1)];
        if (next) { event.preventDefault(); current.select(next); document.getElementById(`row-${next.id}`)?.focus({ preventScroll: false }); }
      } else if (event.key === "e" && selected) { event.preventDefault(); void current.confirm(selected); }
      else if (event.key === "s" && selected) { event.preventDefault(); void current.toggleStar(selected); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export { typing as isTypingTarget };

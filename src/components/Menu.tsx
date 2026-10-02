import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";

export type MenuItem = { readonly label: string; readonly icon?: ReactNode; readonly onSelect: () => void; readonly disabled?: boolean;
  /** Destructive command, shown in the danger colour. */
  readonly danger?: boolean;
};

const enabledItems = (menu: HTMLElement | null) =>
  Array.from(menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);

/** Inner right edge of the nearest ancestor that clips or scrolls sideways, else of the viewport. */
function clipRight(element: HTMLElement) {
  for (let box = element.parentElement; box; box = box.parentElement) {
    if (getComputedStyle(box).overflowX !== "visible") return box.getBoundingClientRect().left + box.clientLeft + box.clientWidth;
  }
  return document.documentElement.clientWidth;
}

/** APG menu button: arrows move, Escape closes and returns focus, Tab or an outside click closes. */
export function Menu({ label, items, disabled = false }: {
  readonly label: string; readonly items: readonly MenuItem[]; readonly disabled?: boolean;
}) {
  const [open, setOpen] = useState<false | "first" | "last">(false);
  const [alignEnd, setAlignEnd] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();

  // A menu that would run past that edge opens leftwards from the button's end instead (before it is painted).
  useLayoutEffect(() => {
    if (!open || !wrap.current || !menu.current) return;
    setAlignEnd(wrap.current.getBoundingClientRect().left + menu.current.offsetWidth > clipRight(wrap.current));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const list = enabledItems(menu.current);
    (open === "last" ? list.at(-1) : list[0])?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !wrap.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  const close = () => { setOpen(false); button.current?.focus(); };

  function onMenuKey(event: KeyboardEvent<HTMLDivElement>) {
    const list = enabledItems(menu.current);
    const index = list.findIndex(item => item === document.activeElement);
    const move = (next: number) => { event.preventDefault(); list[(next + list.length) % list.length]?.focus(); };
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
    else if (event.key === "ArrowDown") move(index + 1);
    else if (event.key === "ArrowUp") move(index - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(list.length - 1);
    else if (event.key === "Tab") setOpen(false);
  }

  function onButtonKey(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(event.key === "ArrowUp" ? "last" : "first");
    }
  }

  return <div className="menu-wrap" ref={wrap}>
    <button ref={button} type="button" className="btn btn-outline" aria-label={label} aria-haspopup="menu" aria-expanded={open !== false}
      aria-controls={open ? id : undefined} disabled={disabled} onKeyDown={onButtonKey}
      onClick={() => setOpen(current => current ? false : "first")}>
      <MoreHorizontal size={16} aria-hidden="true" /><span className="menu-label">{label}</span>
    </button>
    {open && <div ref={menu} id={id} role="menu" aria-label={label} className={alignEnd ? "menu menu-end" : "menu"} onKeyDown={onMenuKey}>
      {items.map(item => <button key={item.label} type="button" role="menuitem" tabIndex={-1} className={item.danger ? "menu-item danger" : "menu-item"}
        disabled={item.disabled} onClick={() => { close(); item.onSelect(); }}>{item.icon}{item.label}</button>)}
    </div>}
  </div>;
}

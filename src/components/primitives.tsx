import { createContext, useContext, useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { ArrowLeft, Inbox, PanelLeftOpen, X } from "lucide-react";
import type { DashboardRecord } from "../../shared/contracts";
import { strings } from "../i18n";
import { channelClass, channelOf, channelGlyph, dateLabel, relativeTime } from "../model";
import type { Channel } from "../model";
import { backLabel } from "../router";
import type { Back } from "../router";
import { useDashboard } from "../state";
import { SidebarContext } from "./sidebar";

const text = strings({
  en: { close: "Close", showSidebar: "Show sidebar", showSidebarShortcut: "Show sidebar (⌘\\)" },
  ko: { close: "닫기", showSidebar: "사이드바 보기", showSidebarShortcut: "사이드바 보기 (⌘\\)" },
});

/**
 * Unfolds the sidebar from the head of the screen's first pane: place it first inside that pane's `.pane-title-row`.
 * Shown (from 768px) only while the sidebar is not docked; the sidebar's own Hide sidebar is its counterpart.
 * A phone uses the app bar's menu button instead.
 */
export function SidebarOpen() {
  const sidebar = useContext(SidebarContext);
  if (!sidebar) return null;
  const t = text();
  return <button type="button" className="icon-btn sidebar-open" onClick={sidebar.show} aria-label={t.showSidebar} title={t.showSidebarShortcut}
    aria-controls="sidebar" aria-expanded={sidebar.state !== "hidden"}><PanelLeftOpen size={18} aria-hidden="true" /></button>;
}

/**
 * The desktop copy of the screen's back button, at the top of the pane it belongs to (`place`).
 * A phone shows the same back in the app bar, so this one is hidden below 768px.
 */
export function BackButton({ place }: { readonly place: Back["place"] }) {
  const { back, goBack } = useDashboard();
  if (!back || back.place !== place) return null;
  return <button type="button" className="btn btn-quiet pane-back" onClick={goBack}>
    <ArrowLeft size={16} aria-hidden="true" />{backLabel(back.hash)}
  </button>;
}

export function ChannelMark({ channel, size = "dot" }: { readonly channel: Channel; readonly size?: "dot" | "tile" }) {
  return size === "dot"
    ? <span className={`channel-dot ${channelClass(channel)}`} aria-hidden="true" />
    : <span className={`channel-tile ${channelClass(channel)}`} aria-hidden="true">{channelGlyph(channel)}</span>;
}

export function RecordChannel({ record, size = "dot" }: { readonly record: DashboardRecord; readonly size?: "dot" | "tile" }) {
  return <ChannelMark channel={channelOf(record)} size={size} />;
}

export function Chip({ selected = false, count, onClick, children }: {
  readonly selected?: boolean; readonly count?: number; readonly onClick: () => void; readonly children: ReactNode;
}) {
  return <button type="button" className="chip" aria-pressed={selected} onClick={onClick}>
    {children}{count !== undefined && <span className="chip-count">{count}</span>}
  </button>;
}

export function Tag({ children, tone = "" }: { readonly children: ReactNode; readonly tone?: string }) {
  return <span className={`tag ${tone}`}>{children}</span>;
}

export function Empty({ children, icon, action }: { readonly children: ReactNode; readonly icon?: ReactNode; readonly action?: ReactNode }) {
  return <div className="empty">{icon ?? <Inbox size={20} aria-hidden="true" />}<p>{children}</p>{action}</div>;
}

export function Time({ value }: { readonly value: string }) {
  return <time dateTime={value} title={dateLabel(value)}>{relativeTime(value)}</time>;
}

export const isSample = (record: DashboardRecord) => record.fields.demo === true || record.fields.sample === true;

let scrollLocks = 0;
let releaseScroll = () => {};

/**
 * Pins the page while a modal is open. iOS Safari keeps scrolling the document behind a modal <dialog>
 * and ignores overflow on body, so the body is fixed at its current offset instead. Nested locks share
 * the first lock's offset; the last unlock restores the inline styles and scrolls back to that offset.
 */
export function lockDocumentScroll(): () => void {
  if (scrollLocks++ === 0) {
    const y = window.scrollY;
    const style = document.body.style;
    const previous = { position: style.position, top: style.top, left: style.left, right: style.right, overflow: style.overflow };
    Object.assign(style, { position: "fixed", top: `${-y}px`, left: "0", right: "0", overflow: "hidden" });
    releaseScroll = () => { Object.assign(style, previous); window.scrollTo(0, y); };
  }
  return () => { if (--scrollLocks === 0) releaseScroll(); };
}

/** A modal dialog makes the rest of the page inert and covers it, so the app renders its toast inside the open dialog. */
export const DialogToast = createContext<ReactNode>(null);

export function Dialog({ title, onClose, children, size = "normal" }: {
  readonly title: string; readonly onClose: () => void; readonly children: ReactNode; readonly size?: "normal" | "wide";
}) {
  const toast = useContext(DialogToast);
  const dialog = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const element = dialog.current;
    const opener = document.activeElement;
    if (!element) return;
    const unlockScroll = lockDocumentScroll();
    element.showModal();
    element.querySelector<HTMLElement>("[autofocus], input, textarea, select")?.focus();
    return () => {
      element.close();
      unlockScroll();
      // The opener can vanish (the gate after login); focusing main without scrolling keeps the list at its top.
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
      else document.getElementById("main")?.focus({ preventScroll: true });
    };
  }, []);
  return <dialog ref={dialog} className={`dialog ${size}`} aria-labelledby="dialog-title"
    onCancel={event => { event.preventDefault(); closeRef.current(); }}
    // Escape is handled here too: a keydown left unhandled reaches the macOS window, which beeps, even though the dialog closes.
    onKeyDown={event => { if (event.key === "Escape" && !event.defaultPrevented && !event.nativeEvent.isComposing) { event.preventDefault(); closeRef.current(); } }}>
    <header className="dialog-head">
      <h2 id="dialog-title">{title}</h2>
      <button type="button" className="icon-btn" aria-label={text().close} onClick={onClose}><X size={18} aria-hidden="true" /></button>
    </header>
    <div className="dialog-body">{children}</div>
    {toast}
  </dialog>;
}

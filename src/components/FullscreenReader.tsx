import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { X } from "lucide-react";
import { lockDocumentScroll } from "./primitives";

/**
 * Full screen reading: the record's reading content in a modal dialog over the whole window, hiding the sidebar and the list; the close button or Escape returns to the reader.
 */
export function FullscreenReader({ title, closeLabel, onClose, wide, children }: {
  readonly title: string; readonly closeLabel: string; readonly onClose: () => void; readonly wide: boolean; readonly children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const element = dialog.current;
    const opener = document.activeElement;
    if (!element) return;
    const unlockScroll = lockDocumentScroll();
    element.showModal();
    element.querySelector<HTMLElement>(".reader-fullscreen-close")?.focus({ preventScroll: true });
    return () => {
      element.close();
      unlockScroll();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  return <dialog ref={dialog} className="reader-fullscreen" aria-labelledby="reader-fullscreen-title"
    onCancel={event => { event.preventDefault(); closeRef.current(); }}
    onKeyDown={event => { if (event.key === "Escape" && !event.defaultPrevented && !event.nativeEvent.isComposing) { event.preventDefault(); closeRef.current(); } }}>
    <header className="reader-fullscreen-head">
      <h2 id="reader-fullscreen-title">{title}</h2>
      <button type="button" className="btn btn-outline reader-corner-button reader-fullscreen-close" onClick={onClose}
        aria-label={closeLabel} title={`${closeLabel} (Esc)`}>
        <X size={16} aria-hidden="true" />
      </button>
    </header>
    <div className={wide ? "reader-fullscreen-body has-document" : "reader-fullscreen-body"}>{children}</div>
  </dialog>;
}

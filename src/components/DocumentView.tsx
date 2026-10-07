import { useEffect, useRef, useState } from "react";
import type { RecordDocument } from "../../shared/contracts";
import { loadDocument } from "../api";

/** The record's full document, loaded when the record opens; null while loading, when there is none or when loading failed. */
export function useRecordDocument(recordId: string | null): RecordDocument | null {
  const [loaded, setLoaded] = useState<{ readonly id: string; readonly document: RecordDocument | null } | null>(null);
  useEffect(() => {
    if (!recordId) return;
    let live = true;
    loadDocument(recordId).then(document => { if (live) setLoaded({ id: recordId, document }); },
      () => { if (live) setLoaded({ id: recordId, document: null }); });
    return () => { live = false; };
  }, [recordId]);
  return loaded && loaded.id === recordId ? loaded.document : null;
}

/**
 * Links leave the frame in a new tab; the frame never scrolls on its own, the page around it does. A document that names no
 * font reads in the app's font (tokens.css --font) instead of the frame's default serif; :where keeps it below any rule the
 * document sets itself. The same zero-specificity defaults give a document that sets no spacing reading leading (1.7, klreq
 * 160-180%) and room between list items, so multi-sentence items do not run together; any rule the document sets wins.
 */
const appFont = `-apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", system-ui, sans-serif`;
export const framedHtml = (html: string) =>
  `<base target="_blank"><style>html{overflow-y:hidden!important}:where(html){font-family:${appFont}}:where(html){line-height:1.7}`
  + `:where(h1,h2,h3,h4,h5,h6){line-height:1.35}:where(li+li){margin-top:.75em}:where(li>ul,li>ol){margin-top:.5em}</style>${html}`;

/**
 * The frame's height for a document measured inside it: the whole document, fractions rounded up, plus the frame's own border
 * (border-box puts it inside the height). A frame even 1px shorter than its document can scroll, and iOS then hands a swipe
 * that starts on it to the frame, so the page around it does not move.
 */
export const frameHeight = (documentHeight: number, border: number) => Math.ceil(documentHeight) + border;

/**
 * Points the document's own #section links at the frame itself: resolved against the dashboard's address with the frame's
 * <base target="_blank">, they would leave the frame and, on iOS, replace the dashboard's route. iOS also never runs a listener
 * the dashboard puts on the script-free document, so the link itself has to move within the frame.
 */
export function keepLinksInFrame(document: ParentNode) {
  for (const link of document.querySelectorAll("a[href^='#']")) {
    link.setAttribute("href", `about:srcdoc${link.getAttribute("href")}`);
    link.setAttribute("target", "_self");
  }
}

/**
 * The document in a sandboxed frame: no script in it ever runs (no allow-scripts), so the dashboard reads its height and
 * points its in-page links (#section) at the frame from outside, growing the frame to the whole document.
 */
export function DocumentFrame({ html, title }: { readonly html: string; readonly title: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(480);
  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    let observer: ResizeObserver | null = null;
    const measure = () => {
      const root = element.contentDocument?.documentElement;
      if (!root) return;
      const content = Math.max(root.getBoundingClientRect().height, root.scrollHeight, element.contentDocument?.body?.scrollHeight ?? 0);
      setHeight(frameHeight(content, element.offsetHeight - element.clientHeight));
    };
    const loaded = () => {
      const document = element.contentDocument;
      if (!document) return;
      measure();
      keepLinksInFrame(document);
      observer?.disconnect();
      observer = new ResizeObserver(measure);
      observer.observe(document.documentElement);
    };
    element.addEventListener("load", loaded);
    return () => { element.removeEventListener("load", loaded); observer?.disconnect(); };
  }, [html]);
  return <iframe ref={frame} className="reader-document" title={title} srcDoc={framedHtml(html)} style={{ height }} scrolling="no"
    sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" />;
}

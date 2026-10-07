import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DocumentFrame, frameHeight, framedHtml, keepLinksInFrame } from "./DocumentView";

test("the full document frame never lets the document run scripts or leave through the dashboard tab", () => {
  const html = renderToStaticMarkup(<DocumentFrame html="<p>본문</p><script>alert(1)</script>" title="전체 문서: 조사" />);
  const sandbox = /sandbox="([^"]*)"/.exec(html)?.[1] ?? "";
  expect(sandbox.split(" ").sort()).toEqual(["allow-popups", "allow-popups-to-escape-sandbox", "allow-same-origin"]);
  expect(html).toContain('title="전체 문서: 조사"');
  expect(framedHtml("<p>x</p>").startsWith('<base target="_blank">')).toBe(true);
});

test("the frame is never shorter than its document, so iOS never hands a swipe to the frame instead of the page", () => {
  // iPad Safari measured the html at 33634.11px inside a frame with a 1px top border (border-box).
  const height = frameHeight(33634.11, 1);
  expect(Number.isInteger(height)).toBe(true);
  expect(height - 1).toBeGreaterThanOrEqual(33634.11);
  expect(frameHeight(33634, 1) - 1).toBeGreaterThanOrEqual(33634);
  const html = renderToStaticMarkup(<DocumentFrame html="<p>본문</p>" title="전체 문서: 조사" />);
  expect(html).toContain('scrolling="no"');
});

test("a document's own #section links move within the frame instead of leaving it, while other links still open a new tab", () => {
  // iOS runs no listener the dashboard puts on the script-free frame, so the links themselves must stay inside the document.
  const anchor = (href: string) => {
    const attributes = new Map([["href", href]]);
    return { attributes, getAttribute: (name: string) => attributes.get(name) ?? null, setAttribute: (name: string, value: string) => { attributes.set(name, value); } };
  };
  const toc = anchor("#s7");
  const outside = anchor("https://example.com/#s7");
  const document = { querySelectorAll: (selector: string) => selector === "a[href^='#']" ? [toc] : [toc, outside] };
  keepLinksInFrame(document as unknown as ParentNode);
  expect(Object.fromEntries(toc.attributes)).toEqual({ href: "about:srcdoc#s7", target: "_self" });
  expect(Object.fromEntries(outside.attributes)).toEqual({ href: "https://example.com/#s7" });
});

test("a document that names no font reads in the app's font, and one that names its own keeps it", () => {
  const appFont = /--font:\s*([^;]+);/.exec(readFileSync(new URL("../styles/tokens.css", import.meta.url), "utf8"))?.[1];
  const framed = framedHtml("<p>본문</p>");
  // Zero specificity (:where) so any font-family the document sets on html or body wins.
  expect(framed).toContain(`:where(html){font-family:${appFont}}`);
  expect(framed.indexOf(":where(html)")).toBeLessThan(framed.indexOf("<p>본문</p>"));
});

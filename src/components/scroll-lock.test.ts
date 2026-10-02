import { afterEach, beforeEach, expect, test } from "bun:test";
import { lockDocumentScroll } from "./primitives";

let style: Record<"position" | "top" | "left" | "right" | "overflow", string>;
let scrollY: number;
let scrolledTo: [number, number][];

beforeEach(() => {
  style = { position: "relative", top: "12px", left: "", right: "", overflow: "" };
  scrollY = 480;
  scrolledTo = [];
  Object.defineProperty(globalThis, "document", { configurable: true, value: { body: { style } } });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { get scrollY() { return scrollY; }, scrollTo: (x: number, y: number) => { scrolledTo.push([x, y]); } },
  });
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, "document");
  Reflect.deleteProperty(globalThis, "window");
});

test("locking pins the body at the scroll offset and unlocking restores it", () => {
  // Given: the list is scrolled 480px and the body carries its own inline styles.
  // When: an open dialog locks the document.
  const unlock = lockDocumentScroll();
  // Then: the body is fixed 480px up, so touch scrolling cannot move the page behind the sheet.
  expect({ position: style.position, top: style.top, overflow: style.overflow })
    .toEqual({ position: "fixed", top: "-480px", overflow: "hidden" });
  // When: the dialog closes.
  unlock();
  // Then: the previous inline styles return and the page scrolls back to the same place.
  expect(style).toEqual({ position: "relative", top: "12px", left: "", right: "", overflow: "" });
  expect(scrolledTo).toEqual([[0, 480]]);
});

test("nested locks keep the page pinned until the last unlock", () => {
  // Given: one dialog holds the lock and the pinned page now reports no scroll offset.
  const first = lockDocumentScroll();
  scrollY = 0;
  // When: a second dialog locks and the first one releases.
  const second = lockDocumentScroll();
  first();
  // Then: the page stays pinned at the original offset and has not scrolled.
  expect({ position: style.position, top: style.top }).toEqual({ position: "fixed", top: "-480px" });
  expect(scrolledTo).toEqual([]);
  // When: the last dialog releases.
  second();
  // Then: the styles and the offset saved by the first lock are restored.
  expect(style.position).toBe("relative");
  expect(scrolledTo).toEqual([[0, 480]]);
});

import { expect, test } from "bun:test";
import { backLabel, backOf, formatRoute, legacyRedirect, parseRoute, sectionOf } from "./router";
import type { Back } from "./router";

const a = "0db63b14-e45e-4b84-9e6c-dee3fc02592a";
const b = "1db63b14-e45e-4b84-9e6c-dee3fc02592b";

test("routes round-trip view, record id and committed filters", () => {
  const hash = "#/library/0db63b14-e45e-4b84-9e6c-dee3fc02592a?channel=omo&q=%EA%B2%80%EC%83%89";
  const route = parseRoute(hash);
  expect(route).toEqual({ view: "library", id: "0db63b14-e45e-4b84-9e6c-dee3fc02592a", params: { channel: "omo", q: "검색" } });
  expect(formatRoute(route)).toBe(hash);
});

test("unknown views and malformed ids fall back safely", () => {
  expect(parseRoute("#/nowhere/abc")).toEqual({ view: "home", id: null, params: {} });
  expect(parseRoute("")).toEqual({ view: "home", id: null, params: {} });
});

test("old dashboard bookmarks redirect to the new views", () => {
  expect(legacyRedirect("#research/pending")).toBe("#/library");
  expect(legacyRedirect("#home")).toBe("#/home");
  expect(legacyRedirect("#/today")).toBe("#/home");
  expect(legacyRedirect("#archive")).toBe("#/library?state=archived");
  expect(legacyRedirect("#/library")).toBeNull();
  expect(legacyRedirect("#/home")).toBeNull();
});

test("받은 항목 and 보관함 addresses open their records in 기록, and the gone kind and channel filters drop out", () => {
  expect(legacyRedirect("#/inbox")).toBe("#/home");
  expect(legacyRedirect("#/inbox?state=all")).toBe("#/home");
  expect(legacyRedirect("#/inbox?state=pending")).toBe("#/library?state=pending");
  expect(legacyRedirect("#/inbox?state=starred&q=%EA%B0%80")).toBe("#/library?q=%EA%B0%80&state=starred");
  expect(legacyRedirect("#/inbox?state=approved&q=x")).toBe("#/library?q=x");
  expect(legacyRedirect(`#/inbox/${a}?state=pending`)).toBe(`#/library/${a}?state=pending`);
  expect(legacyRedirect(`#/inbox/${a}`)).toBe(`#/library/${a}`);
  expect(legacyRedirect("#/archive")).toBe("#/library?state=archived");
  expect(legacyRedirect(`#/archive/${a}`)).toBe(`#/library/${a}?state=archived`);
  expect(legacyRedirect("#/library?type=research&channel=omo&q=x")).toBe("#/library?q=x");
  expect(legacyRedirect(`#/work/${a}`)).toBeNull();
  expect(legacyRedirect("#/more")).toBeNull();
});

test("더보기 is a route and owns 할 일, 휴지통, 채널 관리 and 설정 as its section", () => {
  expect(parseRoute("#/more")).toEqual({ view: "more", id: null, params: {} });
  expect(["work", "trash", "channels", "settings", "more"].map(view => sectionOf(parseRoute(`#/${view}`).view))).toEqual(["more", "more", "more", "more", "more"]);
  expect(["home", "digest", "library"].map(view => sectionOf(parseRoute(`#/${view}`).view))).toEqual(["home", "digest", "library"]);
});

test("a reader opened from its list goes back one history step to that list, filters kept", () => {
  const route = parseRoute(`#/library/${a}?state=pending`);
  expect(backOf(route, { from: "#/library?state=pending" }, true)).toEqual({ hash: "#/library?state=pending", steps: 1, place: "reader" });
  // On a desktop the list is beside the reader, so there is nothing to go back to.
  expect(backOf(route, { from: "#/library?state=pending" }, false)).toBeNull();
});

test("a reader opened by address goes up to its list on a phone instead of leaving the app", () => {
  const route = parseRoute(`#/library/${a}?channel=omo`);
  expect(backOf(route, null, true)).toEqual({ hash: "#/library?channel=omo", steps: 0, place: "reader" });
  expect(backOf(route, { from: null }, false)).toBeNull();
});

test("a record reached from another record goes back to it on every width", () => {
  const route = parseRoute(`#/library/${b}`);
  const back: Back = { hash: `#/library/${a}`, steps: 1, place: "reader" };
  expect(backOf(route, { from: `#/library/${a}` }, false)).toEqual(back);
  expect(backOf(route, { from: `#/library/${a}` }, true)).toEqual(back);
  expect(backLabel(back.hash)).toBe("이전 기록");
});

test("할 일, 휴지통 and 채널 관리 go back to where they were opened from, else up to 더보기 on a phone", () => {
  expect(backOf(parseRoute("#/work"), { from: "#/more" }, true)).toEqual({ hash: "#/more", steps: 1, place: "list" });
  expect(backOf(parseRoute("#/trash"), null, true)).toEqual({ hash: "#/more", steps: 0, place: "list" });
  expect(backOf(parseRoute("#/channels"), { from: "#/home" }, false)).toEqual({ hash: "#/home", steps: 1, place: "list" });
  // A desktop sidebar already lists them, so an address-opened one has no back.
  expect(backOf(parseRoute("#/trash"), null, false)).toBeNull();
});

test("a desktop reader inside 할 일 keeps the list's back, two history steps away", () => {
  const route = parseRoute(`#/work/${a}`);
  expect(backOf(route, { from: "#/work", listFrom: "#/more" }, false)).toEqual({ hash: "#/more", steps: 2, place: "list" });
  expect(backOf(route, { from: "#/work", listFrom: "#/more" }, true)).toEqual({ hash: "#/work", steps: 1, place: "reader" });
});

test("the tab screens have no back, wherever they were opened from", () => {
  for (const hash of ["#/home", "#/library?state=archived", "#/digest", "#/more"]) {
    expect(backOf(parseRoute(hash), { from: "#/trash" }, true)).toBeNull();
    expect(backOf(parseRoute(hash), null, true)).toBeNull();
  }
});

test("the back label names the screen it returns to", () => {
  expect(backLabel("#/library?state=pending")).toBe("기록");
  expect(backLabel("#/home")).toBe("메인");
  expect(backLabel("#/more")).toBe("더보기");
  expect(backLabel("#/channels")).toBe("채널 관리");
});

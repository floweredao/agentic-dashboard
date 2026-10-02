import { expect, test } from "bun:test";
import { RecordInputSchema } from "../../shared/contracts";
import { blankRecord } from "../model";
import { addTags, composeKind, draftFromText, linkBlocks, linkText, linksFromBlocks, newLinkBlock, pasteLinks } from "./draft";

test("a pasted URL becomes a link draft titled by host and path", () => {
  // Given: one URL with www., a query, a fragment and a trailing slash, padded with whitespace.
  const text = "  https://www.example.com/docs/guide/?utm=1#top \n";
  // When: a social draft is derived without an explicit title.
  const draft = draftFromText(text, "social");
  // Then: the link is kept as pasted, the title is readable, and the draft validates.
  expect(draft.links).toEqual([{ label: "원문", url: "https://www.example.com/docs/guide/?utm=1#top" }]);
  expect(draft.title).toBe("example.com/docs/guide");
  expect(draft.body).toBe("");
  expect(draft.fields).toEqual(blankRecord("social").fields);
  expect(RecordInputSchema.safeParse(draft).success).toBe(true);
});

test("pasted text splits into a first-line title and the remaining body", () => {
  // Given: a heading line, a blank line and two body lines.
  const text = "\n## 분기 회고 ##\n\n첫 줄\n둘째 줄\n";
  // When: a note draft is derived.
  const draft = draftFromText(text, "note");
  // Then: heading marks are stripped from the title and the body keeps its line breaks.
  expect(draft.title).toBe("분기 회고");
  expect(draft.body).toBe("첫 줄\n둘째 줄");
  expect(draft.links).toEqual([]);
  expect(draft.kind).toBe("note");
});

test("the title is capped at 200 characters and empty text yields no title", () => {
  // Given: a first line longer than the schema allows.
  const long = "가".repeat(260);
  // When/Then: the derived title fits the limit and a blank paste has nothing to save.
  expect(draftFromText(long, "research").title).toHaveLength(200);
  expect(draftFromText("   \n ", "research").title).toBe("");
});

test("a non-empty explicit title wins and keeps the whole text as the body", () => {
  // Given: text with its own first line and a URL, each with an explicit title.
  const fromText = draftFromText("첫 줄\n둘째 줄", "task", " 직접 쓴 제목 ");
  const fromUrl = draftFromText("https://example.com/a", "note", "링크 제목");
  // Then: the explicit title replaces the derived one; the text is not split; the link stays.
  expect(fromText.title).toBe("직접 쓴 제목");
  expect(fromText.body).toBe("첫 줄\n둘째 줄");
  expect(fromText.status).toBe("todo");
  expect(fromUrl.title).toBe("링크 제목");
  expect(fromUrl.links).toEqual([{ label: "원문", url: "https://example.com/a" }]);
  // And: a whitespace-only explicit title falls back to the derived title.
  expect(draftFromText("본문 제목", "note", "  ").title).toBe("본문 제목");
});

test("link blocks keep labels of unchanged URLs, drop empty blocks and label new ones", () => {
  // Given: a saved record with a generic and a custom label, edited to keep both, add a URL and leave a blank block.
  const previous = [{ label: "원문", url: "https://a.example/x" }, { label: "공식 문서", url: "https://d.example" }, { label: "링크", url: "https://gone.example" }];
  const blocks = linkBlocks(previous.slice(0, 2));
  // Then: generic labels are left for the placeholder, custom ones are editable text.
  expect(blocks.map(block => block.label)).toEqual(["", "공식 문서"]);
  // When: a new block and an empty block are appended and the list is saved for a report.
  const { links, invalid } = linksFromBlocks([...blocks, newLinkBlock("  https://b.example  "), newLinkBlock(" ")], previous, "research");
  // Then: the unchanged URL keeps "원문", the typed label wins, the new URL gets "링크", and the removed one is gone.
  expect(invalid).toEqual([]);
  expect(links).toEqual([
    { label: "원문", url: "https://a.example/x" },
    { label: "공식 문서", url: "https://d.example" },
    { label: "링크", url: "https://b.example" },
  ]);
});

test("a new first link on a social record is labelled 원문 and invalid blocks are named", () => {
  const bad = newLinkBlock("not a url");
  const { links, invalid } = linksFromBlocks([newLinkBlock("https://x.com/a/status/1"), newLinkBlock("https://b.example", " 참고 "), bad, newLinkBlock("ftp://x")], [], "social");
  expect(links.slice(0, 2)).toEqual([{ label: "원문", url: "https://x.com/a/status/1" }, { label: "참고", url: "https://b.example" }]);
  expect(invalid).toHaveLength(2);
  expect(invalid[0]).toBe(bad.id);
});

test("pasting several URL lines splits them into blocks within the link limit", () => {
  // Given: an empty block between two filled ones.
  const blocks = [newLinkBlock("https://a.example"), newLinkBlock(), newLinkBlock("https://z.example")];
  // When: three URL lines are pasted into the empty block.
  const pasted = pasteLinks(blocks, 1, "https://b.example\n\n https://c.example \nhttps://d.example");
  // Then: the empty block takes the first URL and the rest follow it in order.
  expect(pasted?.map(block => block.url)).toEqual(["https://a.example", "https://b.example", "https://c.example", "https://d.example", "https://z.example"]);
  // And: a single line is left to the browser, and the list never exceeds 10 blocks.
  expect(pasteLinks(blocks, 1, "https://b.example")).toBeNull();
  const lines = Array.from({ length: 12 }, (_, index) => `https://e${index}.example`).join("\n");
  expect(pasteLinks(blocks, 0, lines)).toHaveLength(10);
});

test("addTags strips #, trims, dedupes and respects the contract limits", () => {
  expect(addTags(["조사"], " #보고, 조사,, ##링크 ,")).toEqual(["조사", "보고", "링크"]);
  expect(addTags([], "  ")).toEqual([]);
  expect(addTags([], "가".repeat(120))[0]).toHaveLength(100);
  const full = Array.from({ length: 20 }, (_, index) => `t${index}`);
  expect(addTags(full, "새 태그")).toEqual(full);
});

test("the compose kind follows the text until the owner picks one", () => {
  // Given/When: no explicit pick, then an explicit pick.
  // Then: plain text is a memo, a lone URL or empty text is a link, and a pick always wins.
  expect(composeKind("모바일 메모\n내용", null)).toBe("note");
  expect(composeKind(" https://example.com/a ", null)).toBe("social");
  expect(composeKind("", null)).toBe("social");
  expect(composeKind("모바일 메모", "task")).toBe("task");
  expect(composeKind("https://example.com", "note")).toBe("note");
});

test("linkText shows the address for generic labels and keeps a custom label", () => {
  expect(linkText({ label: "원문", url: "https://www.example.com/docs/guide/" })).toBe("example.com/docs/guide");
  expect(linkText({ label: "링크", url: "https://example.net/new" })).toBe("example.net/new");
  expect(linkText({ label: "", url: "https://example.org" })).toBe("example.org");
  expect(linkText({ label: "가격표", url: "https://example.com/pricing" })).toBe("가격표");
});

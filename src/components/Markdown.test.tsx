import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { recordByRef } from "../model";
import { Markdown } from "./Markdown";
import type { ResolveRecord } from "./Markdown";

const html = (text: string) => renderToStaticMarkup(<Markdown text={text} />);

const earlier = { id: "b1d095e5-e555-4a5c-b740-80b5bc1ab176", title: "Claude 아키텍트 자격증 가치와 공부 방향" };
const twins = [{ id: "c0ffee12-0000-4000-8000-000000000001", title: "하나" }, { id: "c0ffee12-0000-4000-8000-000000000002", title: "둘" }];
const resolve: ResolveRecord = token => {
  const item = recordByRef([earlier, ...twins], token);
  return item ? { ...item, href: `#/library/${item.id}` } : null;
};
const linked = (text: string) => renderToStaticMarkup(<Markdown text={text} resolveRecord={resolve} />);
const earlierLink = (text: string) =>
  `<a href="#/library/${earlier.id}" class="record-ref" title="${earlier.title}">${text}</a>`;

test("a loaded record's full id becomes an in-app link even across a line break and before a Korean particle", () => {
  // Given: the real continuation sentence, whose id sits on its own line and is followed by ")에".
  const out = linked(`이 기록은 앞 기록 "${earlier.title}"(\n${earlier.id})에 이어지는 글이다.`);
  // Then: the id is an internal record link titled with the record title, and the text around it is unchanged.
  expect(out).toContain(`(<br/>${earlierLink(earlier.id)})에 이어지는 글이다.`);
  expect(out).not.toContain("target=");
});

test("a unique 8-hex short id links, an ambiguous or unknown one stays text", () => {
  // Given: the real summary short id, a prefix shared by two records, and one no record has.
  const out = linked("Claude 자격증 기록(b1d095e5)에 이어, c0ffee12 그리고 deadbe11 확인");
  // Then: only the unique short id is linked.
  expect(out).toContain(`기록(${earlierLink("b1d095e5")})에 이어`);
  expect(out).toContain(" c0ffee12 그리고 deadbe11 확인");
  expect(out.match(/record-ref/g)).toHaveLength(1);
  // And: an unknown full id stays text too.
  expect(linked("00000000-0000-4000-8000-00000000abcd")).toBe("<p>00000000-0000-4000-8000-00000000abcd</p>");
});

test("ids inside code spans, URLs and longer words are never converted", () => {
  // Given: the known id inside inline code, a bare URL, a Markdown link and a longer hex word.
  const out = linked(`\`${earlier.id}\` https://example.com/r/${earlier.id} [원문](https://example.com/${earlier.id}) xb1d095e5 b1d095e5f`);
  // Then: no record link appears; code and URLs render as before.
  expect(out).not.toContain("record-ref");
  expect(out).toContain(`<code>${earlier.id}</code>`);
  expect(out).toContain(`href="https://example.com/r/${earlier.id}"`);
});

test("without resolveRecord no record links are made", () => {
  expect(html(`앞 기록(${earlier.id}), b1d095e5`)).toBe(`<p>앞 기록(${earlier.id}), b1d095e5</p>`);
});

test("report structure renders as headings, lists, code and tables", () => {
  // Given: representative report blocks, including one nested list level.
  const source = "# 결론\n\n### 세부\n\n- 하나\n  - 둘\n1. 셋\n\n```ts\nconst a = 1;\n```\n\n| 항목 | 상태 |\n|---|:-:|\n| 목록 | 완료 |\n\n> 인용\n\n---";
  // When: the Markdown is rendered to React markup.
  const out = html(source);
  // Then: each supported block has its semantic element.
  expect(out).toContain("<h3>결론</h3>");
  expect(out).toContain("<h4>세부</h4>");
  expect(out).toContain("<ul><li>하나<ul><li>둘</li></ul></li></ul>");
  expect(out).toContain("<ol><li>셋</li></ol>");
  expect(out).toContain("<pre data-lang=\"ts\"><code>const a = 1;</code></pre>");
  expect(out).toContain("<th style=\"text-align:center\">상태</th>");
  expect(out).toContain("<td>목록</td>");
  expect(out).toContain("<blockquote><p>인용</p></blockquote>");
  expect(out).toContain("<hr/>");
});

test("inline emphasis, code and soft breaks stay inside one paragraph", () => {
  // Given / When: inline Markdown and a soft line break are rendered.
  const out = html("**굵게** 와 *기울임* 그리고 `코드`\n다음 줄");
  // Then: emphasis is semantic and the line break is preserved.
  expect(out).toBe("<p><strong>굵게</strong> 와 <em>기울임</em> 그리고 <code>코드</code><br/>다음 줄</p>");
});

test("raw HTML is shown as text and unsafe links never become anchors", () => {
  // Given: raw HTML, unsafe schemes, and one safe HTTP link.
  const source = "<script>alert(1)</script>\n\n[x](javascript:alert(1)) [mail](mailto:test@example.com) [ok](https://example.com)";
  // When: the untrusted text is rendered.
  const out = html(source);
  // Then: HTML and unsafe schemes stay text while HTTP(S) is linked.
  expect(out).not.toContain("<script>");
  expect(out).toContain("&lt;script&gt;");
  expect(out).not.toContain("javascript:alert(1)\"");
  expect(out).not.toContain("href=\"mailto:");
  expect(out).toContain("<a href=\"https://example.com\" target=\"_blank\" rel=\"noopener noreferrer\">ok</a>");
});

test("bare URLs become external links without trailing punctuation", () => {
  // Given / When: a bare URL followed by sentence punctuation is rendered.
  const out = html("참고: https://bun.com/docs.");
  // Then: punctuation stays outside the safe external link.
  expect(out).toBe("<p>참고: <a href=\"https://bun.com/docs\" target=\"_blank\" rel=\"noopener noreferrer\">https://bun.com/docs</a>.</p>");
});

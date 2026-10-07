import type { ReactNode } from "react";
import { strings } from "../i18n";

const text = strings({
  en: { done: "Done", notDone: "Not done" },
  ko: { done: "완료", notDone: "미완료" },
});

type Align = "left" | "center" | "right" | null;
type Block =
  | { readonly type: "heading"; readonly level: number; readonly text: string }
  | { readonly type: "paragraph"; readonly lines: readonly string[] }
  | { readonly type: "code"; readonly lang: string; readonly text: string }
  | { readonly type: "quote"; readonly blocks: readonly Block[] }
  | { readonly type: "hr" }
  | { readonly type: "list"; readonly ordered: boolean; readonly start: number; readonly items: readonly Item[] }
  | { readonly type: "table"; readonly head: readonly string[]; readonly align: readonly Align[]; readonly rows: readonly (readonly string[])[] };
type Item = { readonly text: string; readonly checked: boolean | null; readonly children: readonly Block[] };

const fence = /^\s{0,3}(`{3,}|~{3,})\s*([\w+-]*)/;
const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const rule = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const bullet = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const quote = /^\s{0,3}>\s?(.*)$/;
const separator = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const indentOf = (line: string) => line.length - line.trimStart().length;
const cells = (row: string) => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(cell => cell.trim());
const startsBlock = (line: string, next = "") => fence.test(line) || heading.test(line) || rule.test(line)
  || bullet.test(line) || quote.test(line) || (line.includes("|") && separator.test(next));

function parse(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const next = lines[i + 1] ?? "";
    if (!line.trim()) { i += 1; continue; }
    const open = fence.exec(line);
    if (open) {
      const marker = open[1] ?? "```";
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? "").trim().startsWith(marker)) { body.push(lines[i] ?? ""); i += 1; }
      blocks.push({ type: "code", lang: open[2] ?? "", text: body.join("\n") });
      i += 1;
      continue;
    }
    const title = heading.exec(line);
    if (title) { blocks.push({ type: "heading", level: title[1]?.length ?? 1, text: title[2] ?? "" }); i += 1; continue; }
    if (rule.test(line)) { blocks.push({ type: "hr" }); i += 1; continue; }
    if (line.includes("|") && separator.test(next)) {
      const head = cells(line);
      const align = cells(next).map((cell): Align => cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : cell.startsWith(":") ? "left" : null);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && (lines[i] ?? "").includes("|") && (lines[i] ?? "").trim()) { rows.push(cells(lines[i] ?? "")); i += 1; }
      blocks.push({ type: "table", head, align, rows });
      continue;
    }
    if (quote.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && quote.test(lines[i] ?? "")) { inner.push(quote.exec(lines[i] ?? "")?.[1] ?? ""); i += 1; }
      blocks.push({ type: "quote", blocks: parse(inner.join("\n")) });
      continue;
    }
    const first = bullet.exec(line);
    if (first) {
      const base = indentOf(line);
      const ordered = /\d/.test(first[2] ?? "");
      const items: { text: string; rest: string[] }[] = [];
      while (i < lines.length) {
        const current = lines[i] ?? "";
        const match = bullet.exec(current);
        if (match && indentOf(current) <= base + 1 && /\d/.test(match[2] ?? "") === ordered) { items.push({ text: match[3] ?? "", rest: [] }); i += 1; continue; }
        if (!current.trim()) {
          const after = lines[i + 1] ?? "";
          if (after.trim() && (indentOf(after) > base || (bullet.test(after) && indentOf(after) <= base + 1))) { items.at(-1)?.rest.push(""); i += 1; continue; }
          break;
        }
        if (indentOf(current) > base) { items.at(-1)?.rest.push(current); i += 1; continue; }
        if (!startsBlock(current)) { const last = items.at(-1); if (last) last.text += `\n${current.trim()}`; i += 1; continue; }
        break;
      }
      blocks.push({
        type: "list", ordered, start: ordered ? Number.parseInt(first[2] ?? "1", 10) || 1 : 1,
        items: items.map(({ text, rest }) => {
          const task = /^\[([ xX])\]\s+/.exec(text);
          const pad = Math.min(...rest.filter(entry => entry.trim()).map(indentOf), Number.MAX_SAFE_INTEGER);
          return { text: task ? text.slice(task[0].length) : text, checked: task ? task[1] !== " " : null,
            children: parse(rest.map(entry => entry.slice(Number.isFinite(pad) ? pad : 0)).join("\n")) };
        }),
      });
      continue;
    }
    const paragraph: string[] = [];
    while (i < lines.length && (lines[i] ?? "").trim() && (paragraph.length === 0 || !startsBlock(lines[i] ?? "", lines[i + 1]))) {
      paragraph.push((lines[i] ?? "").trim()); i += 1;
    }
    blocks.push({ type: "paragraph", lines: paragraph });
  }
  return blocks;
}

const safeHref = (url: string) => /^https?:\/\//i.test(url) ? url : null;
const inlinePattern = /(`+)([^`]+?)\1|\*\*(.+?)\*\*|__(.+?)__|(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?!\w)|(?<![\w_])_(?!\s)(.+?)(?<!\s)_(?!\w)|\[([^\]]+)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)|(https?:\/\/[^\s<>()"']+[^\s<>()"'.,;:!?])/;

/** A loaded record an inline id names; `href` is the in-app hash route that opens it. */
export type RecordRef = { readonly id: string; readonly title: string; readonly href: string };
export type ResolveRecord = (token: string) => RecordRef | null;
/** A full record UUID, or a standalone 8-hex short id with at least one digit and one letter; never part of a longer word. */
const refPattern = /(?<![0-9A-Za-z_-])(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?=[0-9a-f]{0,7}\d)(?=[0-9a-f]{0,7}[a-f])[0-9a-f]{8})(?![0-9A-Za-z_-])/gi;

/** Plain text with ids of loaded records turned into internal links; unresolved ids stay text. */
function refs(text: string, key: string, resolve?: ResolveRecord): ReactNode[] {
  if (!resolve) return [text];
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(refPattern)) {
    const ref = resolve(match[0]);
    if (!ref) continue;
    if (match.index > last) out.push(text.slice(last, match.index));
    out.push(<a key={`${key}-r${match.index}`} href={ref.href} className="record-ref" title={ref.title}>{match[0]}</a>);
    last = match.index + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function inline(text: string, key = "i", resolve?: ResolveRecord): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let index = 0;
  while (rest) {
    const match = inlinePattern.exec(rest);
    const id = `${key}-${index++}`;
    if (!match) { out.push(...refs(rest, id, resolve)); break; }
    if (match.index > 0) out.push(...refs(rest.slice(0, match.index), `${id}t`, resolve));
    const [whole, , code, bold, bold2, em, em2, label, url, bare] = match;
    if (code !== undefined) out.push(<code key={id}>{code}</code>);
    else if (bold !== undefined || bold2 !== undefined) out.push(<strong key={id}>{inline(bold ?? bold2 ?? "", id, resolve)}</strong>);
    else if (em !== undefined || em2 !== undefined) out.push(<em key={id}>{inline(em ?? em2 ?? "", id, resolve)}</em>);
    else if (label !== undefined && url !== undefined) {
      const href = safeHref(url);
      // A link label never nests a record link: anchors cannot contain anchors.
      out.push(href ? <a key={id} href={href} target="_blank" rel="noopener noreferrer">{inline(label, id)}</a> : <span key={id}>{whole}</span>);
    } else if (bare !== undefined) out.push(<a key={id} href={bare} target="_blank" rel="noopener noreferrer">{bare}</a>);
    rest = rest.slice(match.index + whole.length);
  }
  return out;
}

function lines(text: string, key: string, resolve?: ResolveRecord) {
  return text.split("\n").flatMap((line, index) => index === 0 ? inline(line, `${key}-${index}`, resolve)
    : [<br key={`${key}-br${index}`} />, ...inline(line, `${key}-${index}`, resolve)]);
}

/** A line that ends a sentence (closing quotes and brackets allowed after the mark). */
const sentenceEnd = /[.!?。！？…]["'”’)\]」』]*$/;

/**
 * Agents often write one sentence per line with no blank line between them; each such line reads as its own paragraph.
 * A line that stops mid-sentence (a hard wrap) stays a line break within its paragraph.
 */
function paragraphs(source: readonly string[]): string[][] {
  const groups: string[][] = [[]];
  for (const line of source) {
    groups.at(-1)?.push(line);
    if (sentenceEnd.test(line)) groups.push([]);
  }
  return groups.filter(group => group.length > 0);
}

function render(blocks: readonly Block[], key = "b", resolve?: ResolveRecord): ReactNode[] {
  return blocks.map((block, index) => {
    const id = `${key}-${index}`;
    switch (block.type) {
      case "heading": {
        const Tag = block.level <= 2 ? "h3" : "h4";
        return <Tag key={id}>{inline(block.text, id, resolve)}</Tag>;
      }
      case "paragraph": return paragraphs(block.lines).map((group, part) =>
        <p key={`${id}-${part}`}>{lines(group.join("\n"), `${id}-${part}`, resolve)}</p>);
      case "code": return <pre key={id} data-lang={block.lang || undefined}><code>{block.text}</code></pre>;
      case "quote": return <blockquote key={id}>{render(block.blocks, id, resolve)}</blockquote>;
      case "hr": return <hr key={id} />;
      case "table": return <div key={id} className="table-scroll"><table>
        <thead><tr>{block.head.map((cell, column) => <th key={column} style={{ textAlign: block.align[column] ?? undefined }}>{inline(cell, `${id}-h${column}`, resolve)}</th>)}</tr></thead>
        <tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{block.head.map((_, column) => <td key={column} style={{ textAlign: block.align[column] ?? undefined }}>{inline(row[column] ?? "", `${id}-${rowIndex}-${column}`, resolve)}</td>)}</tr>)}</tbody>
      </table></div>;
      case "list": {
        const items = block.items.map((item, itemIndex) => <li key={itemIndex} className={item.checked === null ? undefined : "task"}>
          {item.checked !== null && <input type="checkbox" checked={item.checked} disabled readOnly aria-label={item.checked ? text().done : text().notDone} />}
          {lines(item.text, `${id}-${itemIndex}`, resolve)}
          {render(item.children, `${id}-${itemIndex}`, resolve)}
        </li>);
        return block.ordered ? <ol key={id} start={block.start === 1 ? undefined : block.start}>{items}</ol> : <ul key={id}>{items}</ul>;
      }
    }
  });
}

/**
 * Renders Markdown as React elements only: raw HTML stays text and only HTTP(S) links become anchors.
 * With `resolveRecord`, ids of loaded records in plain text (never in code or URLs) become in-app `record-ref` links.
 */
export function Markdown({ text, resolveRecord }: { readonly text: string; readonly resolveRecord?: ResolveRecord }) {
  return <>{render(parse(text), "b", resolveRecord)}</>;
}

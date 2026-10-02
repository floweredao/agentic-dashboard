import type { RecordInput, RecordKind } from "../../shared/contracts";
import { strings } from "../i18n";
import { blankRecord } from "../model";

const genericLabels = {
  en: { source: "Source", link: "Link" },
  ko: { source: "원문", link: "링크" },
};
const generic = strings(genericLabels);
const everyGeneric: readonly string[] = [...Object.values(genericLabels.en), ...Object.values(genericLabels.ko)];

const decode = (path: string) => { try { return decodeURIComponent(path); } catch { return path; } };

/** The trimmed text when it is exactly one http(s) URL, otherwise null. */
export function urlOf(text: string): URL | null {
  const candidate = text.trim();
  if (!/^https?:\/\/\S+$/i.test(candidate)) return null;
  try { return new URL(candidate); } catch { return null; }
}

/** Host and path without www., query, fragment or a trailing slash. */
export function urlTitle(url: URL): string {
  return `${url.hostname.replace(/^www\./, "")}${decode(url.pathname)}`.replace(/\/+$/, "").slice(0, 200);
}

/** The owner's pick wins; otherwise empty text or a lone URL is a link and any other text is a memo. */
export function composeKind(text: string, picked: RecordKind | null): RecordKind {
  if (picked) return picked;
  return text.trim() === "" || urlOf(text) ? "social" : "note";
}

/** The address for the generic source/link labels or an empty one, otherwise the owner's own label. */
export function linkText(link: RecordInput["links"][number]): string {
  if (!genericLabel(link.label)) return link.label;
  const url = urlOf(link.url);
  return url ? urlTitle(url) : link.url;
}

/** A pasted URL becomes a link with a readable title; text splits into a first-line title and a body. */
export function draftFromText(text: string, kind: RecordKind, title = ""): RecordInput {
  const base = blankRecord(kind);
  const explicit = title.trim();
  const url = urlOf(text);
  if (url) return { ...base, title: explicit || urlTitle(url), links: [{ label: generic().source, url: text.trim() }] };
  const lines = text.split(/\r?\n/);
  const index = lines.findIndex(line => line.trim() !== "");
  if (index < 0) return { ...base, title: explicit };
  if (explicit) return { ...base, title: explicit, body: text.trim() };
  const heading = (lines[index] ?? "").trim().replace(/^#{1,6}\s*/, "").replace(/\s+#+$/, "");
  return { ...base, title: heading.slice(0, 200).trim(), body: lines.slice(index + 1).join("\n").trim() };
}

/** Contract limits for record links and tags (shared/contracts.ts). */
export const linkLimits = { count: 10, url: 2048, label: 200 } as const;
export const tagLimits = { count: 20, length: 100 } as const;

/** One editable link row. `label` holds only a name the owner chose; generic labels stay implicit. */
export interface LinkBlock { readonly id: string; readonly url: string; readonly label: string }

let nextBlock = 0;
export function newLinkBlock(url = "", label = ""): LinkBlock {
  nextBlock += 1;
  return { id: `link-${nextBlock}`, url, label };
}

/** Empty, or the generic source/link label of either language (saved links keep the language they were made in). */
const genericLabel = (label: string) => {
  const trimmed = label.trim();
  return trimmed === "" || everyGeneric.includes(label);
};

/** Saved links as editable blocks; a generic source/link label is left for the placeholder to show. */
export function linkBlocks(links: RecordInput["links"]): LinkBlock[] {
  return links.map(link => newLinkBlock(link.url, genericLabel(link.label) ? "" : link.label));
}

/** Blocks with several pasted URL lines split into one block per line, or null for a single-line paste. */
export function pasteLinks(blocks: readonly LinkBlock[], index: number, text: string): LinkBlock[] | null {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(line => line !== "");
  const target = blocks[index];
  if (lines.length < 2 || !target) return null;
  const [first = "", ...rest] = target.url.trim() === "" ? lines : ["", ...lines];
  const replaced = target.url.trim() === "" ? [{ ...target, url: first }] : [target];
  const room = Math.max(0, linkLimits.count - blocks.length);
  return [...blocks.slice(0, index), ...replaced, ...rest.slice(0, room).map(url => newLinkBlock(url)), ...blocks.slice(index + 1)];
}

/**
 * Blocks as record links. Empty blocks are dropped; `invalid` lists the ids of blocks that are not
 * a single http(s) URL. A typed name wins; otherwise an unchanged URL keeps its saved generic label,
 * and a new one is "Source" as the first link of a social record, else "Link" (in the current language).
 */
export function linksFromBlocks(blocks: readonly LinkBlock[], previous: RecordInput["links"] = [], kind?: RecordKind):
  { readonly links: RecordInput["links"]; readonly invalid: readonly string[] } {
  const labels = new Map<string, string>();
  for (const link of previous) if (!labels.has(link.url)) labels.set(link.url, link.label);
  const filled = blocks.map(block => ({ ...block, url: block.url.trim(), label: block.label.trim() })).filter(block => block.url !== "");
  const invalid = filled.filter(block => block.url.length > linkLimits.url || urlOf(block.url) === null).map(block => block.id);
  const links = filled.map((block, index) => {
    const saved = labels.get(block.url);
    const label = block.label || (saved !== undefined && genericLabel(saved) ? saved : kind === "social" && index === 0 ? generic().source : generic().link);
    return { label: label.slice(0, linkLimits.label), url: block.url };
  });
  return { links, invalid };
}

/** Comma-separated text added to the tags: leading # stripped, trimmed, deduplicated, within limits. */
export function addTags(tags: readonly string[], text: string): string[] {
  const next = [...tags];
  for (const part of text.split(",")) {
    const tag = part.trim().replace(/^#+/, "").trim().slice(0, tagLimits.length).trim();
    if (tag !== "" && !next.includes(tag) && next.length < tagLimits.count) next.push(tag);
  }
  return next;
}

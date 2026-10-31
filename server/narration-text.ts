import { NARRATION_LIMITS } from "../shared/contracts";
import type { DashboardRecord } from "../shared/contracts";
import { spokenNumbers, statedFigures } from "./spoken-numbers";
import { type SpeechTurn } from "./narration-types";
import { KOREAN_TONE_AGAIN, TONE_MIN_SENTENCES, TONE_MIN_SHARE, FACTS_AGAIN, FACTS_AGAIN_ITEMS } from "./narration-prompts";

export const KIND_LABELS: Record<string, string> = { research: "Research", "work-report": "Work report", note: "Note", social: "Link" };

/**
 * The script length to measure its progress against: about the model input's length (a record of about 1,000
 * input characters turned into a script of about the same length), at least a short note's and at most the length the
 * instructions allow. Only the bar uses it; a longer script stops at the end of the script's share.
 */
export function expectedScriptChars(prompt: string, max: number = NARRATION_LIMITS.scriptChars) {
  return Math.min(max - 500, Math.max(600, prompt.length));
}


export const text = (record: DashboardRecord, key: string) => {
  const value = record.fields[key];
  return typeof value === "string" ? value.trim() : "";
};

/** What the narration is made from; anything else (tags, links, review state, star) never makes audio stale. */
export function sourceHash(record: DashboardRecord) {
  const content = [record.title, text(record, "summary"), text(record, "conclusion"), record.body.trim(), text(record, "nextActions")];
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(content)).digest("hex");
}

/** Whether an edit changed what a record's audio reads (title, summary, conclusion, body, next actions). */
export function narrationSourceChanged(before: DashboardRecord, after: DashboardRecord) {
  return sourceHash(before) !== sourceHash(after);
}

/** A body's parts and where the current one sits, when a record is scripted part by part. */
export interface BodyPart { readonly text: string; readonly index: number; readonly total: number }

/** `part` null: only the record's summary fields (Summary only), no body. */
export function scriptPrompt(record: DashboardRecord, label?: string, part?: BodyPart | null) {
  const lines = ["[Record]", `Kind: ${label ?? KIND_LABELS[record.kind] ?? record.kind}`, `Title: ${record.title}`];
  for (const [label, key] of [["Conclusion", "conclusion"], ["Summary", "summary"], ["Next actions", "nextActions"]] as const) {
    const value = text(record, key);
    if (value) lines.push(`${label}: ${value}`);
  }
  if (part === null) return lines.join("\n");
  const heading = part && part.total > 1 ? `[Body ${part.index + 1}/${part.total}]` : "[Body]";
  lines.push("", heading, (part ? part.text : record.body.trim().slice(0, NARRATION_LIMITS.sourceChars)) || "(none)");
  return lines.join("\n");
}


export const SOURCE_HEADING = /^(?:\d+[.)]\s*)?(?:sources?|references?|bibliography|links?|출처|참고(?:\s*(?:자료|문헌|링크))?|참고한\s*자료|원문(?:\s*링크)?|링크)\s*:?$/i;

export const WORK_LOG_HEADING = /^(?:\d+[.)]\s*)?(?:verification|validation|research methods?(?:\s*(?:and|&)\s*limitations?)?|limitations?|what was kept (?:and|or) deleted|evidence (?:grades?|legend)|검증(?:\s*(?:방법|과정|내역))?|조사\s*방법(?:\s*(?:[·,]|및|과|와)\s*한계)?|못\s*한\s*것(?:\s*(?:[·,]|및|과|와)\s*한계)?|남긴\s*것\s*(?:[·,]|및|과|와)?\s*지운\s*것|근거\s*(?:강도|등급)(?:\s*표시)?)\s*:?$/i;

export const LANE_TAG = /\s*[(（](?:레인|lanes?)\s[^)）]*[)）]/gi;

export const CITE_TAG = /\s*\[[A-Z]{1,3}\d{0,3}(?:\s*[,·/]\s*[A-Z]{1,3}\d{0,3})*\](?!\()/g;

export const LINK_ONLY = /^\s*(?:[-*+]|\d+[.)])?\s*(?:\[[^\]]*\]\([^)]*\)|<?(?:https?:\/\/|www\.)\S+>?)\s*$/i;

export const TABLE_ROW = /^\s*\|.*\|\s*$/;

/**
 * The part of a record body worth hearing: fenced code, Markdown tables, lines holding only a link, and source or
 * reference sections (a heading such as `## Sources` or a bold `**References**` line, up to the next heading of the same
 * or a higher level) are left out before the script model sees the body.
 */
export function listeningSource(body: string): string {
  const kept: string[] = [];
  let fenced = false;
  let skipping = 0;
  for (const line of body.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^\s*(?:```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const heading = /^(#{1,6})\s+(.*)$/.exec(line.trim());
    const bold = heading ? null : /^\*\*(.+?)\*\*\s*:?$/.exec(line.trim());
    if (heading) {
      const level = heading[1]?.length ?? 1;
      if (skipping && level > skipping) continue;
      const title = (heading[2] ?? "").replace(/[*_]/g, "").trim();
      skipping = SOURCE_HEADING.test(title) || WORK_LOG_HEADING.test(title) ? level : 0;
      if (skipping) continue;
    } else if (bold && (SOURCE_HEADING.test(bold[1]?.trim() ?? "") || WORK_LOG_HEADING.test(bold[1]?.trim() ?? ""))) {
      skipping = skipping || 7;
      continue;
    } else if (skipping) continue;
    if (TABLE_ROW.test(line) || LINK_ONLY.test(line)) continue;
    kept.push(line.replace(LANE_TAG, "").replace(CITE_TAG, ""));
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * A body split for scripting in parts of at most `max` characters: whole sections (split before each Markdown heading)
 * packed in order, a section too long for one part split between paragraphs, and a paragraph too long split after a sentence.
 */
export function scriptParts(source: string, max: number = NARRATION_LIMITS.partChars): string[] {
  if (source.length <= max) return [source];
  const pieces: string[] = [];
  for (const section of source.split(/\n(?=#{1,6}\s)/).map(value => value.trim()).filter(Boolean)) {
    if (section.length <= max) { pieces.push(section); continue; }
    for (let paragraph of section.split(/\n\s*\n/).map(value => value.trim()).filter(Boolean)) {
      while (paragraph.length > max) {
        const head = cut(paragraph, max);
        pieces.push(head);
        paragraph = paragraph.slice(head.length).trim();
      }
      if (paragraph) pieces.push(paragraph);
    }
  }
  const parts: string[] = [];
  for (const piece of pieces) {
    const last = parts.at(-1);
    if (last !== undefined && last.length + 2 + piece.length <= max) parts[parts.length - 1] = `${last}\n\n${piece}`;
    else parts.push(piece);
  }
  return parts;
}


/** Whether the source is mostly Korean: Hangul syllables make up at least a fifth of its letters. */
export function isKorean(record: DashboardRecord) {
  const content = [record.title, text(record, "summary"), text(record, "conclusion"), record.body, text(record, "nextActions")].join(" ");
  const hangul = content.match(/[가-힣]/g)?.length ?? 0;
  const latin = content.match(/[A-Za-z]/g)?.length ?? 0;
  return hangul > 0 && hangul * 5 >= hangul + latin;
}

/** The script's sentences ending in Hangul, with their closing marks; podcast labels and lines without a closing mark are ignored. */
export function hangulSentences(script: string) {
  return script.split(/\n+/)
    .flatMap(line => line.replace(/(^|\s)[AB]\s*[:：]\s*/g, "$1").match(/[^.!?]+[.!?]+/g) ?? [])
    .map(sentence => ({ sentence: sentence.trim(), end: sentence.trim().replace(/[.!?'"”’)\]\s]+$/, "") }))
    .filter(({ end }) => /[가-힣]$/.test(end));
}

/** Korean sentences ending in a plain (반말 or written) form instead of 해요체 or 습니다체; lines without a closing mark are ignored. */
export function plainSentences(script: string): string[] {
  return hangulSentences(script).filter(({ end }) => !/(?:요|죠|니다|니까)$/.test(end)).map(({ sentence }) => sentence);
}

/** The tone a Korean script is almost entirely written in (해요체 or 습니다체), or null when it mixes both or is too short to tell. */
export function oneSidedTone(script: string): keyof typeof KOREAN_TONE_AGAIN | null {
  let haeyo = 0;
  let hamnida = 0;
  for (const { end } of hangulSentences(script)) {
    if (/(?:니다|니까)$/.test(end)) hamnida += 1;
    else if (/(?:요|죠)$/.test(end)) haeyo += 1;
  }
  const total = haeyo + hamnida;
  if (total < TONE_MIN_SENTENCES) return null;
  if (hamnida < total * TONE_MIN_SHARE) return "haeyo";
  if (haeyo < total * TONE_MIN_SHARE) return "hamnida";
  return null;
}

/**
 * The articles of a digest body (`- title (source): summary` lines; message lines start with `- [importance]`) whose summary
 * states a number the script never says, as digits or as it is read, with those numbers. Script models drop a summary's
 * middle sentence, and with it its time, date or count, when told to keep items short.
 */
export function missingFigures(body: string, script: string): { title: string; figures: string[] }[] {
  const compact = (value: string) => value.replace(/[\s,]/g, "");
  const said = `${compact(script)}\n${compact(spokenNumbers(script))}`;
  const missing: { title: string; figures: string[] }[] = [];
  for (const line of body.split("\n")) {
    const item = /^- (?!\[)(.+?): (.+)$/.exec(line);
    if (!item) continue;
    const [, head = "", summary = ""] = item;
    const figures = statedFigures(summary).filter(figure => !figure.forms.some(form => said.includes(form))).map(figure => figure.raw);
    if (figures.length > 0) missing.push({ title: head.replace(/ \([^)]*\)$/, ""), figures });
  }
  return missing;
}

export function factsAgain(missing: readonly { title: string; figures: string[] }[]) {
  return `${FACTS_AGAIN} ${missing.slice(0, FACTS_AGAIN_ITEMS).map(item => `'${item.title}'의 ${item.figures.join(", ")}`).join("; ")}`;
}


/** Removes what a listener should not hear (URLs, Markdown, code) and keeps the script within the length cap. */
export function normalizeScript(raw: string, max: number = NARRATION_LIMITS.scriptChars): string {
  const stripped = raw.replace(/\r\n?/g, "\n")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<?(?:https?:\/\/|www\.)[^\s<>]+>?/gi, " ")
    .replace(/`([^`]*)`/g, "$1");
  const paragraphs = stripped.split(/\n\s*\n/).map(paragraph => paragraph.split("\n")
    .filter(line => !/^\s*\|?[\s:|-]+\|?\s*$/.test(line) || !line.includes("-"))
    .map(line => line.replace(/^\s*(?:#{1,6}\s*|>\s*|[-+]\s+|\d+[.)]\s+)/, "").replace(/[*~|]+/g, " ").replace(/[ \t]+/g, " ").trim())
    .filter(Boolean).join("\n")).filter(Boolean);
  const script = paragraphs.join("\n\n");
  return script.length <= max ? script : cut(script, max);
}

export function cut(script: string, max: number) {
  const head = script.slice(0, max);
  const paragraph = head.lastIndexOf("\n\n");
  if (paragraph >= max * 0.6) return head.slice(0, paragraph).trim();
  const sentence = Math.max(...[". ", "? ", "! ", ".\n"].map(mark => head.lastIndexOf(mark)));
  if (sentence >= max * 0.6) return head.slice(0, sentence + 1).trim();
  return head.trim();
}

/** Paragraphs packed into chunks of at most `max` characters; an oversized paragraph is split by sentence, then hard. */
export function splitChunks(script: string, max: number = NARRATION_LIMITS.chunkChars): string[] {
  const chunks: string[] = [];
  let current = "";
  const add = (piece: string, separator: string) => {
    if (!piece) return;
    if (current && current.length + separator.length + piece.length <= max) { current += separator + piece; return; }
    if (current) chunks.push(current);
    current = piece;
  };
  for (const paragraph of script.split(/\n{2,}/).map(value => value.trim()).filter(Boolean)) {
    if (paragraph.length <= max) { add(paragraph, "\n\n"); continue; }
    const sentences = paragraph.match(/[^.!?\n]+(?:[.!?]+|\n|$)/g) ?? [paragraph];
    sentences.forEach((sentence, index) => {
      const trimmed = sentence.trim();
      for (let start = 0; start < trimmed.length; start += max) add(trimmed.slice(start, start + max), index === 0 && start === 0 ? "\n\n" : " ");
    });
  }
  if (current) chunks.push(current);
  return chunks;
}

export const SPEAKER_LINE = /^\s*([AB])\s*[:：]\s*/;

/**
 * A podcast script (`A: ...` / `B: ...` paragraphs) as speaker turns packed into chunks of at most `max` characters.
 * A line without a label continues the turn before it (A at the start); a turn longer than a chunk is split by sentence.
 */
export function dialogueChunks(script: string, max: number = NARRATION_LIMITS.chunkChars): SpeechTurn[][] {
  const turns: { speaker: "A" | "B"; text: string }[] = [];
  for (const paragraph of script.split(/\n{2,}/)) {
    paragraph.split("\n").forEach((line, index) => {
      const label = SPEAKER_LINE.exec(line);
      const text = (label ? line.slice(label[0].length) : line).trim();
      const last = turns.at(-1);
      if (label?.[1] === "A" || label?.[1] === "B") turns.push({ speaker: label[1], text });
      else if (!text) return;
      else if (!last) turns.push({ speaker: "A", text });
      else last.text = last.text ? `${last.text}${index === 0 ? "\n\n" : "\n"}${text}` : text;
    });
  }
  const chunks: SpeechTurn[][] = [];
  let current: SpeechTurn[] = [];
  let size = 0;
  for (const turn of turns) {
    for (const text of turn.text.length <= max ? [turn.text] : splitChunks(turn.text, max)) {
      if (!text) continue;
      if (current.length && size + text.length > max) { chunks.push(current); current = []; size = 0; }
      current.push({ speaker: turn.speaker, text });
      size += text.length;
    }
  }
  if (current.length) chunks.push(current);
  return chunks;
}

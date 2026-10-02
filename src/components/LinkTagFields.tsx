import { useEffect, useRef, useState } from "react";
import type { ClipboardEvent, FormEvent, KeyboardEvent } from "react";
import { ExternalLink, Plus, X } from "lucide-react";
import type { DashboardRecord, RecordInput } from "../../shared/contracts";
import { useDashboard } from "../state";
import { addTags, linkBlocks, linkLimits, linkText, linksFromBlocks, newLinkBlock, pasteLinks, tagLimits, urlOf } from "../views/draft";
import type { LinkBlock } from "../views/draft";

const urlInputProps = { type: "url", inputMode: "url", spellCheck: false, autoCapitalize: "off", autoComplete: "off" } as const;
const invalidLinkMessage = "https://로 시작하는 주소 하나만 적어 주세요.";

const automaticName = (block: LinkBlock) => urlOf(block.url) ? linkText({ label: "", url: block.url }) : "이름 (선택)";

/** Editable link rows: URL + optional name + remove; multi-line pastes split into rows. */
export function LinkFields({ idPrefix, blocks, errors, onChange }: {
  readonly idPrefix: string; readonly blocks: readonly LinkBlock[]; readonly errors: ReadonlySet<string>;
  readonly onChange: (blocks: LinkBlock[], edited?: string) => void;
}) {
  const addButton = useRef<HTMLButtonElement>(null);
  const [focusTarget, setFocusTarget] = useState<string | null>(null);
  useEffect(() => {
    if (focusTarget === null) return;
    setFocusTarget(null);
    if (focusTarget === "add") addButton.current?.focus();
    else document.getElementById(`${idPrefix}-url-${focusTarget}`)?.focus();
  }, [focusTarget, idPrefix]);

  const set = (index: number, changes: Partial<LinkBlock>) => {
    const block = blocks[index];
    if (block) onChange(blocks.map((item, at) => at === index ? { ...item, ...changes } : item), block.id);
  };
  const remove = (index: number) => {
    // Focus moves to the next row, or to 링크 추가 when the last row goes.
    const next = blocks[index + 1];
    onChange(blocks.filter((_, at) => at !== index));
    setFocusTarget(next ? next.id : "add");
  };
  const add = () => {
    const block = newLinkBlock();
    onChange([...blocks, block]);
    setFocusTarget(block.id);
  };
  const paste = (index: number, event: ClipboardEvent<HTMLInputElement>) => {
    const split = pasteLinks(blocks, index, event.clipboardData.getData("text"));
    if (!split) return;
    event.preventDefault();
    onChange(split, blocks[index]?.id);
  };

  return <fieldset className="field field-wide link-fields">
    <legend className="field-legend">링크</legend>
    {blocks.length > 0 && <ul className="link-blocks">{blocks.map((block, index) => {
      const invalid = errors.has(block.id);
      const errorId = `${idPrefix}-error-${block.id}`;
      return <li key={block.id} className="link-block">
        <div className="link-block-fields">
          <label className="link-block-field">
            <span className="visually-hidden">링크 {index + 1} 주소</span>
            <input id={`${idPrefix}-url-${block.id}`} {...urlInputProps} className="input" placeholder="https://" maxLength={linkLimits.url}
              value={block.url} onChange={event => set(index, { url: event.target.value })} onPaste={event => paste(index, event)}
              aria-invalid={invalid ? true : undefined} aria-describedby={invalid ? errorId : undefined} />
          </label>
          <label className="link-block-field">
            <span className="visually-hidden">링크 {index + 1} 이름 (선택)</span>
            <input className="input" maxLength={linkLimits.label} placeholder={automaticName(block)}
              value={block.label} onChange={event => set(index, { label: event.target.value })} />
          </label>
        </div>
        <button type="button" className="icon-btn link-block-remove" aria-label="링크 삭제" title="링크 삭제" onClick={() => remove(index)}>
          <X size={16} aria-hidden="true" />
        </button>
        {invalid && <small id={errorId} className="field-error link-block-error" role="alert">{invalidLinkMessage}</small>}
      </li>;
    })}</ul>}
    <button ref={addButton} type="button" className="btn btn-quiet field-add" onClick={add} disabled={blocks.length >= linkLimits.count}>
      <Plus size={16} aria-hidden="true" />링크 추가
    </button>
    {blocks.length >= linkLimits.count && <small>링크는 {linkLimits.count}개까지 넣을 수 있어요.</small>}
  </fieldset>;
}

/** True for the Enter that commits text, not the one that confirms a Korean IME candidate. */
const committingEnter = (event: KeyboardEvent<HTMLInputElement>) => event.key === "Enter" && !event.nativeEvent.isComposing;

/** Tag chips followed by an input: Enter or comma adds, Backspace on empty removes the last chip. */
export function TagFields({ tags, draft, onTags, onDraft }: {
  readonly tags: readonly string[]; readonly draft: string;
  readonly onTags: (update: (tags: string[]) => string[]) => void; readonly onDraft: (text: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const commit = () => {
    if (draft.trim() === "") return;
    const text = draft;
    onTags(current => addTags(current, text));
    onDraft("");
  };
  const remove = (index: number) => {
    onTags(current => current.filter(tag => tag !== tags[index]));
    // Focus moves to the next chip's remove button, or back to the input after the last one.
    const next = list.current?.querySelectorAll<HTMLButtonElement>("button")[index + 1];
    (next ?? input.current)?.focus();
  };
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) return; // Cmd/Ctrl+Enter belongs to the form's submit shortcut
    if (committingEnter(event)) { event.preventDefault(); commit(); return; }
    if (event.key === "Enter") { event.preventDefault(); return; }
    if (event.key === "Backspace" && draft === "" && tags.length > 0) { event.preventDefault(); onTags(current => current.slice(0, -1)); }
  };
  const change = (text: string) => {
    if (!text.includes(",")) { onDraft(text); return; }
    const parts = text.split(",");
    const rest = parts.pop() ?? "";
    onTags(current => addTags(current, parts.join(",")));
    onDraft(rest);
  };

  return <fieldset className="field field-wide tag-fields">
    <legend className="field-legend">태그</legend>
    <div className="tag-editor">
      {tags.length > 0 && <ul ref={list} className="tag-chips">{tags.map((tag, index) => <li key={tag} className="tag-chip">
        <span>#{tag}</span>
        <button type="button" aria-label={`태그 ${tag} 삭제`} title="삭제" onClick={() => remove(index)}><X size={14} aria-hidden="true" /></button>
      </li>)}</ul>}
      <input ref={input} className="input tag-input" aria-label="태그 추가" placeholder="태그 입력 후 Enter" maxLength={tagLimits.length}
        value={draft} onChange={event => change(event.target.value)} onKeyDown={keyDown} onBlur={commit} />
    </div>
    {tags.length >= tagLimits.count && <small>태그는 {tagLimits.count}개까지 넣을 수 있어요.</small>}
  </fieldset>;
}

const hostName = (url: string) => urlOf(url)?.hostname.replace(/^www\./, "") ?? "";

export function LinkCard({ link }: { readonly link: RecordInput["links"][number] }) {
  return <a className="link-card" href={link.url} target="_blank" rel="noopener noreferrer">
    <span className="link-card-text"><span className="link-card-host">{hostName(link.url)}</span><span className="link-card-name">{linkText(link)}</span></span>
    <ExternalLink size={16} aria-hidden="true" />
  </a>;
}

/** Reader: 링크 추가 reveals a URL + optional name form that appends one link with a version-checked save. */
export function InlineLinkAdd({ record }: { readonly record: DashboardRecord }) {
  const d = useDashboard();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState("");
  const toggle = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) field.current?.focus(); }, [open]);
  if (record.links.length >= linkLimits.count) return null;

  const close = () => { setOpen(false); setUrl(""); setLabel(""); setError(""); requestAnimationFrame(() => toggle.current?.focus()); };
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const block = newLinkBlock(url, label);
    const { links, invalid } = linksFromBlocks([...linkBlocks(record.links), block], record.links, record.kind);
    if (url.trim() === "" || invalid.includes(block.id)) { setError(invalidLinkMessage); field.current?.focus(); return; }
    if (await d.patch(record, { links }, "링크를 추가했어요.")) close();
  }

  if (!open) return <button ref={toggle} type="button" className="btn btn-quiet inline-add" onClick={() => setOpen(true)} disabled={d.busy}>
    <Plus size={16} aria-hidden="true" />링크 추가
  </button>;
  const errorId = `link-add-error-${record.id}`;
  return <form className="inline-add-form" onSubmit={submit} onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); close(); } }}>
    <label className="inline-add-field"><span className="visually-hidden">링크 주소</span>
      <input ref={field} {...urlInputProps} className="input" placeholder="https://" maxLength={linkLimits.url} value={url}
        onChange={event => { setUrl(event.target.value); setError(""); }}
        aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : undefined} />
    </label>
    <label className="inline-add-field"><span className="visually-hidden">링크 이름 (선택)</span>
      <input className="input" maxLength={linkLimits.label} placeholder="이름 (선택)" value={label} onChange={event => setLabel(event.target.value)} />
    </label>
    <div className="inline-add-actions">
      <button type="submit" className="btn btn-primary" disabled={d.busy}>추가</button>
      <button type="button" className="btn btn-outline" onClick={close}>취소</button>
    </div>
    {error && <small id={errorId} className="field-error" role="alert">{error}</small>}
  </form>;
}

/** Reader: 태그 추가 reveals an input; Enter saves the new tag with a version-checked save. */
export function InlineTagAdd({ record }: { readonly record: DashboardRecord }) {
  const d = useDashboard();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const toggle = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) field.current?.focus(); }, [open]);
  if (record.tags.length >= tagLimits.count) return null;

  const close = () => { setOpen(false); setText(""); requestAnimationFrame(() => toggle.current?.focus()); };
  async function save() {
    const tags = addTags(record.tags, text);
    if (tags.length === record.tags.length) { close(); return; }
    if (await d.patch(record, { tags }, "태그를 추가했어요.")) close();
  }
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") { event.stopPropagation(); close(); return; }
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (!event.nativeEvent.isComposing) void save();
  };

  if (!open) return <button ref={toggle} type="button" className="btn btn-quiet inline-add" onClick={() => setOpen(true)} disabled={d.busy}>
    <Plus size={16} aria-hidden="true" />태그 추가
  </button>;
  return <span className="inline-tag-add">
    <input ref={field} className="input tag-input" aria-label="태그 추가" placeholder="태그 입력 후 Enter" maxLength={tagLimits.length}
      value={text} onChange={event => setText(event.target.value)} onKeyDown={keyDown} disabled={d.busy} />
    <button type="button" className="btn btn-outline" onClick={close}>취소</button>
  </span>;
}

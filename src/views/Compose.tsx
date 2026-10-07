import { useMemo, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import type { RecordKind } from "../../shared/contracts";
import { errorMessage } from "../api";
import { Dialog } from "../components/primitives";
import { strings } from "../i18n";
import { useDashboard } from "../state";
import { composeKind, draftFromText, urlOf } from "./draft";

const copy = strings({
  en: {
    link: "Link", note: "Note", task: "Task",
    discard: "Discard what you've written?",
    title: "New item", recordKind: "Record type",
    content: "URL or text", placeholder: "Paste a link or write something",
    titleField: "Title", optional: "optional",
    details: "More options", saving: "Saving…", save: "Save",
  },
  ko: {
    link: "링크", note: "메모", task: "할 일",
    discard: "쓰던 내용을 버릴까요?",
    title: "새로 저장", recordKind: "기록 종류",
    content: "URL 또는 내용", placeholder: "링크를 붙여 넣거나 내용을 적어 주세요",
    titleField: "제목", optional: "선택",
    details: "자세히 쓰기", saving: "저장 중…", save: "저장",
  },
});

const kindOptions = (t: ReturnType<typeof copy>) => [
  { value: "social", label: t.link },
  { value: "note", label: t.note },
  { value: "task", label: t.task },
] as const satisfies readonly { readonly value: RecordKind; readonly label: string }[];

export function Compose({ kind: requestedKind, onClose }: { readonly kind: RecordKind; readonly onClose: () => void }) {
  const t = copy();
  const kinds = kindOptions(t);
  const { create, editDraft } = useDashboard();
  // "social" is the default request, so it leaves the kind to follow the text until the owner picks one.
  const [picked, setPicked] = useState<RecordKind | null>(() =>
    requestedKind !== "social" && kinds.some(option => option.value === requestedKind) ? requestedKind : null);
  const [text, setText] = useState("");
  const kind = composeKind(text, picked);
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [requestId] = useState(() => crypto.randomUUID());
  const draft = useMemo(() => draftFromText(text, kind, title), [kind, text, title]);
  const url = useMemo(() => urlOf(text), [text]);

  const close = () => {
    if ((text.trim() || title.trim()) && !window.confirm(t.discard)) return;
    onClose();
  };

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft.title || saving) return;
    setSaving(true);
    setError("");
    try {
      await create(draft, requestId);
    } catch (cause) {
      setError(await errorMessage(cause));
      setSaving(false);
    }
  }

  function submitShortcut(event: KeyboardEvent<HTMLFormElement>) {
    if (event.key !== "Enter" || (!event.metaKey && !event.ctrlKey)) return;
    event.preventDefault();
    event.currentTarget.requestSubmit();
  }

  return <Dialog title={t.title} onClose={close}>
    <form className="compose-form" onSubmit={save} onKeyDown={submitShortcut}>
      <fieldset disabled={saving}>
        <legend className="visually-hidden">{t.recordKind}</legend>
        <div className="compose-kinds" role="radiogroup" aria-label={t.recordKind}>
          {kinds.map(option => <button key={option.value} type="button" className="chip" role="radio"
            aria-checked={kind === option.value} onClick={() => setPicked(option.value)}>{option.label}</button>)}
        </div>
        <label className="field compose-content">{t.content}
          <textarea autoFocus rows={7} value={text} onChange={event => setText(event.target.value)}
            placeholder={t.placeholder} />
        </label>
        {url && <p className="compose-preview" title={url.href}>{url.hostname.replace(/^www\./, "")}</p>}
        <label className="field"><span>{t.titleField} <span className="optional">{t.optional}</span></span>
          <input value={title} maxLength={200} onChange={event => setTitle(event.target.value)}
            placeholder={draft.title} />
        </label>
      </fieldset>
      <div className="dialog-actions">
        {error && <p className="form-error" role="alert">{error}</p>}
        <button type="button" className="btn btn-outline" disabled={saving} onClick={() => editDraft(draft)}>{t.details}</button>
        <button type="submit" className="btn btn-primary" disabled={!draft.title || saving}>{saving ? t.saving : t.save}</button>
      </div>
    </form>
  </Dialog>;
}

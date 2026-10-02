import { useMemo, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import type { RecordKind } from "../../shared/contracts";
import { errorMessage } from "../api";
import { Dialog } from "../components/primitives";
import { useDashboard } from "../state";
import { composeKind, draftFromText, urlOf } from "./draft";

const kinds = [
  { value: "social", label: "링크" },
  { value: "note", label: "메모" },
  { value: "task", label: "할 일" },
] as const satisfies readonly { readonly value: RecordKind; readonly label: string }[];

export function Compose({ kind: requestedKind, onClose }: { readonly kind: RecordKind; readonly onClose: () => void }) {
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
    if ((text.trim() || title.trim()) && !window.confirm("쓰던 내용을 버릴까요?")) return;
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

  return <Dialog title="새로 저장" onClose={close}>
    <form className="compose-form" onSubmit={save} onKeyDown={submitShortcut}>
      <fieldset disabled={saving}>
        <legend className="visually-hidden">기록 종류</legend>
        <div className="compose-kinds" role="radiogroup" aria-label="기록 종류">
          {kinds.map(option => <button key={option.value} type="button" className="chip" role="radio"
            aria-checked={kind === option.value} onClick={() => setPicked(option.value)}>{option.label}</button>)}
        </div>
        <label className="field compose-content">URL 또는 내용
          <textarea autoFocus rows={7} value={text} onChange={event => setText(event.target.value)}
            placeholder="링크를 붙여 넣거나 내용을 적어 주세요" />
        </label>
        {url && <p className="compose-preview" title={url.href}>{url.hostname.replace(/^www\./, "")}</p>}
        <label className="field"><span>제목 <span className="optional">선택</span></span>
          <input value={title} maxLength={200} onChange={event => setTitle(event.target.value)}
            placeholder={draft.title} />
        </label>
      </fieldset>
      <div className="dialog-actions">
        {error && <p className="form-error" role="alert">{error}</p>}
        <button type="button" className="btn btn-outline" disabled={saving} onClick={() => editDraft(draft)}>자세히 쓰기</button>
        <button type="submit" className="btn btn-primary" disabled={!draft.title || saving}>{saving ? "저장 중…" : "저장"}</button>
      </div>
    </form>
  </Dialog>;
}

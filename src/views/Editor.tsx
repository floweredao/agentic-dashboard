import { useId, useMemo, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { RECORD_LIMITS } from "../../shared/contracts";
import type { DashboardRecord, JSONValue, RecordInput, RecordKind } from "../../shared/contracts";
import { errorMessage } from "../api";
import { LinkFields, TagFields } from "../components/LinkTagFields";
import { Dialog } from "../components/primitives";
import { isRecord, kindLabels, projectStatuses, taskStatuses, textField } from "../model";
import { strings } from "../i18n";
import { useDashboard } from "../state";
import { addTags, linkBlocks, linksFromBlocks } from "./draft";

const copy = strings({
  en: {
    body: "Body", memo: "Note", content: "Content", description: "Description", overview: "Overview",
    conclusion: "Conclusion", summary: "Summary", nextActions: "Next steps",
    discard: "Discard unsaved changes?", edit: "Edit", create: "New",
    basics: "Basics", title: "Title", kind: "Type", status: "Status", dueDate: "Due date", project: "Project",
    none: "None", archived: " (archived)", today: "Do today",
    cancel: "Cancel", saving: "Saving…", save: "Save",
  },
  ko: {
    body: "본문", memo: "메모", content: "내용", description: "설명", overview: "개요",
    conclusion: "결론", summary: "요약", nextActions: "다음 할 일",
    discard: "저장하지 않은 내용을 버릴까요?", edit: "편집", create: "새로 만들기",
    basics: "기본", title: "제목", kind: "종류", status: "상태", dueDate: "마감일", project: "프로젝트",
    none: "없음", archived: " (보관됨)", today: "오늘 할 일",
    cancel: "취소", saving: "저장 중…", save: "저장",
  },
});

type Copy = ReturnType<typeof copy>;

const editableKinds = ["social", "note", "research", "work-report"] as const;
const isEditableKind = (value: string): value is (typeof editableKinds)[number] =>
  (editableKinds as readonly string[]).includes(value);
const bodyLabels = (t: Copy): Record<RecordKind, string> => ({
  research: t.body, "work-report": t.body, social: t.memo, note: t.content, task: t.description, project: t.overview,
});
type FieldList = readonly (readonly [string, string, number])[];
/** Text fields the editor shows per kind, in reading order; every other field is kept untouched. */
const leadFields = (t: Copy): Record<RecordKind, FieldList> => ({
  research: [["conclusion", t.conclusion, 2], ["summary", t.summary, 3]],
  "work-report": [["conclusion", t.conclusion, 2], ["summary", t.summary, 3]],
  social: [["summary", t.summary, 3]],
  note: [], task: [], project: [],
});
const trailFields = (t: Copy): Record<RecordKind, FieldList> => ({
  research: [["nextActions", t.nextActions, 3]],
  "work-report": [["nextActions", t.nextActions, 3]],
  project: [["nextAction", t.nextActions, 2]],
  social: [], note: [], task: [],
});

export function Editor({ initial, existing, requestId, onClose }: {
  readonly initial: RecordInput; readonly existing?: DashboardRecord; readonly requestId: string; readonly onClose: () => void;
}) {
  const t = copy();
  const { records, create, update } = useDashboard();
  const [input, setInput] = useState(initial);
  const [initialBlocks] = useState(() => linkBlocks(initial.links));
  const [blocks, setBlocks] = useState(initialBlocks);
  const [tags, setTags] = useState(() => [...initial.tags]);
  const [tagDraft, setTagDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [linkErrors, setLinkErrors] = useState<ReadonlySet<string>>(new Set());
  const linkIds = useId();
  const material = isRecord(input);
  const blockText = (list: typeof blocks) => JSON.stringify(list.map(block => [block.url, block.label]));
  // A new draft already holds text carried over from the quick-save dialog, so closing it would lose that text too.
  const dirty = JSON.stringify(input) !== JSON.stringify(initial) || blockText(blocks) !== blockText(initialBlocks)
    || JSON.stringify(tags) !== JSON.stringify(initial.tags) || tagDraft.trim() !== ""
    || (!existing && (initial.title.trim() !== "" || initial.body.trim() !== ""));
  const close = () => {
    if (dirty && !window.confirm(t.discard)) return;
    onClose();
  };
  const projects = useMemo(() => records.filter(record => record.kind === "project"), [records]);
  const setField = (key: string, value: JSONValue) =>
    setInput(current => ({ ...current, fields: { ...current.fields, [key]: value } }));

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const { links, invalid } = linksFromBlocks(blocks, initial.links, input.kind);
    if (material && invalid.length) {
      setLinkErrors(new Set(invalid));
      document.getElementById(`${linkIds}-url-${invalid[0]}`)?.focus();
      return;
    }
    setSaving(true);
    setError("");
    const next: RecordInput = material
      ? { ...input, links, tags: addTags(tags, tagDraft) }
      : input.kind === "task" ? { ...input, fields: { ...input.fields, taskType: input.projectId ? "project" : "general" } } : input;
    try {
      if (existing) await update(existing, next);
      else await create(next, requestId);
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

  const textArea = ([key, label, rows]: readonly [string, string, number]) => <label className="field field-wide" key={key}>{label}
    <textarea rows={rows} value={textField(input, key)} onChange={event => setField(key, event.target.value)} />
  </label>;

  return <Dialog size="wide" title={`${existing ? t.edit : t.create} · ${kindLabels[input.kind]}`} onClose={close}>
    <form className="editor-form" onSubmit={save} onKeyDown={submitShortcut}>
      <fieldset className="editor-section" disabled={saving}>
        <legend className="visually-hidden">{t.basics}</legend>
        <div className="form-grid">
          <label className="field field-wide">{t.title}
            <input autoFocus required maxLength={200} value={input.title}
              onChange={event => setInput({ ...input, title: event.target.value })} />
          </label>
          {!existing && material && <label className="field">{t.kind}
            <select value={input.kind} onChange={event => {
              if (isEditableKind(event.target.value)) setInput({ ...input, kind: event.target.value });
            }}>{editableKinds.map(kind => <option key={kind} value={kind}>{kindLabels[kind]}</option>)}</select>
          </label>}
          {!material && <label className="field">{t.status}
            <select value={input.status} onChange={event => setInput({ ...input, status: event.target.value })}>
              {Object.entries(input.kind === "project" ? projectStatuses : taskStatuses)
                .map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>}
          {input.kind === "task" && <>
            <label className="field">{t.dueDate}
              <input type="date" value={input.dueDate ?? ""} onChange={event => setInput({ ...input, dueDate: event.target.value || null })} />
            </label>
            {(projects.length > 0 || input.projectId) && <label className="field">{t.project}
              <select value={input.projectId ?? ""} onChange={event => setInput({ ...input, projectId: event.target.value || null })}>
                <option value="">{t.none}</option>
                {projects.map(record => <option key={record.id} value={record.id}>{record.title}{record.archivedAt ? t.archived : ""}</option>)}
              </select>
            </label>}
            <label className="check-field"><input type="checkbox" checked={input.fields.today === true}
              onChange={event => setField("today", event.target.checked)} />{t.today}</label>
          </>}
        </div>
      </fieldset>

      <fieldset className="editor-section" disabled={saving}>
        <legend className="visually-hidden">{t.content}</legend>
        <div className="form-grid">
          {leadFields(t)[input.kind].map(textArea)}
          <label className="field field-wide">{bodyLabels(t)[input.kind]}
            <textarea className="editor-body" rows={material && input.kind !== "social" ? 10 : 5} maxLength={RECORD_LIMITS.bodyChars} value={input.body}
              onChange={event => setInput({ ...input, body: event.target.value })} />
          </label>
          {trailFields(t)[input.kind].map(textArea)}
          {material && <>
            <LinkFields idPrefix={linkIds} blocks={blocks} errors={linkErrors} onChange={(next, edited) => {
              setBlocks(next);
              if (edited && linkErrors.has(edited)) setLinkErrors(new Set([...linkErrors].filter(id => id !== edited)));
            }} />
            <TagFields tags={tags} draft={tagDraft} onTags={setTags} onDraft={setTagDraft} />
          </>}
        </div>
      </fieldset>

      <div className="dialog-actions">
        {error && <p className="form-error" role="alert">{error}</p>}
        <button type="button" className="btn btn-outline" onClick={close} disabled={saving}>{t.cancel}</button>
        <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? t.saving : t.save}</button>
      </div>
    </form>
  </Dialog>;
}

import { useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { Send } from "lucide-react";
import type { Comment, DashboardRecord } from "../../shared/contracts";
import { channelLabel, isChannel, projectStatuses, relativeTime, taskStatuses, timelineOf } from "../model";
import { useDashboard } from "../state";
import { Markdown } from "./Markdown";

const nameOf = (id: string | null) => id && isChannel(id) ? channelLabel(id) : id ?? "";
const authorOf = (comment: Comment) => comment.source === "manual" ? "나" : channelLabel(comment.source);
const statusName = (record: DashboardRecord, status: string) =>
  (record.kind === "project" ? projectStatuses : taskStatuses)[status as keyof typeof taskStatuses & keyof typeof projectStatuses] ?? status;
function handling(comment: Comment) {
  if (comment.doneAt) return <p className="timeline-handled done">처리함 · {nameOf(comment.doneBy)} · {relativeTime(comment.doneAt)}</p>;
  if (comment.seenAt) return <p className="timeline-handled seen">{nameOf(comment.seenBy)}가 봤어요 · {relativeTime(comment.seenAt)}</p>;
  return <p className="timeline-handled">아직 안 봤어요</p>;
}

function Entry({ record, comment, replies }: { readonly record: DashboardRecord; readonly comment: Comment; readonly replies: readonly Comment[] }) {
  return <li className={`timeline-item ${comment.source === "manual" ? "from-owner" : "from-agent"}`}>
    <div className="timeline-head">
      <span className="timeline-author">{authorOf(comment)}</span>
      <span className="timeline-time">{relativeTime(comment.createdAt)}</span>
      {comment.status && <span className="tag">상태 → {statusName(record, comment.status)}</span>}
    </div>
    {comment.body && <div className="prose compact timeline-body"><Markdown text={comment.body} /></div>}
    {comment.source === "manual" && handling(comment)}
    {replies.length > 0 && <ul className="timeline-replies">
      {replies.map(reply => <Entry key={reply.id} record={record} comment={reply} replies={[]} />)}
    </ul>}
  </li>;
}

/** 진행 기록: agent reports and the owner's comments on a task or project, oldest first, with the owner's comment box last. */
export function Timeline({ record }: { readonly record: DashboardRecord }) {
  const d = useDashboard();
  const [draft, setDraft] = useState("");
  const entries = timelineOf(d.comments, record.id);
  const ids = new Set(entries.map(entry => entry.id));
  const top = entries.filter(entry => entry.replyTo === null || !ids.has(entry.replyTo));
  const addressee = record.source === "manual" ? "에이전트" : channelLabel(record.source);
  const send = async () => {
    const body = draft.trim();
    if (!body || d.busy) return;
    if (await d.addComment(record, body)) setDraft("");
  };
  const submit = (event: FormEvent) => { event.preventDefault(); void send(); };
  const shortcut = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void send(); }
  };
  return <section className="reader-section timeline" aria-labelledby="timeline-title">
    <h3 id="timeline-title">진행 기록</h3>
    {top.length === 0 ? <p className="timeline-empty">아직 보고나 코멘트가 없어요.</p>
      : <ol className="timeline-list">{top.map(entry =>
        <Entry key={entry.id} record={record} comment={entry} replies={entries.filter(reply => reply.replyTo === entry.id)} />)}
      </ol>}
    <form className="comment-form" onSubmit={submit}>
      <label className="visually-hidden" htmlFor="comment-draft">코멘트</label>
      <textarea id="comment-draft" rows={3} value={draft} placeholder={`${addressee}에게 남길 말`} maxLength={4000}
        onChange={event => setDraft(event.currentTarget.value)} onKeyDown={shortcut} />
      <button type="submit" className="btn btn-primary" disabled={d.busy || draft.trim() === ""}>
        <Send size={16} aria-hidden="true" />보내기
      </button>
    </form>
  </section>;
}

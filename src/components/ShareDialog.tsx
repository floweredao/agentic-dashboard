import { useEffect, useRef, useState } from "react";
import type { FocusEvent } from "react";
import { Copy } from "lucide-react";
import type { DashboardRecord } from "../../shared/contracts";
import { createShare, deleteShare, errorMessage } from "../api";
import type { Share } from "../api";
import { config } from "../config";
import { strings } from "../i18n";
import { useDashboard } from "../state";
import { Dialog } from "./primitives";

const text = strings({
  en: {
    message: (app: string, share: Share) => `Read this ${app} shared record: ${share.url}\n(code ${share.code} · one GET request returns it as Markdown)`,
    copyFailed: "Couldn't copy. Select the text and copy it yourself.",
    shareFailed: "Couldn't share to another app.", stopped: "Sharing stopped.",
    title: "Share with an agent",
    note: "Only devices and agents on the same private network can open this link. It is read-only and needs no sign-in.",
    preparing: "Preparing the link…",
    link: "Link", copyLink: "Copy link", copy: "Copy", linkCopied: "Link copied.",
    code: "Code", copyCode: "Copy code", codeCopied: "Code copied.",
    forAgent: "Message for an agent", messageCopied: "Message copied.", copyMessage: "Copy message for an agent",
    stop: "Stop sharing", elsewhere: "Share to another app", retry: "Try again",
  },
  ko: {
    message: (app: string, share: Share) => `${app} 공유 기록을 읽어 줘: ${share.url}\n(코드 ${share.code} · GET 요청 한 번으로 Markdown을 받을 수 있어요)`,
    copyFailed: "복사하지 못했어요. 직접 선택해 복사해 주세요.",
    shareFailed: "다른 앱으로 공유하지 못했어요.", stopped: "공유를 중지했어요.",
    title: "에이전트와 공유",
    note: "같은 비공개 네트워크에 연결된 기기와 에이전트만 이 링크를 열 수 있어요. 로그인 없이 읽기만 할 수 있어요.",
    preparing: "링크를 준비하는 중…",
    link: "링크", copyLink: "링크 복사", copy: "복사", linkCopied: "링크를 복사했어요.",
    code: "코드", copyCode: "코드 복사", codeCopied: "코드를 복사했어요.",
    forAgent: "에이전트용 문장", messageCopied: "문장을 복사했어요.", copyMessage: "에이전트용 문장 복사",
    stop: "공유 중지", elsewhere: "다른 앱으로 공유", retry: "다시 시도",
  },
});

export const agentMessage = (share: Share) => text().message(config.appName, share);
const pick = (field: HTMLInputElement | HTMLTextAreaElement | null) => { field?.focus(); field?.select(); };
const selectAll = (event: FocusEvent<HTMLInputElement>) => event.currentTarget.select();

export function ShareDialog({ record, csrfToken, onClose }: {
  readonly record: DashboardRecord; readonly csrfToken: string; readonly onClose: () => void;
}) {
  const { notify } = useDashboard();
  const [share, setShare] = useState<Share | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [messageFallback, setMessageFallback] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const urlField = useRef<HTMLInputElement>(null);
  const codeField = useRef<HTMLInputElement>(null);
  const messageField = useRef<HTMLTextAreaElement>(null);
  const retryButton = useRef<HTMLButtonElement>(null);
  const copyLinkButton = useRef<HTMLButtonElement>(null);
  const busy = loading || saving;
  const [attempt, setAttempt] = useState(0);

  // Opening the dialog is the request: POST returns the record's existing share or creates it, so the link shows at once.
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError("");
    createShare(record.id, csrfToken)
      .then(found => { if (live) setShare(found); })
      .catch(async (cause: unknown) => { const message = await errorMessage(cause); if (live) setError(message); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [record.id, csrfToken, attempt]);

  // When the request settles, the first command takes focus: copy link, or try again after a failure.
  useEffect(() => {
    if (!loading) (share ? copyLinkButton : retryButton).current?.focus();
  }, [loading, share]);

  useEffect(() => { if (messageFallback) pick(messageField.current); }, [messageFallback]);

  async function run(request: () => Promise<void>) {
    setSaving(true);
    setError("");
    try { await request(); }
    catch (cause) { setError(await errorMessage(cause)); }
    finally { setSaving(false); }
  }

  async function copy(value: string, done: string, fallback: () => void) {
    try {
      await navigator.clipboard.writeText(value);
      notify(done);
    } catch {
      fallback();
      notify(text().copyFailed, "error");
    }
  }

  async function shareElsewhere(url: string) {
    try { await navigator.share({ title: record.title, url }); }
    catch (cause) { if (!(cause instanceof DOMException && cause.name === "AbortError")) notify(text().shareFailed, "error"); }
  }

  const stop = () => run(async () => {
    await deleteShare(record.id, csrfToken);
    onClose();
    notify(text().stopped);
  });

  return <Dialog title={text().title} onClose={onClose}>
    <div ref={panel} className="share-dialog">
      <p className="share-note">{text().note}</p>
      {loading && <p className="share-loading" role="status">{text().preparing}</p>}
      {share && <>
        <div className="share-field">
          <label className="field"><span>{text().link}</span>
            <input ref={urlField} readOnly value={share.url} onFocus={selectAll} />
          </label>
          <button ref={copyLinkButton} type="button" className="btn btn-outline" aria-label={text().copyLink} disabled={busy}
            onClick={() => { void copy(share.url, text().linkCopied, () => pick(urlField.current)); }}>
            <Copy size={16} aria-hidden="true" />{text().copy}
          </button>
        </div>
        <div className="share-field">
          <label className="field"><span>{text().code}</span>
            <input ref={codeField} className="share-code" readOnly value={share.code} onFocus={selectAll} />
          </label>
          <button type="button" className="btn btn-outline" aria-label={text().copyCode} disabled={busy}
            onClick={() => { void copy(share.code, text().codeCopied, () => pick(codeField.current)); }}>
            <Copy size={16} aria-hidden="true" />{text().copy}
          </button>
        </div>
        {messageFallback && <label className="field"><span>{text().forAgent}</span>
          <textarea ref={messageField} readOnly rows={3} value={agentMessage(share)} />
        </label>}
      </>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {!loading && <div className="dialog-actions">
        {share ? <>
          <button type="button" className="btn btn-danger share-stop" disabled={busy} onClick={() => { void stop(); }}>{text().stop}</button>
          {typeof navigator.share === "function" && <button type="button" className="btn btn-outline" disabled={busy}
            onClick={() => { void shareElsewhere(share.url); }}>{text().elsewhere}</button>}
          <button type="button" className="btn btn-primary" disabled={busy}
            onClick={() => { void copy(agentMessage(share), text().messageCopied, () => { if (messageField.current) pick(messageField.current); else setMessageFallback(true); }); }}>
            {text().copyMessage}
          </button>
        </> : <button ref={retryButton} type="button" className="btn btn-primary" disabled={busy} onClick={() => setAttempt(value => value + 1)}>{text().retry}</button>}
      </div>}
    </div>
  </Dialog>;
}

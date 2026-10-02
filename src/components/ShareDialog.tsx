import { useEffect, useRef, useState } from "react";
import type { FocusEvent } from "react";
import { Copy } from "lucide-react";
import type { DashboardRecord } from "../../shared/contracts";
import { createShare, deleteShare, errorMessage } from "../api";
import type { Share } from "../api";
import { useDashboard } from "../state";
import { Dialog } from "./primitives";

export const agentMessage = (share: Share) =>
  `Agentic Dashboard 공유 기록을 읽어 줘: ${share.url}\n(코드 ${share.code} · GET 요청 한 번으로 Markdown을 받을 수 있어요)`;

const copyFailed = "복사하지 못했어요. 직접 선택해 복사해 주세요.";
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

  // Opening 공유 is the request: POST returns the record's existing share or creates it, so the link shows at once.
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

  // When the request settles, the first command takes focus: 링크 복사, or 다시 시도 after a failure.
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

  async function copy(text: string, done: string, fallback: () => void) {
    try {
      await navigator.clipboard.writeText(text);
      notify(done);
    } catch {
      fallback();
      notify(copyFailed, "error");
    }
  }

  async function shareElsewhere(url: string) {
    try { await navigator.share({ title: record.title, url }); }
    catch (cause) { if (!(cause instanceof DOMException && cause.name === "AbortError")) notify("다른 앱으로 공유하지 못했어요.", "error"); }
  }

  const stop = () => run(async () => {
    await deleteShare(record.id, csrfToken);
    onClose();
    notify("공유를 중지했어요.");
  });

  return <Dialog title="에이전트와 공유" onClose={onClose}>
    <div ref={panel} className="share-dialog">
      <p className="share-note">Tailscale에 연결된 기기와 에이전트만 이 링크를 열 수 있어요. 로그인 없이 읽기만 할 수 있어요.</p>
      {loading && <p className="share-loading" role="status">링크를 준비하는 중…</p>}
      {share && <>
        <div className="share-field">
          <label className="field"><span>링크</span>
            <input ref={urlField} readOnly value={share.url} onFocus={selectAll} />
          </label>
          <button ref={copyLinkButton} type="button" className="btn btn-outline" aria-label="링크 복사" disabled={busy}
            onClick={() => { void copy(share.url, "링크를 복사했어요.", () => pick(urlField.current)); }}>
            <Copy size={16} aria-hidden="true" />복사
          </button>
        </div>
        <div className="share-field">
          <label className="field"><span>코드</span>
            <input ref={codeField} className="share-code" readOnly value={share.code} onFocus={selectAll} />
          </label>
          <button type="button" className="btn btn-outline" aria-label="코드 복사" disabled={busy}
            onClick={() => { void copy(share.code, "코드를 복사했어요.", () => pick(codeField.current)); }}>
            <Copy size={16} aria-hidden="true" />복사
          </button>
        </div>
        {messageFallback && <label className="field"><span>에이전트용 문장</span>
          <textarea ref={messageField} readOnly rows={3} value={agentMessage(share)} />
        </label>}
      </>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {!loading && <div className="dialog-actions">
        {share ? <>
          <button type="button" className="btn btn-danger share-stop" disabled={busy} onClick={() => { void stop(); }}>공유 중지</button>
          {typeof navigator.share === "function" && <button type="button" className="btn btn-outline" disabled={busy}
            onClick={() => { void shareElsewhere(share.url); }}>다른 앱으로 공유</button>}
          <button type="button" className="btn btn-primary" disabled={busy}
            onClick={() => { void copy(agentMessage(share), "문장을 복사했어요.", () => { if (messageField.current) pick(messageField.current); else setMessageFallback(true); }); }}>
            에이전트용 문장 복사
          </button>
        </> : <button ref={retryButton} type="button" className="btn btn-primary" disabled={busy} onClick={() => setAttempt(value => value + 1)}>다시 시도</button>}
      </div>}
    </div>
  </Dialog>;
}

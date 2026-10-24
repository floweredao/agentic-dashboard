import { useEffect, useRef, useState } from "react";
import { useAccount, useCredentials } from "../account-context";
import { downloadAccount, removeAccount } from "../profile-api";
import { errorCode, errorMessage } from "../api-errors";
import { Dialog } from "../components/primitives";
import { strings } from "../i18n";
import { AccountPreferences } from "./AccountPreferences";

export const DELETE_INTENT = "agentic:delete-email";
const text = strings({
  en: { title: "Your account", signed: (email: string) => `Signed in with Google as ${email}`, replay: "Replay setup",
    exportTitle: "Export your data", export: "Download account archive", exporting: "Preparing download…", exportNote: "A .tar.gz archive with a README, JSON, attached documents, trash and audio, up to 64 MiB. Credentials are excluded. Open it with your archive utility; bulk import is not supported.",
    deletion: "Delete account", deleteNote: "Deletes active records, documents, audio, agents and sessions. Backups expire after 14 days; storage cleanup is retried if unavailable. This cannot be undone.",
    confirm: "Type your account email to confirm", cancel: "Cancel", reauth: "Sign in again to confirm",
    reauthNote: "Deletion needs a sign-in from the last 10 minutes. Your confirmation will be kept, but you must press Delete account again after signing in.",
    privacy: "Privacy", terms: "Terms", confirmationTitle: "Delete your account?" },
  ko: { title: "내 계정", signed: (email: string) => `Google 계정 ${email}로 로그인했어요`, replay: "시작 안내 다시 보기",
    exportTitle: "내 데이터 내보내기", export: "계정 자료 내려받기", exporting: "다운로드 준비 중…", exportNote: "안내문, JSON, 첨부 문서, 휴지통과 음성이 담긴 최대 64 MiB의 .tar.gz 파일이에요. 인증 정보는 제외해요. 압축 해제 도구로 열 수 있으며 일괄 가져오기는 제공하지 않아요.",
    deletion: "계정 삭제", deleteNote: "활성 기록·문서·음성·에이전트·세션을 지워요. 백업은 14일 뒤 만료되고, 저장소 정리가 실패하면 다시 시도해요. 되돌릴 수 없어요.",
    confirm: "확인을 위해 계정 이메일을 입력해 주세요", cancel: "취소", reauth: "다시 로그인하고 확인",
    reauthNote: "최근 10분 안에 로그인해야 계정을 지울 수 있어요. 입력한 확인 내용은 유지하지만 로그인한 뒤 계정 삭제를 다시 눌러야 해요.",
    privacy: "개인정보처리방침", terms: "이용약관", confirmationTitle: "계정을 삭제할까요?" },
});
export function AccountControls() {
  const context = useAccount();
  const { csrfToken } = useCredentials();
  const account = context?.account;
  const intentKey = `${DELETE_INTENT}:${account?.id ?? ""}`;
  const [confirm, setConfirm] = useState(() => sessionStorage.getItem(intentKey) ?? "");
  const [open, setOpen] = useState(() => context?.resumeDeletion === true && sessionStorage.getItem(intentKey) !== null);
  const [pending, setPending] = useState(false);
  const [reauth, setReauth] = useState(false);
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");
  const downloadUrl = useRef<string | null>(null);
  const downloadRequest = useRef<AbortController | null>(null);
  useEffect(() => () => {
    downloadRequest.current?.abort();
    if (downloadUrl.current) URL.revokeObjectURL(downloadUrl.current);
  }, []);
  const t = text();
  if (!account || !context) return null;
  const close = () => { setOpen(false); setConfirm(""); setError(""); setReauth(false); sessionStorage.removeItem(intentKey); };
  return <>
    <section className="more-group account-stack"><h2 className="more-heading">{t.title}</h2>
      <p>{account.email ? t.signed(account.email) : account.id}</p><div><a className="btn btn-outline" href="/welcome">{t.replay}</a></div>
    </section>
    <AccountPreferences account={account} csrfToken={csrfToken} onAccount={context.update} />
    <section className="more-group account-stack account-export"><h2 className="more-heading">{t.exportTitle}</h2>
      <p className="setting-note">{t.exportNote}</p><div><button className="btn btn-outline" disabled={exporting} onClick={() => {
        setExporting(true); setExportError("");
        const request = new AbortController();
        downloadRequest.current = request;
        void downloadAccount(request.signal).then(blob => {
          if (request.signal.aborted) return;
          if (downloadUrl.current) URL.revokeObjectURL(downloadUrl.current);
          downloadUrl.current = URL.createObjectURL(blob);
          const link = document.createElement("a");
          link.href = downloadUrl.current; link.download = "floweredao-export.tar.gz"; link.click();
        }, async cause => { if (!request.signal.aborted) setExportError(await errorMessage(cause)); }).finally(() => {
          if (!request.signal.aborted) setExporting(false);
          if (downloadRequest.current === request) downloadRequest.current = null;
        });
      }}>{exporting ? t.exporting : t.export}</button></div>
      {exportError && <p role="alert" className="form-error">{exportError}</p>}
    </section>
    <section className="more-group account-stack account-danger"><h2 className="more-heading">{t.deletion}</h2>
      <p className="setting-note">{t.deleteNote}</p><div><button className="btn btn-outline" onClick={() => setOpen(true)}>{t.deletion}</button></div>
    </section>
    <nav className="account-legal"><a href="/privacy">{t.privacy}</a><a href="/terms">{t.terms}</a></nav>
    {open && <Dialog title={t.confirmationTitle} onClose={close}>
      <form className="account-stack" onSubmit={event => {
        event.preventDefault(); setPending(true); setError("");
        void removeAccount(confirm, csrfToken).then(() => { sessionStorage.removeItem(intentKey); location.assign("/"); },
          async cause => {
            if (await errorCode(cause) === "reauth_required") { sessionStorage.setItem(intentKey, confirm); setReauth(true); }
            else setError(await errorMessage(cause));
          }).finally(() => setPending(false));
      }}>
        <p>{t.deleteNote}</p><label className="field"><span>{t.confirm}</span>
          <input type="email" autoComplete="off" value={confirm} placeholder={account.email ?? ""} onChange={event => setConfirm(event.target.value)} /></label>
        {error && <p role="alert" className="form-error">{error}</p>}
        {reauth && <><p>{t.reauthNote}</p><a className="btn btn-outline" href="/auth/google/start?intent=delete">{t.reauth}</a></>}
        <footer className="dialog-actions"><button type="button" className="btn btn-quiet" onClick={close}>{t.cancel}</button>
          <button className="btn btn-danger" disabled={pending || !account.email || confirm !== account.email || reauth}>{t.deletion}</button></footer>
      </form>
    </Dialog>}
  </>;
}

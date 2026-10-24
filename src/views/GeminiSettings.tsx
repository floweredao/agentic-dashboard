import { useEffect, useState } from "react";
import { getGemini, removeGemini, saveGemini, type KeyStatus } from "../account-api";
import { errorCode, errorMessage } from "../api";
import { RecoveryLink } from "../components/RecoveryLink";
import { strings } from "../i18n";
import { useDashboard } from "../state";
import { config } from "../config";
import "../styles/accounts.css";

const text = strings({
  en: {
    title: "Gemini key", intro: "Optional. Reading and saving work without a key.",
    privacy: "Audio and title enrichment send saved content to Google. Requests made with your key use your project and may incur charges.",
    get: "Get a key", terms: "Google API terms", field: "Your Gemini API key", validate: "Validate and save",
    replace: "Replace key", remove: "Remove key", accepted: "Key accepted", unset: "No key saved", loading: "Loading key settings…",
    model: "Model-list access was accepted. Audio-model access and quota are checked when you generate audio; this is not an audio test.",
    scriptModel: "Script model", speechModel: "Speech model", listed: "Listed for this key · generation not tested",
    notListed: "Not listed for this key · may be unavailable", notChecked: "Not checked this visit",
    masked: (last4: string) => `Saved key ending in ${last4}`, cancel: "Cancel", retry: "Retry",
    removeConfirm: "Remove this key? Reading and saving remain available, but new audio and title enrichment will stop.",
  },
  ko: {
    title: "Gemini 키", intro: "선택 사항이에요. 키 없이도 기록을 읽고 저장할 수 있어요.",
    privacy: "음성과 제목 보강은 저장한 내용을 Google로 보내요. 내 키로 보낸 요청은 내 프로젝트를 사용하며 요금이 발생할 수 있어요.",
    get: "키 발급받기", terms: "Google API 약관", field: "내 Gemini API 키", validate: "검증하고 저장",
    replace: "키 바꾸기", remove: "키 삭제", accepted: "키가 승인되었어요", unset: "저장한 키 없음", loading: "키 설정을 불러오는 중…",
    model: "모델 목록 조회가 승인되었어요. 음성 모델 권한과 한도는 음성을 만들 때 확인해요. 음성 생성 시험은 아니에요.",
    scriptModel: "대본 모델", speechModel: "음성 모델", listed: "키의 모델 목록에 있음 · 생성은 시험하지 않음",
    notListed: "키의 모델 목록에 없음 · 이용하지 못할 수 있음", notChecked: "이번 방문에서는 확인하지 않음",
    masked: (last4: string) => `끝 네 자리가 ${last4}인 키가 저장되어 있어요`, cancel: "취소", retry: "다시 시도",
    removeConfirm: "키를 삭제할까요? 기록을 읽고 저장할 수 있지만 새 음성과 제목 보강은 멈춰요.",
  },
});

export function GeminiSettings() {
  const t = text();
  const { csrfToken } = useDashboard();
  const [status, setStatus] = useState<KeyStatus | null>(null);
  const [key, setKey] = useState("");
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [code, setCode] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const models = config.narrationModels;
  const report = async (cause: unknown) => { setCode(await errorCode(cause)); setError(await errorMessage(cause)); };
  useEffect(() => {
    let active = true;
    setError("");
    getGemini().then(value => { if (active) setStatus(value); }, cause => { if (active) void report(cause); });
    return () => { active = false; };
  }, [attempt]);
  const save = async () => {
    setPending(true); setError("");
    try { setStatus(await saveGemini(key, csrfToken)); setKey(""); setEditing(false); }
    catch (cause) { await report(cause); }
    finally { setPending(false); }
  };
  const remove = async () => {
    if (!window.confirm(t.removeConfirm)) return;
    setPending(true); setError("");
    try { await removeGemini(csrfToken); setStatus({ configured: false, last4: null }); setKey(""); setEditing(false); }
    catch (cause) { await report(cause); }
    finally { setPending(false); }
  };
  return <section className="more-group account-section" id="gemini-key" aria-labelledby="gemini-heading">
    <h2 id="gemini-heading" className="more-heading">{t.title}</h2>
    <p>{t.intro}</p><p className="setting-note">{t.privacy}</p>
    <div className="account-actions"><a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">{t.get}</a>
      <a href="https://ai.google.dev/gemini-api/terms" target="_blank" rel="noreferrer">{t.terms}</a></div>
    {!status && !error && <p role="status">{t.loading}</p>}
    {status && <p role="status">{status.configured ? `${t.accepted} · ${t.masked(status.last4 ?? "")}` : t.unset}</p>}
    {status?.configured && <p className="setting-note">{t.model}</p>}
    {status?.configured && models && <dl className="account-models">
      <div><dt>{t.scriptModel}</dt><dd><code>{models.script}</code><span>{status.modelAvailability
        ? status.modelAvailability.script.listed ? t.listed : t.notListed : t.notChecked}</span></dd></div>
      <div><dt>{t.speechModel}</dt><dd><code>{models.speech}</code><span>{status.modelAvailability
        ? status.modelAvailability.speech.listed ? t.listed : t.notListed : t.notChecked}</span></dd></div>
    </dl>}
    {status && (!status.configured || editing) && <form onSubmit={event => { event.preventDefault(); void save(); }} className="account-stack">
      <label className="field"><span>{t.field}</span><input type="password" autoComplete="off" value={key}
        onChange={event => setKey(event.target.value)} required maxLength={512} spellCheck={false} /></label>
      <div className="account-actions"><button className="btn btn-primary" disabled={pending || !key.trim()}>{t.validate}</button>
        {editing && <button type="button" className="btn btn-quiet" onClick={() => { setEditing(false); setKey(""); }}>{t.cancel}</button>}</div>
    </form>}
    {status?.configured && !editing && <div className="account-actions">
      <button className="btn btn-outline" disabled={pending} onClick={() => setEditing(true)}>{t.replace}</button>
      <button className="btn btn-quiet" disabled={pending} onClick={() => void remove()}>{t.remove}</button>
    </div>}
    {error && <div role="alert"><p className="form-error">{error}</p><RecoveryLink code={code} />
      {!status && <button className="btn btn-outline" onClick={() => setAttempt(value => value + 1)}>{t.retry}</button>}</div>}
  </section>;
}

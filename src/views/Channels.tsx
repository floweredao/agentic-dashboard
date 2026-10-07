import { useEffect, useState } from "react";
import type { SyntheticEvent } from "react";
import { HTTPError } from "ky";
import { ArrowRight, KeyRound, LogOut } from "lucide-react";
import { errorMessage, listAgents } from "../api";
import type { AgentInfo } from "../api";
import { BackButton, ChannelMark, Dialog, SidebarOpen } from "../components/primitives";
import { config } from "../config";
import { strings } from "../i18n";
import { channelKeys, channelOf, channelLabel, isRecord, relativeTime } from "../model";
import type { Channel } from "../model";
import { formatRoute, viewTitles } from "../router";
import { useDashboard } from "../state";

const text = strings({
  en: {
    savedBy: (name: string) => `Records saved by ${name}`,
    share: "Links saved with the share button",
    manual: "Records you saved in this app",
    lastUsed: "Last used", removed: "Removed",
    noAgents: "No agents yet. Register one with",
    noAgentsAfter: "and give it the key that command prints.",
    total: "All", pending: "To review", latest: "Latest", none: "None", view: "View records",
    importSummary: "Advanced · Import JSON",
    importNote: "Paste a record's JSON from an agent to save it as your own record.",
    importField: "Record JSON", importButton: "Import", badJson: "That isn't valid JSON.",
    session: "Session", signedIn: "Signed in as the owner", logout: "Sign out",
    calendar: (zone: string) => `Dates use the ${zone} time zone, and weeks start on Sunday.`,
    gateIntro: "Sign in with the owner key. bun run setup prints it, and it is kept in data/credentials.json.",
    proxyMissed: "The reverse proxy did not identify you as the owner.",
    gateButton: "Sign in with the owner key",
    dialogTitle: "Owner sign-in", keyField: "Owner key",
    wrongKey: "That key doesn't match. Check the owner key you copied.",
    keyNote: "The key is not stored in this browser.",
    cancel: "Cancel", connect: "Sign in",
  },
  ko: {
    savedBy: (name: string) => `${name} 에이전트가 저장한 기록`,
    share: "iPhone 공유 버튼으로 저장한 링크",
    manual: "이 앱에서 직접 저장한 기록",
    lastUsed: "마지막 사용", removed: "연결 해제됨",
    noAgents: "아직 에이전트가 없어요. 다음 명령으로 등록하고",
    noAgentsAfter: "출력된 키를 에이전트에 넣어 주세요.",
    total: "전체", pending: "미확인", latest: "최근", none: "없음", view: "기록 보기",
    importSummary: "고급 · JSON으로 가져오기",
    importNote: "에이전트가 만든 기록 JSON을 하나 붙여 넣으면 직접 작성한 기록으로 저장해요.",
    importField: "기록 JSON", importButton: "가져오기", badJson: "JSON 형식이 올바르지 않아요.",
    session: "세션", signedIn: "소유자로 연결됨", logout: "로그아웃",
    calendar: (zone: string) => `날짜는 ${zone} 시간 기준이며, 한 주는 일요일에 시작해요.`,
    gateIntro: "소유자 키로 연결해 주세요. 키는 bun run setup이 출력하며 data/credentials.json에 저장돼 있어요.",
    proxyMissed: "리버스 프록시가 소유자를 확인하지 못했어요.",
    gateButton: "소유자 키로 연결",
    dialogTitle: "소유자 연결", keyField: "소유자 키",
    wrongKey: "키가 맞지 않아요. 복사한 소유자 키를 다시 확인해 주세요.",
    keyNote: "키는 이 브라우저에 저장하지 않아요.",
    cancel: "취소", connect: "연결",
  },
});

const description = (channel: Channel) => channel === "share" ? text().share : channel === "manual" ? text().manual : text().savedBy(channel);

/** When a registered agent last connected, or that its key was removed; nothing for share and manual. */
export function AgentUsage({ agent }: { readonly agent: AgentInfo | undefined }) {
  const t = text();
  if (!agent) return null;
  return <p className="channel-note">{agent.revokedAt !== null ? t.removed : `${t.lastUsed} ${agent.lastUsedAt ? relativeTime(agent.lastUsedAt) : t.none}`}</p>;
}

export function ChannelsView() {
  const t = text();
  const { records, importJson, logout } = useDashboard();
  const [registered, setRegistered] = useState<readonly AgentInfo[]>([]);
  // Usage is secondary to the cards, which already list every agent by name; a failure leaves them without it.
  useEffect(() => { listAgents().then(setRegistered, () => setRegistered([])); }, []);
  const [json, setJson] = useState("");
  const [error, setError] = useState("");
  const [importing, setImporting] = useState(false);
  const live = records.filter(record => isRecord(record) && record.archivedAt === null);
  const agents = channelKeys.filter(channel => channel !== "share" && channel !== "manual");

  const submitImport = async (event: SyntheticEvent<HTMLFormElement, SubmitEvent>) => {
    event.preventDefault();
    setError("");
    setImporting(true);
    try {
      await importJson(json);
    } catch (cause) {
      setError(cause instanceof SyntaxError ? t.badJson : await errorMessage(cause));
    } finally {
      setImporting(false);
    }
  };

  return <div className="channels-page">
    <header className="channels-heading">
      <BackButton place="list" />
      <div className="pane-title-row"><SidebarOpen /><h1>{viewTitles.channels}</h1></div>
    </header>
    {agents.length === 0 && <p className="channel-note">{t.noAgents} <code>bun run agents add &lt;name&gt;</code> {t.noAgentsAfter}</p>}
    <div className="channel-grid">
      {channelKeys.map(channel => {
        const items = live.filter(record => channelOf(record) === channel);
        const pending = items.filter(record => record.reviewState === "pending").length;
        const newest = items.reduce<string | null>(
          (latest, record) => latest === null || record.createdAt > latest ? record.createdAt : latest,
          null,
        );
        return <article className="channel-card" key={channel}>
          <header className="channel-card-head">
            <ChannelMark channel={channel} size="tile" />
            <h2>{channelLabel(channel)}</h2>
          </header>
          <p className="channel-description">{description(channel)}</p>
          <AgentUsage agent={registered.find(entry => entry.name === channel)} />
          <dl className="channel-stats">
            <div><dt>{t.total}</dt><dd>{items.length}</dd></div>
            <div><dt>{t.pending}</dt><dd>{pending}</dd></div>
            <div><dt>{t.latest}</dt><dd>{newest ? relativeTime(newest) : t.none}</dd></div>
          </dl>
          <div className="channel-links">
            <a href={formatRoute({ view: "library", id: null, params: { channel } })}>{t.view}<ArrowRight size={15} aria-hidden="true" /></a>
          </div>
        </article>;
      })}
    </div>

    <details className="channel-section import-section">
      <summary>{t.importSummary}</summary>
      <p className="channel-note">{t.importNote}</p>
      <form className="import-form" onSubmit={submitImport}>
        <label className="field">
          <span>{t.importField}</span>
          <textarea value={json} onChange={event => setJson(event.target.value)} rows={8} spellCheck={false} />
        </label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="channel-actions">
          <button type="submit" className="btn btn-primary" disabled={importing || json.trim() === ""}>{t.importButton}</button>
        </div>
      </form>
    </details>

    <section className="channel-section session-section" aria-labelledby="session-title">
      <div className="channel-section-head">
        <h2 id="session-title">{t.session}</h2>
        <p>{t.signedIn}</p>
      </div>
      <button type="button" className="btn btn-outline" onClick={() => { void logout(); }}>
        <LogOut size={16} aria-hidden="true" />{t.logout}
      </button>
      <p className="channel-note">{t.calendar(config.timeZone)}</p>
    </section>
  </div>;
}

/** Shown while signed out: the owner signs in with the owner key; with trusted login on, the proxy did not identify them. */
export function OwnerGate({ onToken }: { readonly onToken: () => void }) {
  const t = text();
  return <div className="gate">
    <img src="/brand-mark.png" alt="" width={56} height={56} />
    <h1>{config.appName}</h1>
    <p>{t.gateIntro}</p>
    {config.features.trustedLogin && <p>{t.proxyMissed}</p>}
    <button type="button" className="btn btn-primary" onClick={onToken}>
      <KeyRound size={16} aria-hidden="true" />{t.gateButton}
    </button>
  </div>;
}

export function LoginDialog({ onClose }: { readonly onClose: () => void }) {
  const t = text();
  const { login } = useDashboard();
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [connecting, setConnecting] = useState(false);

  const submit = async (event: SyntheticEvent<HTMLFormElement, SubmitEvent>) => {
    event.preventDefault();
    setError("");
    setConnecting(true);
    try {
      await login(token);
    } catch (cause) {
      setError(cause instanceof HTTPError && cause.response.status === 401 ? t.wrongKey : await errorMessage(cause));
    } finally {
      setConnecting(false);
    }
  };

  return <Dialog title={t.dialogTitle} onClose={onClose}>
    <form className="login-form" onSubmit={submit}>
      <label className="field">
        <span>{t.keyField}</span>
        <input type="password" autoComplete="off" value={token} onChange={event => setToken(event.target.value)} />
      </label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <p className="login-note">{t.keyNote}</p>
      <div className="dialog-actions">
        <button type="button" className="btn btn-quiet" onClick={onClose}>{t.cancel}</button>
        <button type="submit" className="btn btn-primary" disabled={connecting || token.trim() === ""}>{t.connect}</button>
      </div>
    </form>
  </Dialog>;
}

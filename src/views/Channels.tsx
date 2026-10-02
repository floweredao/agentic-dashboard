import { useState } from "react";
import type { SyntheticEvent } from "react";
import { HTTPError } from "ky";
import { ArrowRight, ExternalLink, LogOut, RefreshCw } from "lucide-react";
import { errorMessage } from "../api";
import { BackButton, ChannelMark, Dialog } from "../components/primitives";
import { channelKeys, channelOf, channelLabel, isRecord, relativeTime } from "../model";
import type { Channel } from "../model";
import { formatRoute } from "../router";
import { useDashboard } from "../state";

const descriptions: Record<Channel, string> = {
  chatgpt: "ChatGPT 대화에서 조사하고 저장한 기록",
  codex: "Codex가 작업을 마치고 남긴 기록",
  omo: "OmO가 작업을 마치고 남긴 기록",
  share: "iPhone 공유 버튼으로 저장한 링크",
  manual: "이 앱에서 직접 저장한 기록",
};

export function ChannelsView() {
  const { records, importJson, logout } = useDashboard();
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [importing, setImporting] = useState(false);
  const live = records.filter(record => isRecord(record) && record.archivedAt === null);

  const submitImport = async (event: SyntheticEvent<HTMLFormElement, SubmitEvent>) => {
    event.preventDefault();
    setError("");
    setImporting(true);
    try {
      await importJson(text);
    } catch (cause) {
      setError(cause instanceof SyntaxError ? "JSON 형식이 올바르지 않아요." : await errorMessage(cause));
    } finally {
      setImporting(false);
    }
  };

  return <div className="channels-page">
    <header className="channels-heading">
      <BackButton place="list" />
      <h1>채널 관리</h1>
    </header>
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
          <p className="channel-description">{descriptions[channel]}</p>
          <dl className="channel-stats">
            <div><dt>전체</dt><dd>{items.length}</dd></div>
            <div><dt>미확인</dt><dd>{pending}</dd></div>
            <div><dt>최근</dt><dd>{newest ? relativeTime(newest) : "없음"}</dd></div>
          </dl>
          <div className="channel-links">
            <a href={formatRoute({ view: "library", id: null, params: { channel } })}>기록 보기<ArrowRight size={15} aria-hidden="true" /></a>
          </div>
        </article>;
      })}
    </div>

    <details className="channel-section import-section">
      <summary>고급 · JSON으로 가져오기</summary>
      <p className="channel-note">에이전트가 만든 기록 JSON을 하나 붙여 넣으면 직접 작성한 기록으로 저장해요.</p>
      <form className="import-form" onSubmit={submitImport}>
        <label className="field">
          <span>기록 JSON</span>
          <textarea value={text} onChange={event => setText(event.target.value)} rows={8} spellCheck={false} />
        </label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="channel-actions">
          <button type="submit" className="btn btn-primary" disabled={importing || text.trim() === ""}>가져오기</button>
        </div>
      </form>
    </details>

    <section className="channel-section session-section" aria-labelledby="session-title">
      <div className="channel-section-head">
        <h2 id="session-title">세션</h2>
        <p>소유자로 연결됨</p>
      </div>
      <button type="button" className="btn btn-outline" onClick={() => { void logout(); }}>
        <LogOut size={16} aria-hidden="true" />로그아웃
      </button>
      <p className="channel-note">날짜는 서울 시간 기준이며, 한 주는 일요일에 시작해요.</p>
    </section>
  </div>;
}

export const tailscaleOrigin = "https://dashboard.example.test";

export function OwnerGate({ origin, hash, onToken }: {
  readonly origin: string; readonly hash: string; readonly onToken: () => void;
}) {
  const onTailscale = origin === tailscaleOrigin;
  return <div className="gate">
    <img src="/brand-mark.png" alt="" width={56} height={56} />
    <h1>Agentic Dashboard</h1>
    {onTailscale
      ? <>
        <p>Tailscale 계정을 확인하지 못했어요. 이 기기가 본인 계정으로 Tailscale에 연결돼 있는지 확인해 주세요.</p>
        <button type="button" className="btn btn-primary" onClick={() => location.reload()}>
          <RefreshCw size={16} aria-hidden="true" />다시 확인
        </button>
      </>
      : <>
        <p>Tailscale 주소에서 열면 로그인 없이 바로 연결돼요.</p>
        <a className="btn btn-primary" href={`${tailscaleOrigin}/${hash}`}>
          <ExternalLink size={16} aria-hidden="true" />Tailscale 주소로 열기
        </a>
      </>}
    <details className="gate-more">
      <summary>고급</summary>
      <button type="button" className="btn btn-quiet" onClick={onToken}>소유자 토큰으로 연결</button>
    </details>
  </div>;
}

export function LoginDialog({ onClose }: { readonly onClose: () => void }) {
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
      setError(cause instanceof HTTPError && cause.response.status === 401
        ? "토큰이 맞지 않아요. 복사한 소유자 토큰을 다시 확인해 주세요." : await errorMessage(cause));
    } finally {
      setConnecting(false);
    }
  };

  return <Dialog title="소유자 연결" onClose={onClose}>
    <form className="login-form" onSubmit={submit}>
      <label className="field">
        <span>소유자 토큰</span>
        <input type="password" autoComplete="off" value={token} onChange={event => setToken(event.target.value)} />
      </label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <p className="login-note">토큰은 이 브라우저에 저장하지 않아요. Tailscale 주소에서는 자동으로 연결돼요.</p>
      <div className="dialog-actions">
        <button type="button" className="btn btn-quiet" onClick={onClose}>취소</button>
        <button type="submit" className="btn btn-primary" disabled={connecting || token.trim() === ""}>연결</button>
      </div>
    </form>
  </Dialog>;
}

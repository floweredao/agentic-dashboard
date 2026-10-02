import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ChevronUp, FileText, Headphones, Pause, Play, RefreshCw, Trash2, X } from "lucide-react";
import type { DashboardRecord, NarrationState, NarrationStatus } from "../../shared/contracts";
import { NARRATION_LIMITS } from "../../shared/contracts";
import { cancelNarration, deleteNarration, errorCode, errorMessage, loadNarration, requestNarration } from "../api";
import type { NarrationCollection } from "../api";
import { useDashboard } from "../state";
import type { MenuItem } from "./Menu";
import { Dialog, Tag } from "./primitives";

const WORKING: ReadonlySet<NarrationStatus> = new Set(["queued", "scripting", "speaking"]);
const RATES = [1, 1.25, 1.5, 2, 0.8] as const;
const RATE_KEY = "agentic:listen-rate";
const positionKey = (recordId: string) => `agentic:listen:${recordId}`;
const POLL_MS = 3000;

const failureText: Readonly<Record<string, string>> = {
  no_key: "Gemini API 키가 설정되지 않았어요.",
  http_400: "Gemini가 요청을 거절했어요.",
  http_401: "Gemini가 API 키를 거절했어요.",
  http_403: "Gemini가 API 키를 거절했어요.",
  http_429: "Gemini 사용량 한도에 걸렸어요. 잠시 뒤 다시 시도해 주세요.",
  timeout: "시간이 너무 오래 걸렸어요.",
  network: "Gemini에 연결하지 못했어요.",
  record_missing: "기록이 삭제되어 만들지 못했어요.",
};
export function narrationFailure(code: string | null): string {
  if (code && failureText[code]) return failureText[code];
  if (code?.startsWith("http_5")) return "Gemini 서버에 문제가 있었어요. 잠시 뒤 다시 시도해 주세요.";
  return "음성을 만들지 못했어요.";
}
const requestText: Readonly<Record<string, string>> = {
  narration_unavailable: "Gemini API 키가 설정되지 않아 음성을 만들 수 없어요.",
  narration_daily_limit: "오늘 만들 수 있는 음성 수를 다 썼어요. 내일 다시 시도해 주세요.",
  narration_queue_full: "기다리는 음성이 많아요. 잠시 뒤 다시 시도해 주세요.",
  narration_attempts_exhausted: "이 내용으로 여러 번 실패했어요.",
  narration_busy: "음성을 만드는 중이라 지금은 삭제할 수 없어요.",
};

export function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const pad = (value: number) => String(value).padStart(2, "0");
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return hours ? `${hours}:${pad(minutes)}:${pad(total % 60)}` : `${minutes}:${pad(total % 60)}`;
}
const spoken = (seconds: number) => {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}분 ${total % 60}초`;
};
const minutesLabel = (ms: number) => ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}초` : `${Math.round(ms / 60_000)}분`;
const stored = (key: string) => typeof localStorage === "undefined" ? null : localStorage.getItem(key);

const working = (state: NarrationState | null) => state?.narration ? WORKING.has(state.narration.status) : false;
const failedFor = (state: NarrationState | null) => state?.narration?.status === "failed" && state.narration.error !== "cancelled";

/**
 * Folded: a round play button with `듣기 · 13분`. Playing unfolds it in place into one row: play/pause, seek, time, rate, fold.
 * Resumes where the owner stopped this audio (per record and file); the audio element stays mounted across folding.
 */
function Player({ recordId, title, src, durationMs, stale, prefix, open, playNonce, onOpen, onFold }: {
  readonly recordId: string; readonly title: string; readonly src: string; readonly durationMs: number; readonly stale: boolean;
  readonly prefix: string; readonly open: boolean; readonly playNonce: number; readonly onOpen: () => void; readonly onFold: () => void;
}) {
  const audio = useRef<HTMLAudioElement>(null);
  const playButton = useRef<HTMLButtonElement>(null);
  const openButton = useRef<HTMLButtonElement>(null);
  const moveFocus = useRef(false);
  const savedAt = useRef(0);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(durationMs / 1000);
  const [rate, setRate] = useState<number>(() => {
    const value = Number(stored(RATE_KEY));
    return RATES.some(item => item === value) ? value : 1;
  });
  useEffect(() => {
    if (audio.current) audio.current.playbackRate = rate;
    localStorage.setItem(RATE_KEY, String(rate));
  }, [rate]);
  useEffect(() => { if (playNonce > 0) void audio.current?.play(); }, [playNonce]);
  // The button pressed to unfold or fold disappears; focus moves to its counterpart.
  useEffect(() => {
    if (!moveFocus.current) return;
    moveFocus.current = false;
    (open ? playButton : openButton).current?.focus();
  }, [open]);
  const save = (seconds: number) => {
    savedAt.current = seconds;
    localStorage.setItem(positionKey(recordId), JSON.stringify({ src, t: Math.floor(seconds) }));
  };
  const restore = () => {
    const element = audio.current;
    if (!element) return;
    if (Number.isFinite(element.duration) && element.duration > 0) setDuration(element.duration);
    element.playbackRate = rate;
    const saved: unknown = JSON.parse(stored(positionKey(recordId)) ?? "null");
    if (saved && typeof saved === "object" && "src" in saved && "t" in saved && saved.src === src && typeof saved.t === "number"
      && saved.t > 0 && saved.t < element.duration - 3) {
      element.currentTime = saved.t;
      setTime(saved.t);
    }
  };
  const toggle = () => {
    const element = audio.current;
    if (!element) return;
    if (element.paused) void element.play();
    else element.pause();
  };
  const onPlay = () => {
    setPlaying(true);
    if ("mediaSession" in navigator) navigator.mediaSession.metadata = new MediaMetadata({ title, artist: "Agentic Dashboard" });
  };
  const nextRate = () => setRate(RATES[(RATES.findIndex(item => item === rate) + 1) % RATES.length] ?? 1);
  const max = Math.max(1, Math.round(duration));
  return <div className={open ? "listen-bar listen-player" : "listen-folded"}>
    {open ? <>
      <button ref={playButton} type="button" className="listen-play" onClick={toggle} aria-label={playing ? "일시정지" : "재생"}>
        {playing ? <Pause size={15} aria-hidden="true" /> : <Play size={15} aria-hidden="true" />}
      </button>
      <input type="range" className="listen-seek" min={0} max={max} step={1} value={Math.min(Math.floor(time), max)}
        aria-label={`${prefix}재생 위치`} aria-valuetext={`${spoken(time)} / ${spoken(duration)}`}
        onChange={event => {
          const value = Number(event.currentTarget.value);
          if (audio.current) audio.current.currentTime = value;
          setTime(value);
        }} />
      <span className="listen-time" aria-hidden="true">{clock(time)} / {clock(duration)}</span>
      <button type="button" className="btn btn-ghost listen-rate" onClick={nextRate} aria-label={`재생 속도 ${rate}배`}>{rate}×</button>
      <button type="button" className="icon-btn listen-icon" aria-label="플레이어 접기" onClick={() => { moveFocus.current = true; onFold(); }}>
        <ChevronUp size={16} aria-hidden="true" />
      </button>
    </> : <button ref={openButton} type="button" className="listen-open" onClick={() => { moveFocus.current = true; onOpen(); toggle(); }}>
      <span className="listen-play" aria-hidden="true">{playing ? <Pause size={15} /> : <Play size={15} />}</span>
      <span>{prefix}듣기 · {minutesLabel(durationMs)}</span>
      {stale && <Tag>예전 내용</Tag>}
    </button>}
    <audio ref={audio} src={src} preload="metadata" onLoadedMetadata={restore} onPlay={onPlay}
      onPause={event => { setPlaying(false); save(event.currentTarget.currentTime); }}
      onTimeUpdate={event => {
        const seconds = event.currentTarget.currentTime;
        setTime(seconds);
        if (Math.abs(seconds - savedAt.current) >= 5) save(seconds);
      }}
      onEnded={() => { setPlaying(false); localStorage.removeItem(positionKey(recordId)); savedAt.current = 0; }} />
  </div>;
}

const stageText = (state: NarrationState) => {
  const narration = state.narration;
  if (narration?.status === "scripting") return "원고를 다듬는 중";
  if (narration?.status === "speaking" && narration.progress) return `음성을 만드는 중 ${narration.progress.done}/${narration.progress.total}`;
  return "만들 차례를 기다리는 중";
};

/** The narration commands for a reader's 더보기 menu; `label` (메일, 뉴스) prefixes each when one screen holds several. */
export function narrationItems(state: NarrationState | null, { pending, cancelling, label, onRequest, onCancel, onListen, onScript, onRemove }: {
  readonly pending: boolean; readonly cancelling: boolean; readonly label?: string | undefined;
  readonly onRequest: (force: boolean) => void; readonly onCancel: () => void; readonly onListen: () => void;
  readonly onScript: () => void; readonly onRemove: () => void;
}): MenuItem[] {
  if (!state) return [];
  const prefix = label ? `${label} ` : "";
  const narration = state.narration;
  const blocked = pending || !state.available;
  const icon = (Icon: typeof Play) => <Icon size={16} aria-hidden="true" />;
  if (working(state)) return [{ label: `${prefix}음성 만들기 취소`, icon: icon(X), disabled: cancelling, onSelect: onCancel }];
  const items: MenuItem[] = [];
  if (failedFor(state)) {
    const exhausted = (narration?.attempts ?? 0) >= NARRATION_LIMITS.attempts;
    items.push({ label: `${prefix}다시 시도`, icon: icon(RefreshCw), disabled: blocked, onSelect: () => onRequest(exhausted) });
  }
  const audio = narration?.audio ?? null;
  if (!audio) {
    if (items.length === 0) items.push({ label: `${prefix}음성 만들기${state.available ? "" : " · 키 필요"}`, icon: icon(Headphones), disabled: blocked, onSelect: () => onRequest(false) });
    return items;
  }
  items.push({ label: `${prefix}듣기`, icon: icon(Play), onSelect: onListen });
  if (!failedFor(state)) items.push(narration?.stale
    ? { label: `${prefix}새로 만들기`, icon: icon(RefreshCw), disabled: blocked, onSelect: () => onRequest(false) }
    : { label: `${prefix}다시 만들기`, icon: icon(RefreshCw), disabled: blocked, onSelect: () => onRequest(true) });
  if (narration?.script) items.push({ label: `${prefix}원고 보기`, icon: icon(FileText), onSelect: onScript });
  items.push({ label: `${prefix}음성 삭제`, icon: icon(Trash2), danger: true, disabled: pending, onSelect: onRemove });
  return items;
}

/**
 * The narration line under a reader's action bar: a running job with its stage and a cancel x, a failure with 다시 시도,
 * or the (folded) player. Nothing when there is no audio and nothing running.
 */
export function NarrationBar({ record, state, label, pending, cancelling, dismissed, open, playNonce, onCancel, onRetry, onDismiss, onOpen, onFold }: {
  readonly record: Pick<DashboardRecord, "id" | "title">; readonly state: NarrationState; readonly label?: string | undefined;
  readonly pending: boolean; readonly cancelling: boolean; readonly dismissed: boolean; readonly open: boolean; readonly playNonce: number;
  readonly onCancel: () => void; readonly onRetry: (force: boolean) => void; readonly onDismiss: () => void;
  readonly onOpen: () => void; readonly onFold: () => void;
}): ReactNode {
  const narration = state.narration;
  const prefix = label ? `${label} ` : "";
  if (narration && working(state)) {
    const determinate = narration.status === "speaking" && narration.progress;
    return <div className="listen-bar listen-working" role="status">
      <Headphones size={15} aria-hidden="true" />
      <span className="listen-stage">{prefix}{cancelling ? "취소하는 중" : stageText(state)}</span>
      {!cancelling && (determinate
        ? <progress aria-label="음성 만드는 진행" max={narration.progress?.total} value={narration.progress?.done} />
        : <progress aria-label="음성 만드는 진행" />)}
      <button type="button" className="icon-btn listen-icon" aria-label={`${prefix}음성 만들기 취소`} disabled={cancelling} onClick={onCancel}>
        <X size={16} aria-hidden="true" />
      </button>
    </div>;
  }
  if (narration && failedFor(state) && !dismissed) {
    const exhausted = narration.attempts >= NARRATION_LIMITS.attempts;
    return <div className="listen-bar listen-error" role="alert">
      <span className="listen-stage">{prefix}{narrationFailure(narration.error)}</span>
      <button type="button" className="btn btn-ghost" disabled={pending || !state.available} onClick={() => onRetry(exhausted)}>다시 시도</button>
      <button type="button" className="icon-btn listen-icon" aria-label="알림 닫기" onClick={onDismiss}><X size={16} aria-hidden="true" /></button>
    </div>;
  }
  const audio = narration?.audio;
  if (!audio) return null;
  return <Player key={audio.url} recordId={record.id} title={record.title} src={audio.url} durationMs={audio.durationMs} stale={narration?.stale ?? false}
    prefix={prefix} open={open} playNonce={playNonce} onOpen={onOpen} onFold={onFold} />;
}

/**
 * Loads the narration of a record (or a digest part), follows a running job every few seconds and runs the owner's commands.
 * `record: null` turns it off (tasks, projects, a digest not yet loaded). Returns the menu items and the bar to show.
 */
export function useNarration({ record, collection = "records", label }: {
  readonly record: Pick<DashboardRecord, "id" | "title" | "version"> | null; readonly collection?: NarrationCollection; readonly label?: string | undefined;
}): { items: MenuItem[]; bar: ReactNode } {
  const d = useDashboard();
  const id = record?.id ?? null;
  const [loaded, setLoaded] = useState<{ id: string; state: NarrationState } | null>(null);
  const [pending, setPending] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [playNonce, setPlayNonce] = useState(0);
  const [script, setScript] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { setOpen(false); setPlayNonce(0); setScript(false); setDismissed(null); }, [id]);
  const state = id && loaded?.id === id ? loaded.state : null;
  const put = (forId: string, next: NarrationState) => { if (alive.current) setLoaded({ id: forId, state: next }); };
  const show = async (error: unknown) => {
    const code = await errorCode(error);
    d.notify(code && requestText[code] ? requestText[code] : await errorMessage(error), "error");
  };
  const load = (forId: string) => loadNarration(forId, collection).then(next => put(forId, next), show);
  // A content edit changes the version, and with it whether the audio is stale.
  useEffect(() => { if (id) void load(id); }, [id, record?.version]);
  useEffect(() => {
    if (!id || !working(state)) return;
    const timer = window.setTimeout(() => { void load(id); }, POLL_MS);
    return () => window.clearTimeout(timer);
  }, [state]);
  if (!record || !state) return { items: [], bar: null };
  const forId = record.id;
  const request = async (force: boolean) => {
    if (force && !window.confirm("음성을 다시 만들면 Gemini 요금이 한 번 더 들어요. 다시 만들까요?")) return;
    setPending(true);
    try { put(forId, await requestNarration(forId, force, d.csrfToken, collection)); }
    catch (error) { await show(error); }
    finally { if (alive.current) setPending(false); }
  };
  const cancel = async () => {
    setCancelling(true);
    try {
      const next = await cancelNarration(forId, d.csrfToken, collection);
      put(forId, next);
      if (!working(next)) d.notify("음성 만들기를 취소했어요.");
    } catch (error) { await show(error); }
    finally { if (alive.current) setCancelling(false); }
  };
  const remove = async () => {
    if (!window.confirm("음성 파일과 원고를 삭제할까요? 다시 들으려면 새로 만들어야 해요.")) return;
    setPending(true);
    try {
      await deleteNarration(forId, d.csrfToken, collection);
      localStorage.removeItem(positionKey(forId));
      put(forId, { narration: null, available: state.available });
      setOpen(false);
      d.notify("음성을 삭제했어요.");
    } catch (error) { await show(error); }
    finally { if (alive.current) setPending(false); }
  };
  const items = narrationItems(state, {
    pending, cancelling, label,
    onRequest: force => { void request(force); },
    onCancel: () => { void cancel(); },
    onListen: () => { setDismissed(state.narration?.updatedAt ?? null); setOpen(true); setPlayNonce(nonce => nonce + 1); },
    onScript: () => setScript(true),
    onRemove: () => { void remove(); },
  });
  const paragraphs = state.narration?.script?.split(/\n{2,}/) ?? [];
  const bar = <>
    <NarrationBar record={record} state={state} label={label} pending={pending} cancelling={cancelling}
      dismissed={dismissed !== null && dismissed === state.narration?.updatedAt} open={open} playNonce={playNonce}
      onCancel={() => { void cancel(); }} onRetry={force => { void request(force); }}
      onDismiss={() => setDismissed(state.narration?.updatedAt ?? null)} onOpen={() => setOpen(true)} onFold={() => setOpen(false)} />
    {script && paragraphs.length > 0 && <Dialog title={`${label ? `${label} ` : ""}원고`} onClose={() => setScript(false)}>
      <div className="listen-script">{paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div>
    </Dialog>}
  </>;
  return { items, bar };
}

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ChevronUp, FileText, Headphones, Pause, Play, RefreshCw, Trash2, X } from "lucide-react";
import type { DashboardRecord, Narration, NarrationState, NarrationStatus, NarrationStyle } from "../../shared/contracts";
import { NARRATION_LIMITS } from "../../shared/contracts";
import { cancelNarration, deleteNarration, errorCode, errorMessage, loadNarration, requestNarration } from "../api";
import type { NarrationCollection } from "../api";
import { config } from "../config";
import { strings } from "../i18n";
import { useDashboard } from "../state";
import type { MenuItem } from "./Menu";
import { narrationStage } from "./narration-progress";
import { clock, forgetPosition, nextRate, rememberPosition, savedPosition, usePlayback } from "./playback";
import { Dialog, Tag } from "./primitives";

export { clock, initialRate } from "./playback";

const WORKING: ReadonlySet<NarrationStatus> = new Set(["queued", "scripting", "speaking"]);
/** The failure (its updatedAt) the owner closed with x for this record or digest part, on this device. */
const dismissKey = (recordId: string) => `agentic:listen-dismissed:${recordId}`;
const POLL_MS = 3000;
/** How long a finished job's bar stays at 100% before the player replaces it. */
const FINISH_HOLD_MS = 900;
/** The bar's catch-up time constant: a jump to a new stage eases out over roughly three of these. */
const EASE_MS = 220;

type Failures = Readonly<Record<string, string>>;
/** A narration command; `make` marks Make audio, which a screen with several narrations (a digest under All) folds into one choice. */
export type NarrationMenuItem = MenuItem & { readonly make?: boolean };
type Text = { readonly failures: Failures; readonly requests: Failures; readonly [key: string]: unknown };
const text = strings({
  en: {
    failures: {
      no_key: "No Gemini API key is set.",
      http_400: "Gemini rejected the request.",
      http_401: "Gemini rejected the API key.",
      http_403: "Gemini rejected the API key.",
      http_402: "Gemini's prepaid credits ran out, so the audio couldn't be made.",
      http_429: "Gemini's per-minute limit was reached. Please try again in about a minute.",
      quota_daily: "Today's free Gemini quota is used up. Please try again tomorrow.",
      vertex_auth: "The Vertex AI login has expired or is missing. Run gcloud auth application-default login on the server again.",
      vertex_disabled: "Billing or the Vertex AI API is off for the Google Cloud project. Check them in the Google Cloud console.",
      vertex_quota: "The Vertex AI usage limit was reached. Please try again in a few minutes.",
      timeout: "It took too long.",
      network: "Couldn't connect to Gemini.",
      record_missing: "The record was deleted, so the audio couldn't be made.",
    },
    serverError: "Gemini's servers were busy and several retries didn't get through. Please try again in a moment.",
    failed: "Couldn't make the audio.",
    requests: {
      narration_unavailable: "No Gemini API key is set, so audio can't be made.",
      narration_daily_limit: "You've used today's audio limit. Try again tomorrow.",
      narration_queue_full: "Many audio jobs are waiting. Please try again in a moment.",
      narration_attempts_exhausted: "This content has failed several times.",
      narration_busy: "Audio is being made, so it can't be deleted right now.",
      narration_style_unsupported: "Digests can only be read aloud.",
    },
    spoken: (minutes: number, seconds: number) => `${minutes} min ${seconds} sec`,
    seconds: (value: number) => `${value} sec`, minutes: (value: number) => `${value} min`,
    pause: "Pause", play: "Play", position: "Playback position", speed: (rate: number) => `Playback speed ${rate}x`,
    fold: "Collapse player", listen: "Listen", outdated: "Outdated",
    cancelMake: "Cancel audio", retry: "Try again", make: "Make audio", keyNeeded: " · key needed",
    makeNew: "Make new", makeAgain: "Make again", viewScript: "View script", deleteAudio: "Delete audio",
    cancelling: "Cancelling", progress: "Audio progress", dismiss: "Dismiss", remakeFailed: "Couldn't make new audio",
    confirmRemake: "Making the audio again costs another Gemini charge. Make it again?",
    confirmDelete: "Delete the audio file and script? You'll need to make it again to listen.",
    cancelled: "Audio cancelled.", deleted: "Audio deleted.", script: "Script",
    read: "Read aloud", readHint: "One voice reads the record clearly.",
    podcast: "Podcast", podcastHint: "Two hosts talk it through like a conversation.",
    styleLegend: "Audio style", remakeCost: "Making it again costs another Gemini charge.",
    cancel: "Cancel", create: "Make", makeTitle: "Make audio", remakeTitle: "Make audio again",
  },
  ko: {
    failures: {
      no_key: "Gemini API 키가 설정되지 않았어요.",
      http_400: "Gemini가 요청을 거절했어요.",
      http_401: "Gemini가 API 키를 거절했어요.",
      http_403: "Gemini가 API 키를 거절했어요.",
      http_402: "Gemini 선불 크레딧이 바닥나 만들지 못했어요.",
      http_429: "Gemini 분당 사용 한도에 걸렸어요. 1분쯤 뒤 다시 시도해 주세요.",
      quota_daily: "오늘 Gemini 무료 한도를 다 썼어요. 내일 다시 시도해 주세요.",
      vertex_auth: "Vertex AI 로그인이 끝났거나 없어요. 서버에서 gcloud auth application-default login을 다시 해 주세요.",
      vertex_disabled: "Google Cloud 프로젝트의 결제나 Vertex AI API가 꺼져 있어요. Google Cloud 콘솔에서 확인해 주세요.",
      vertex_quota: "Vertex AI 사용 한도에 걸렸어요. 몇 분 뒤 다시 시도해 주세요.",
      timeout: "시간이 너무 오래 걸렸어요.",
      network: "Gemini에 연결하지 못했어요.",
      record_missing: "기록이 삭제되어 만들지 못했어요.",
    },
    serverError: "Gemini 서버가 붐비어 여러 번 다시 해 봤지만 만들지 못했어요. 잠시 뒤 다시 시도해 주세요.",
    failed: "음성을 만들지 못했어요.",
    requests: {
      narration_unavailable: "Gemini API 키가 설정되지 않아 음성을 만들 수 없어요.",
      narration_daily_limit: "오늘 만들 수 있는 음성 수를 다 썼어요. 내일 다시 시도해 주세요.",
      narration_queue_full: "기다리는 음성이 많아요. 잠시 뒤 다시 시도해 주세요.",
      narration_attempts_exhausted: "이 내용으로 여러 번 실패했어요.",
      narration_busy: "음성을 만드는 중이라 지금은 삭제할 수 없어요.",
      narration_style_unsupported: "다이제스트는 낭독으로만 만들 수 있어요.",
    },
    spoken: (minutes: number, seconds: number) => `${minutes}분 ${seconds}초`,
    seconds: (value: number) => `${value}초`, minutes: (value: number) => `${value}분`,
    pause: "일시정지", play: "재생", position: "재생 위치", speed: (rate: number) => `재생 속도 ${rate}배`,
    fold: "플레이어 접기", listen: "듣기", outdated: "예전 내용",
    cancelMake: "음성 만들기 취소", retry: "다시 시도", make: "음성 만들기", keyNeeded: " · 키 필요",
    makeNew: "새로 만들기", makeAgain: "다시 만들기", viewScript: "원고 보기", deleteAudio: "음성 삭제",
    cancelling: "취소하고 있어요", progress: "음성 만드는 진행", dismiss: "알림 닫기", remakeFailed: "새 음성을 만들지 못했어요",
    confirmRemake: "음성을 다시 만들면 Gemini 요금이 한 번 더 들어요. 다시 만들까요?",
    confirmDelete: "음성 파일과 원고를 삭제할까요? 다시 들으려면 새로 만들어야 해요.",
    cancelled: "음성 만들기를 취소했어요.", deleted: "음성을 삭제했어요.", script: "원고",
    read: "낭독", readHint: "한 목소리가 기록을 또렷하게 읽어 줘요.",
    podcast: "팟캐스트", podcastHint: "두 진행자가 대화하듯 풀어 설명해 줘요.",
    styleLegend: "음성 스타일", remakeCost: "다시 만들면 Gemini 요금이 한 번 더 들어요.",
    cancel: "취소", create: "만들기", makeTitle: "음성 만들기", remakeTitle: "음성 다시 만들기",
  },
} satisfies { readonly en: Text; readonly ko: Text });

export function narrationFailure(code: string | null): string {
  const failures: Failures = text().failures;
  const known = code ? failures[code] : undefined;
  if (known) return known;
  if (code?.startsWith("http_5")) return text().serverError;
  return text().failed;
}

const spoken = (seconds: number) => {
  const total = Math.max(0, Math.floor(seconds));
  return text().spoken(Math.floor(total / 60), total % 60);
};
const minutesLabel = (ms: number) => ms < 60_000 ? text().seconds(Math.max(1, Math.round(ms / 1000))) : text().minutes(Math.round(ms / 60_000));
const stored = (key: string) => typeof localStorage === "undefined" ? null : localStorage.getItem(key);

type Failure = Pick<NonNullable<NarrationState["narration"]>, "updatedAt" | "error" | "audio">;
/** A failure is the same one while its reason and the audio it left are: a retry that fails again the same way is not new. */
const failureKey = (failure: Failure) => `${failure.error ?? ""}|${failure.audio?.url ?? ""}`;

/**
 * Whether the owner already closed this failure here. It stays closed on every visit, and when a retry fails again for the
 * same reason on the same audio; another reason or new audio shows again. A value saved as the failure's time still counts.
 */
export function failureDismissed(recordId: string, failure: Failure | null | undefined, read: (key: string) => string | null = stored): boolean {
  if (!failure) return false;
  const saved = read(dismissKey(recordId));
  return saved !== null && (saved === failureKey(failure) || saved === failure.updatedAt);
}
export function rememberDismissed(recordId: string, failure: Failure, write: (key: string, value: string) => void = (key, value) => localStorage.setItem(key, value)) {
  write(dismissKey(recordId), failureKey(failure));
}

const working = (state: NarrationState | null) => state?.narration ? WORKING.has(state.narration.status) : false;
const failedFor = (state: NarrationState | null) => state?.narration?.status === "failed" && state.narration.error !== "cancelled";

/**
 * Folded: a round play button with `Listen · 13 min`. Playing unfolds it in place into one row: play/pause, seek, time, rate, fold.
 * It shows and drives the app's one playback (see playback.tsx), so leaving the screen keeps it playing in the mini player and
 * coming back shows it here again. Resumes where the owner stopped this audio (per record and file).
 */
function Player({ recordId, title, src, durationMs, stale, podcast, prefix, open, playNonce, pending, onOpen, onFold, onRemove }: {
  readonly recordId: string; readonly title: string; readonly src: string; readonly durationMs: number; readonly stale: boolean; readonly podcast: boolean;
  readonly prefix: string; readonly open: boolean; readonly playNonce: number; readonly pending: boolean;
  readonly onOpen: () => void; readonly onFold: () => void; readonly onRemove: () => void;
}) {
  // 음성 삭제 beside the player in both states (the same command as the menu's, with its confirmation).
  const remove = <button type="button" className="icon-btn listen-icon listen-remove" aria-label={`${prefix}${text().deleteAudio}`} title={text().deleteAudio}
    disabled={pending} onClick={onRemove}><Trash2 size={15} aria-hidden="true" /></button>;
  const { store, snapshot } = usePlayback();
  const playButton = useRef<HTMLButtonElement>(null);
  const openButton = useRef<HTMLButtonElement>(null);
  const moveFocus = useRef(false);
  /** The position shown while another audio (or none) is loaded: where this one was left. */
  const [idle, setIdle] = useState(() => savedPosition(recordId, src, stored));
  const active = snapshot.track?.src === src;
  const playing = active && snapshot.playing;
  const time = active ? snapshot.time : idle;
  const duration = active && snapshot.duration > 0 ? snapshot.duration : durationMs / 1000;
  const rate = snapshot.rate;
  useEffect(() => store.mount(src), [store, src]);
  useEffect(() => { if (!active) setIdle(savedPosition(recordId, src, stored)); }, [active, recordId, src]);
  const start = () => store.start({ src, recordId, title, durationMs, back: location.hash }, { play: true });
  useEffect(() => { if (playNonce > 0) start(); }, [playNonce]);
  // The button pressed to unfold or fold disappears; focus moves to its counterpart.
  useEffect(() => {
    if (!moveFocus.current) return;
    moveFocus.current = false;
    (open ? playButton : openButton).current?.focus();
  }, [open]);
  const toggle = () => { if (active) store.toggle(); else start(); };
  const max = Math.max(1, Math.round(duration));
  return <div className={open ? "listen-bar listen-player" : "listen-folded"}>
    {open ? <>
      <button ref={playButton} type="button" className="listen-play" onClick={toggle} aria-label={playing ? text().pause : text().play}>
        {playing ? <Pause size={15} aria-hidden="true" /> : <Play size={15} aria-hidden="true" />}
      </button>
      <input type="range" className="listen-seek" min={0} max={max} step={1} value={Math.min(Math.floor(time), max)}
        aria-label={`${prefix}${text().position}`} aria-valuetext={`${spoken(time)} / ${spoken(duration)}`}
        onChange={event => {
          const value = Number(event.currentTarget.value);
          if (active) { store.seek(value); return; }
          rememberPosition(recordId, src, value);
          setIdle(value);
        }} />
      <span className="listen-time" aria-hidden="true">{clock(time)} / {clock(duration)}</span>
      <button type="button" className="btn btn-ghost listen-rate" onClick={() => store.setRate(nextRate(rate))} aria-label={text().speed(rate)}>{rate}×</button>
      {remove}
      <button type="button" className="icon-btn listen-icon" aria-label={text().fold} onClick={() => { moveFocus.current = true; onFold(); }}>
        <ChevronUp size={16} aria-hidden="true" />
      </button>
    </> : <button ref={openButton} type="button" className="listen-open" onClick={() => { moveFocus.current = true; onOpen(); toggle(); }}>
      <span className="listen-play" aria-hidden="true">{playing ? <Pause size={15} /> : <Play size={15} />}</span>
      <span>{prefix}{text().listen} · {minutesLabel(durationMs)}</span>
      {podcast && <Tag>{text().podcast}</Tag>}
      {stale && <Tag>{text().outdated}</Tag>}
    </button>}
    {!open && remove}
  </div>;
}

/**
 * The job's stage and a percent bar showing only what the server reported (see narration-progress). Within one job the value
 * never moves back (a script written again counts from zero), a newly reported value slides in over 300 ms (CSS `.listen-fill`,
 * none with reduced motion), and a once-a-second tick only renews the elapsed time in the label.
 */
function NarrationProgress({ narration, prefix, lead }: { readonly narration: Narration; readonly prefix: string; readonly lead: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const { label, value } = narrationStage(narration, now);
  const shown = useRef({ job: narration.requestedAt, value });
  if (shown.current.job !== narration.requestedAt) shown.current = { job: narration.requestedAt, value };
  shown.current.value = Math.max(shown.current.value, value);
  const percent = Math.floor(shown.current.value);
  return <>
    <span className="listen-stage">{lead}{label}</span>
    <span className="listen-track" role="progressbar" aria-label={`${prefix}${text().progress}`} aria-valuemin={0} aria-valuemax={100}
      aria-valuenow={percent} aria-valuetext={`${label} ${percent}%`}>
      <span className="listen-fill" style={{ transform: `scaleX(${shown.current.value / 100})` }} />
    </span>
    <span className="listen-percent" aria-hidden="true">{percent}%</span>
  </>;
}

/**
 * The narration commands for a reader's More menu; `label` (e.g. Mail, News) prefixes each when one screen holds several.
 * Make audio, Make again and Make new go through `onMake` (where a record's style is chosen); Try again repeats the failed job with `onRequest`.
 */
export function narrationItems(state: NarrationState | null, { pending, cancelling, label, onRequest, onMake, onCancel, onListen, onScript, onRemove }: {
  readonly pending: boolean; readonly cancelling: boolean; readonly label?: string | undefined;
  readonly onRequest: (force: boolean) => void; readonly onMake: (force: boolean) => void; readonly onCancel: () => void; readonly onListen: () => void;
  readonly onScript: () => void; readonly onRemove: () => void;
}): NarrationMenuItem[] {
  if (!state) return [];
  const prefix = label ? `${label} ` : "";
  const narration = state.narration;
  const blocked = pending || !state.available;
  const icon = (Icon: typeof Play) => <Icon size={16} aria-hidden="true" />;
  if (working(state)) return [{ label: `${prefix}${text().cancelMake}`, icon: icon(X), disabled: cancelling, onSelect: onCancel }];
  const items: NarrationMenuItem[] = [];
  if (failedFor(state)) {
    const exhausted = (narration?.attempts ?? 0) >= NARRATION_LIMITS.attempts;
    items.push({ label: `${prefix}${text().retry}`, icon: icon(RefreshCw), disabled: blocked, onSelect: () => onRequest(exhausted) });
  }
  const audio = narration?.audio ?? null;
  if (!audio) {
    if (items.length === 0) items.push({ label: `${prefix}${text().make}${state.available ? "" : text().keyNeeded}`, icon: icon(Headphones), disabled: blocked, make: true, onSelect: () => onMake(false) });
    return items;
  }
  items.push({ label: `${prefix}${text().listen}`, icon: icon(Play), onSelect: onListen });
  if (!failedFor(state)) items.push(narration?.stale
    ? { label: `${prefix}${text().makeNew}`, icon: icon(RefreshCw), disabled: blocked, onSelect: () => onMake(false) }
    : { label: `${prefix}${text().makeAgain}`, icon: icon(RefreshCw), disabled: blocked, onSelect: () => onMake(true) });
  if (narration?.script) items.push({ label: `${prefix}${text().viewScript}`, icon: icon(FileText), onSelect: onScript });
  items.push({ label: `${prefix}${text().deleteAudio}`, icon: icon(Trash2), danger: true, disabled: pending, onSelect: onRemove });
  return items;
}

/**
 * The narration line under a reader's action bar: a running job with its stage and a cancel x, a failure with a retry button,
 * or the (folded) player. Nothing when there is no audio and nothing running.
 */
export function NarrationBar({ record, state, label, pending, cancelling, dismissed, open, finishing, playNonce, onCancel, onRetry, onDismiss, onOpen, onFold, onRemove }: {
  readonly record: Pick<DashboardRecord, "id" | "title">; readonly state: NarrationState; readonly label?: string | undefined;
  readonly pending: boolean; readonly cancelling: boolean; readonly dismissed: boolean; readonly open: boolean;
  /** The job has just become ready: the bar finishes at 100% before the player takes its place. */
  readonly finishing: boolean; readonly playNonce: number;
  readonly onCancel: () => void; readonly onRetry: (force: boolean) => void; readonly onDismiss: () => void;
  readonly onOpen: () => void; readonly onFold: () => void; readonly onRemove: () => void;
}): ReactNode {
  const narration = state.narration;
  const prefix = label ? `${label} ` : "";
  // The row's sentence is set off from the part's name (뉴스 · …), so the two never read as one clause.
  const lead = label ? `${label} · ` : "";
  const done = finishing && narration?.status === "ready";
  if (narration && (working(state) || done)) {
    return <div className="listen-bar listen-working" role="status">
      <Headphones size={15} aria-hidden="true" />
      {cancelling ? <span className="listen-stage">{lead}{text().cancelling}</span> : <NarrationProgress narration={narration} prefix={prefix} lead={lead} />}
      {!done && <button type="button" className="icon-btn listen-icon" aria-label={`${prefix}${text().cancelMake}`} disabled={cancelling} onClick={onCancel}>
        <X size={16} aria-hidden="true" />
      </button>}
    </div>;
  }
  const exhausted = (narration?.attempts ?? 0) >= NARRATION_LIMITS.attempts;
  const audio = narration?.audio;
  // Without audio the failure is the bar; with audio made earlier, the player stays and the failed remake is a small note.
  if (narration && failedFor(state) && !dismissed && !audio) {
    return <div className="listen-bar listen-error" role="alert">
      <span className="listen-stage">{lead}{narrationFailure(narration.error)}</span>
      <button type="button" className="btn btn-ghost" disabled={pending || !state.available} onClick={() => onRetry(exhausted)}>{text().retry}</button>
      <button type="button" className="icon-btn listen-icon" aria-label={text().dismiss} onClick={onDismiss}><X size={16} aria-hidden="true" /></button>
    </div>;
  }
  if (!audio) return null;
  const note = narration && failedFor(state) && !dismissed ? <div className="listen-note" role="status">
    <span className="listen-stage">{lead}{text().remakeFailed} · {narrationFailure(narration.error)}</span>
    <button type="button" className="btn btn-ghost" disabled={pending || !state.available} onClick={() => onRetry(exhausted)}>{text().retry}</button>
    <button type="button" className="icon-btn listen-icon" aria-label={text().dismiss} onClick={onDismiss}><X size={16} aria-hidden="true" /></button>
  </div> : null;
  // The player keeps its place in the tree, so closing the note does not restart what is playing.
  return <>
    <Player key={audio.url} recordId={record.id} title={record.title} src={audio.url} durationMs={audio.durationMs} stale={narration?.stale ?? false}
      podcast={audio.style === "podcast"} prefix={prefix} open={open} playNonce={playNonce} pending={pending} onOpen={onOpen} onFold={onFold} onRemove={onRemove} />
    {note}
  </>;
}

/** The choice behind a record's Make audio: read aloud or podcast, the style last used checked; a remake states that it costs again. */
export function StyleChoice({ initial, force, pending, onSubmit, onClose }: {
  readonly initial: NarrationStyle; readonly force: boolean; readonly pending: boolean;
  readonly onSubmit: (style: NarrationStyle) => void; readonly onClose: () => void;
}) {
  const [style, setStyle] = useState<NarrationStyle>(initial);
  const styles: readonly { readonly value: NarrationStyle; readonly label: string; readonly hint: string }[] = [
    { value: "read", label: text().read, hint: text().readHint },
    { value: "podcast", label: text().podcast, hint: text().podcastHint },
  ];
  return <form onSubmit={event => { event.preventDefault(); onSubmit(style); }}>
    <fieldset className="listen-styles" disabled={pending}>
      <legend className="visually-hidden">{text().styleLegend}</legend>
      {styles.map(option => <label key={option.value} className="listen-style">
        <input type="radio" name="narration-style" value={option.value} checked={style === option.value}
          onChange={() => setStyle(option.value)} />
        <span className="listen-style-text"><strong>{option.label}</strong><span>{option.hint}</span></span>
      </label>)}
    </fieldset>
    {force && <p className="form-note">{text().remakeCost}</p>}
    <div className="dialog-actions">
      <button type="button" className="btn btn-outline" onClick={onClose}>{text().cancel}</button>
      <button type="submit" className="btn btn-primary" disabled={pending}>{text().create}</button>
    </div>
  </form>;
}

/**
 * Loads the narration of a record (or a digest part), follows a running job every few seconds and runs the owner's commands.
 * `record: null` turns it off (tasks, projects, a digest not yet loaded). Returns the menu items, the bar to show, the loaded
 * state, and `renew`, which makes the audio again from the current content (as Make new does).
 */
export function useNarration({ record, collection = "records", label }: {
  readonly record: Pick<DashboardRecord, "id" | "title" | "version"> | null; readonly collection?: NarrationCollection; readonly label?: string | undefined;
}): { items: NarrationMenuItem[]; bar: ReactNode; state: NarrationState | null; renew: () => void } {
  const d = useDashboard();
  const { store: playback } = usePlayback();
  const id = record?.id ?? null;
  const [loaded, setLoaded] = useState<{ id: string; state: NarrationState } | null>(null);
  const [pending, setPending] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [playNonce, setPlayNonce] = useState(0);
  const [script, setScript] = useState(false);
  const [choosing, setChoosing] = useState<{ force: boolean } | null>(null);
  const [finishing, setFinishing] = useState(false);
  const alive = useRef(true);
  const wasWorking = useRef(false);
  const finishTimer = useRef(0);
  useEffect(() => { alive.current = true; return () => { alive.current = false; window.clearTimeout(finishTimer.current); }; }, []);
  useEffect(() => {
    setOpen(false); setPlayNonce(0); setScript(false); setDismissed(null); setChoosing(null); setFinishing(false);
    wasWorking.current = false;
  }, [id]);
  const state = id && loaded?.id === id ? loaded.state : null;
  const audioUrl = state?.narration?.audio?.url ?? null;
  // Back on the record that kept playing elsewhere, its player opens unfolded on that playback.
  useEffect(() => { if (audioUrl && playback.snapshot().track?.src === audioUrl) setOpen(true); }, [id, audioUrl, playback]);
  useEffect(() => {
    const now = working(state);
    if (wasWorking.current && !now && state?.narration?.status === "ready") {
      setFinishing(true);
      window.clearTimeout(finishTimer.current);
      finishTimer.current = window.setTimeout(() => { if (alive.current) setFinishing(false); }, FINISH_HOLD_MS);
    }
    wasWorking.current = now;
  }, [state]);
  const put = (forId: string, next: NarrationState) => { if (alive.current) setLoaded({ id: forId, state: next }); };
  const show = async (error: unknown) => {
    const code = await errorCode(error);
    const requests: Failures = text().requests;
    const known = code ? requests[code] : undefined;
    d.notify(known ?? await errorMessage(error), "error");
  };
  const load = (forId: string) => loadNarration(forId, collection).then(next => put(forId, next), show);
  // A content edit changes the version, and with it whether the audio is stale.
  useEffect(() => { if (id) void load(id); }, [id, record?.version]);
  useEffect(() => {
    if (!id || !working(state)) return;
    const timer = window.setTimeout(() => { void load(id); }, POLL_MS);
    return () => window.clearTimeout(timer);
  }, [state]);
  if (!record || !state) return { items: [], bar: null, state: null, renew: () => undefined };
  const forId = record.id;
  /** `style` comes from the choice, which already said what a remake costs; digests have no choice and confirm here. */
  const request = async (force: boolean, style?: NarrationStyle) => {
    if (force && !style && !window.confirm(text().confirmRemake)) return;
    setPending(true);
    try { put(forId, await requestNarration(forId, force, d.csrfToken, collection, style)); }
    catch (error) { await show(error); }
    finally { if (alive.current) setPending(false); }
  };
  const cancel = async () => {
    setCancelling(true);
    try {
      const next = await cancelNarration(forId, d.csrfToken, collection);
      put(forId, next);
      if (!working(next)) d.notify(text().cancelled);
    } catch (error) { await show(error); }
    finally { if (alive.current) setCancelling(false); }
  };
  const remove = async () => {
    if (!window.confirm(text().confirmDelete)) return;
    setPending(true);
    try {
      await deleteNarration(forId, d.csrfToken, collection);
      if (audioUrl) playback.stop(audioUrl);
      forgetPosition(forId);
      put(forId, { narration: null, available: state.available });
      setOpen(false);
      d.notify(text().deleted);
    } catch (error) { await show(error); }
    finally { if (alive.current) setPending(false); }
  };
  const items = narrationItems(state, {
    pending, cancelling, label,
    onRequest: force => { void request(force); },
    // Digests are always read aloud; a record asks for its style first.
    onMake: force => { if (collection === "digests") void request(force); else setChoosing({ force }); },
    onCancel: () => { void cancel(); },
    onListen: () => { setDismissed(state.narration?.updatedAt ?? null); setOpen(true); setPlayNonce(nonce => nonce + 1); },
    onScript: () => setScript(true),
    onRemove: () => { void remove(); },
  });
  const paragraphs = state.narration?.script?.split(/\n{2,}/) ?? [];
  const bar = <>
    <NarrationBar record={record} state={state} label={label} pending={pending} cancelling={cancelling}
      dismissed={(dismissed !== null && dismissed === state.narration?.updatedAt) || failureDismissed(forId, state.narration)} open={open} finishing={finishing} playNonce={playNonce}
      onCancel={() => { void cancel(); }} onRetry={force => { void request(force); }}
      onDismiss={() => {
        const updatedAt = state.narration?.updatedAt ?? null;
        if (state.narration) rememberDismissed(forId, state.narration);
        setDismissed(updatedAt);
      }} onOpen={() => setOpen(true)} onFold={() => setOpen(false)} onRemove={() => { void remove(); }} />
    {script && paragraphs.length > 0 && <Dialog title={`${label ? `${label} ` : ""}${text().script}`} onClose={() => setScript(false)}>
      <div className="listen-script">{paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div>
    </Dialog>}
    {choosing && <Dialog title={choosing.force ? text().remakeTitle : text().makeTitle} onClose={() => setChoosing(null)}>
      <StyleChoice initial={state.narration?.style ?? "read"} force={choosing.force} pending={pending} onClose={() => setChoosing(null)}
        onSubmit={style => { setChoosing(null); void request(choosing.force, style); }} />
    </Dialog>}
  </>;
  return { items, bar, state, renew: () => { void request(false); } };
}

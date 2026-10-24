import { useEffect, useRef, useState, type ReactNode } from "react";
import { FileText, Headphones, Play, RefreshCw, Trash2, X } from "lucide-react";
import { NARRATION_LIMITS, type DashboardRecord, type Narration, type NarrationState, type NarrationStyle } from "../../shared/contracts";
import type { MenuItem } from "./Menu";
import { text, narrationFailure } from "./listen-copy";
import { working, failedFor } from "./listen-state";
import { narrationStage } from "./narration-progress";
import { Player } from "./ListenPlayer";
import { config } from "../config";
import { accountErrorAction } from "../account-errors";
import { RecoveryLink } from "./RecoveryLink";
export type NarrationMenuItem = MenuItem & { readonly make?: boolean };
const EASE_MS = 220;
/**
 * The job's stage and a percent bar showing only what the server reported (see narration-progress). Within one job the value
 * never moves back (a script written again counts from zero), a newly reported value slides in over 300 ms (CSS `.listen-fill`,
 * none with reduced motion), and a once-a-second tick only renews the elapsed time in the label.
 */
function NarrationProgress({ narration, part, lead }: { readonly narration: Narration; readonly part: string; readonly lead: string }) {
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
    <span className="listen-track" role="progressbar" aria-label={text().progress(part)} aria-valuemin={0} aria-valuemax={100}
      aria-valuenow={percent} aria-valuetext={`${label} ${percent}%`}>
      <span className="listen-fill" style={{ transform: `scaleX(${shown.current.value / 100})` }} />
    </span>
    <span className="listen-percent" aria-hidden="true">{percent}%</span>
  </>;
}

/**
 * The narration commands for a reader's More menu; `label` (e.g. Articles, Messages) names the part in each when one screen holds several.
 * Make audio, Make again and Make new go through `onMake` (where a record's style is chosen); Try again repeats the failed job with `onRequest`.
 */
export function narrationItems(state: NarrationState | null, { pending, retryBlocked = false, cancelling, label, onRequest, onMake, onCancel, onListen, onScript, onRemove }: {
  readonly retryBlocked?: boolean;
  readonly pending: boolean; readonly cancelling: boolean; readonly label?: string | undefined;
  readonly onRequest: (force: boolean) => void; readonly onMake: (force: boolean) => void; readonly onCancel: () => void; readonly onListen: () => void;
  readonly onScript: () => void; readonly onRemove: () => void;
}): NarrationMenuItem[] {
  if (!state) return [];
  const recovery = accountErrorAction("gemini_key_required");
  const keyAction: NarrationMenuItem | null = !state.available && config.authMode === "google" && recovery ? {
    label: recovery.label, icon: <Headphones size={16} aria-hidden="true" />, disabled: pending,
    onSelect: () => { location.hash = recovery.href; },
  } : null;
  const part = label ?? "";
  const narration = state.narration;
  const blocked = pending || retryBlocked || !state.available;
  const icon = (Icon: typeof Play) => <Icon size={16} aria-hidden="true" />;
  if (working(state)) return [{ label: text().cancelMake(part), icon: icon(X), disabled: cancelling, onSelect: onCancel }];
  if (keyAction && !narration?.audio) return [keyAction];
  const items: NarrationMenuItem[] = [];
  if (failedFor(state) && !keyAction) {
    const exhausted = (narration?.attempts ?? 0) >= NARRATION_LIMITS.attempts;
    items.push({ label: text().retryAudio(part), icon: icon(RefreshCw), disabled: blocked, onSelect: () => onRequest(exhausted) });
  }
  const audio = narration?.audio ?? null;
  if (!audio) {
    if (items.length === 0) items.push({ label: `${text().make(part)}${state.available ? "" : text().keyNeeded}`, icon: icon(Headphones), disabled: blocked, make: true, onSelect: () => onMake(false) });
    return items;
  }
  items.push({ label: text().listenTo(part), icon: icon(Play), onSelect: onListen });
  if (keyAction) items.push(keyAction);
  else if (!failedFor(state)) items.push(narration?.stale
    ? { label: text().makeNew(part), icon: icon(RefreshCw), disabled: blocked, onSelect: () => onMake(false) }
    : { label: text().makeAgain(part), icon: icon(RefreshCw), disabled: blocked, onSelect: () => onMake(true) });
  if (narration?.script) items.push({ label: text().viewScript(part), icon: icon(FileText), onSelect: onScript });
  items.push({ label: text().deleteAudioOf(part), icon: icon(Trash2), danger: true, disabled: pending, onSelect: onRemove });
  return items;
}

/**
 * The narration line under a reader's action bar: a running job with its stage and a cancel x, a failure with a retry button,
 * or the (folded) player. Nothing when there is no audio and nothing running.
 */
export function NarrationBar({ record, state, label, pending, retryBlocked = false, cancelling, dismissed, open, finishing, playNonce, onCancel, onRetry, onDismiss, onOpen, onFold, onRemove }: {
  readonly retryBlocked?: boolean;
  readonly record: Pick<DashboardRecord, "id" | "title">; readonly state: NarrationState; readonly label?: string | undefined;
  readonly pending: boolean; readonly cancelling: boolean; readonly dismissed: boolean; readonly open: boolean;
  /** The job has just become ready: the bar finishes at 100% before the player takes its place. */
  readonly finishing: boolean; readonly playNonce: number;
  readonly onCancel: () => void; readonly onRetry: (force: boolean) => void; readonly onDismiss: () => void;
  readonly onOpen: () => void; readonly onFold: () => void; readonly onRemove: () => void;
}): ReactNode {
  const narration = state.narration;
  const part = label ?? "";
  // The row's sentence is set off from the part's name (뉴스 · …), so the two never read as one clause.
  const lead = label ? `${label} · ` : "";
  const done = finishing && narration?.status === "ready";
  if (narration && (working(state) || done)) {
    return <div className="listen-bar listen-working" role="status">
      <Headphones size={15} aria-hidden="true" />
      {cancelling ? <span className="listen-stage">{lead}{text().cancelling}</span> : <NarrationProgress narration={narration} part={part} lead={lead} />}
      {!done && <button type="button" className="icon-btn listen-icon" aria-label={text().cancelMake(part)} disabled={cancelling} onClick={onCancel}>
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
      {config.authMode === "google" && <RecoveryLink code={narration.error} />}
      <button type="button" className="btn btn-ghost" disabled={pending || retryBlocked || !state.available} onClick={() => onRetry(exhausted)}>{text().retry}</button>
      <button type="button" className="icon-btn listen-icon" aria-label={text().dismiss} onClick={onDismiss}><X size={16} aria-hidden="true" /></button>
    </div>;
  }
  if (!audio) return null;
  const note = narration && failedFor(state) && !dismissed ? <div className="listen-note" role="status">
    <span className="listen-stage">{lead}{text().remakeFailed} · {narrationFailure(narration.error)}</span>
    {config.authMode === "google" && <RecoveryLink code={narration.error} />}
    <button type="button" className="btn btn-ghost" disabled={pending || retryBlocked || !state.available} onClick={() => onRetry(exhausted)}>{text().retry}</button>
    <button type="button" className="icon-btn listen-icon" aria-label={text().dismiss} onClick={onDismiss}><X size={16} aria-hidden="true" /></button>
  </div> : null;
  // The player keeps its place in the tree, so closing the note does not restart what is playing.
  return <>
    <Player key={audio.url} recordId={record.id} title={record.title} src={audio.url} durationMs={audio.durationMs} stale={narration?.stale ?? false}
      podcast={audio.style === "podcast"} part={part} open={open} playNonce={playNonce} pending={pending} onOpen={onOpen} onFold={onFold} onRemove={onRemove} />
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

import { useEffect, useRef, useState } from "react";
import { ChevronUp, Pause, Play, Trash2 } from "lucide-react";
import { clock, nextRate, rememberPosition, savedPosition, usePlayback } from "./playback";
import { Tag } from "./primitives";
import { text } from "./listen-copy";
const spoken = (seconds: number) => {
  const total = Math.max(0, Math.floor(seconds));
  return text().spoken(Math.floor(total / 60), total % 60);
};
const minutesLabel = (ms: number) => ms < 60_000 ? text().seconds(Math.max(1, Math.round(ms / 1000))) : text().minutes(Math.round(ms / 60_000));
const stored = (key: string) => typeof localStorage === "undefined" ? null : localStorage.getItem(key);

export function Player({ recordId, title, src, durationMs, stale, podcast, part, open, playNonce, pending, onOpen, onFold, onRemove }: {
  readonly recordId: string; readonly title: string; readonly src: string; readonly durationMs: number; readonly stale: boolean; readonly podcast: boolean;
  readonly part: string; readonly open: boolean; readonly playNonce: number; readonly pending: boolean;
  readonly onOpen: () => void; readonly onFold: () => void; readonly onRemove: () => void;
}) {
  // 음성 삭제 beside the player in both states (the same command as the menu's, with its confirmation).
  const remove = <button type="button" className="icon-btn listen-icon listen-remove" aria-label={text().deleteAudioOf(part)} title={text().deleteAudio}
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
        aria-label={text().position(part)} aria-valuetext={`${spoken(time)} / ${spoken(duration)}`}
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
      <span>{text().listen(part)} · {minutesLabel(durationMs)}</span>
      {podcast && <Tag>{text().podcast}</Tag>}
      {stale && <Tag>{text().outdated}</Tag>}
    </button>}
    {!open && remove}
  </div>;
}

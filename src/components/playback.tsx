import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { Headphones, Pause, Play, X } from "lucide-react";
import { config } from "../config";
import { strings } from "../i18n";

const text = strings({
  en: { region: "Now playing", play: "Play", pause: "Pause", close: "Close player", position: "Playback position" },
  ko: { region: "재생 중", play: "재생", pause: "일시정지", close: "재생 닫기", position: "재생 위치" },
});

/** What plays: one record's (or digest part's) audio file, and the address of the screen it was started on. */
export type Track = {
  readonly src: string; readonly recordId: string; readonly title: string; readonly durationMs: number; readonly back: string;
};
export interface MediaElementLike extends EventTarget {
  src: string; currentTime: number; readonly duration: number; readonly paused: boolean; playbackRate: number;
  load(): void; play(): Promise<void>; pause(): void; removeAttribute(name: string): void;
}
export type PlaybackSnapshot = {
  readonly track: Track | null; readonly playing: boolean; readonly time: number; readonly duration: number; readonly rate: number;
  /** A player of the track is on screen; the mini player stands in only when none is. */
  readonly shown: boolean;
};
type MediaSessionLike = Pick<MediaSession, "metadata" | "playbackState" | "setActionHandler" | "setPositionState">;
type Storage = {
  readonly read: (key: string) => string | null; readonly write: (key: string, value: string) => void; readonly remove: (key: string) => void;
};

export const RATES = [1, 1.25, 1.5, 2, 0.8] as const;
const DEFAULT_RATE = 1;
const RATE_KEY = "agentic:listen-rate-v2";
/** The first player's key, written on every mount; a rate stored there was still the owner's last choice. */
const OLD_RATE_KEY = "agentic:listen-rate";
const positionKey = (recordId: string) => `agentic:listen:${recordId}`;
const SAVE_EVERY = 5;
const SKIP_SECONDS = 15;

const hasStorage = () => typeof localStorage !== "undefined";
const browserStorage: Storage = {
  read: key => hasStorage() ? localStorage.getItem(key) : null,
  write: (key, value) => { if (hasStorage()) localStorage.setItem(key, value); },
  remove: key => { if (hasStorage()) localStorage.removeItem(key); },
};
const knownRate = (value: string | null) => RATES.find(item => value !== null && item === Number(value)) ?? null;

/** The rate the owner last picked, else 1x. */
export function initialRate(read: (key: string) => string | null = browserStorage.read): number {
  return knownRate(read(RATE_KEY)) ?? knownRate(read(OLD_RATE_KEY)) ?? DEFAULT_RATE;
}
export const nextRate = (rate: number) => RATES[(RATES.findIndex(item => item === rate) + 1) % RATES.length] ?? DEFAULT_RATE;

export function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const pad = (value: number) => String(value).padStart(2, "0");
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return hours ? `${hours}:${pad(minutes)}:${pad(total % 60)}` : `${minutes}:${pad(total % 60)}`;
}

/** Where the owner stopped this file of this record, in whole seconds; 0 for another file or none. */
export function savedPosition(recordId: string, src: string, read: (key: string) => string | null = browserStorage.read): number {
  try {
    const saved: unknown = JSON.parse(read(positionKey(recordId)) ?? "null");
    return saved && typeof saved === "object" && "src" in saved && "t" in saved && saved.src === src && typeof saved.t === "number" && saved.t > 0 ? saved.t : 0;
  } catch { return 0; }
}
export function rememberPosition(recordId: string, src: string, seconds: number, write: Storage["write"] = browserStorage.write) {
  write(positionKey(recordId), JSON.stringify({ src, t: Math.floor(seconds) }));
}
export function forgetPosition(recordId: string, remove: Storage["remove"] = browserStorage.remove) { remove(positionKey(recordId)); }

export type PlaybackStore = ReturnType<typeof createPlayback>;

/**
 * The app's one playback: a single audio element outside routing, so it keeps playing on every screen of the app, and the state
 * (track, play/pause, time, rate) every player shows. Players register while mounted (`mount`); while none of the track is
 * mounted the mini player stands in. Starting a track saves the previous one's position and replaces it, so two never play.
 */
export function createPlayback({ read, write, remove, media }: Partial<Storage> & { readonly media?: MediaSessionLike | null } = {}) {
  const storage: Storage = { read: read ?? browserStorage.read, write: write ?? browserStorage.write, remove: remove ?? browserStorage.remove };
  const session = media === undefined ? (typeof navigator !== "undefined" && "mediaSession" in navigator ? navigator.mediaSession : null) : media;
  let element: MediaElementLike | null = null;
  let state: PlaybackSnapshot = { track: null, playing: false, time: 0, duration: 0, rate: initialRate(storage.read), shown: false };
  const mounted = new Map<string, number>();
  const listeners = new Set<() => void>();
  /** A position to land on once the file's length is known (a resume or a seek before loading). */
  let pendingAt: number | null = null;
  let savedAt = 0;
  const shownFor = (track: Track | null) => track !== null && (mounted.get(track.src) ?? 0) > 0;
  const set = (patch: Partial<PlaybackSnapshot>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const save = (seconds: number) => {
    if (!state.track) return;
    savedAt = seconds;
    rememberPosition(state.track.recordId, state.track.src, seconds, storage.write);
  };
  const position = () => {
    if (!session || !element || !(state.duration > 0) || !Number.isFinite(state.duration)) return;
    try { session.setPositionState({ duration: state.duration, playbackRate: state.rate, position: Math.min(state.time, state.duration) }); }
    catch { /* WebKit rejects a position state while the file's length is still settling; the next update sends it again. */ }
  };
  const events: Record<string, () => void> = {
    play: () => { set({ playing: true }); if (session) session.playbackState = "playing"; },
    pause: () => {
      set({ playing: false });
      if (session) session.playbackState = "paused";
      if (element) save(element.currentTime);
    },
    timeupdate: () => {
      if (!element || !state.track) return;
      const seconds = element.currentTime;
      set({ time: seconds });
      if (Math.abs(seconds - savedAt) >= SAVE_EVERY) save(seconds);
      position();
    },
    loadedmetadata: () => {
      if (!element) return;
      const duration = element.duration;
      if (Number.isFinite(duration) && duration > 0) set({ duration });
      const at = pendingAt;
      pendingAt = null;
      if (at !== null && at > 0 && at < duration - 3) { element.currentTime = at; set({ time: at }); }
      position();
    },
    ended: () => {
      set({ playing: false, time: 0 });
      if (state.track) forgetPosition(state.track.recordId, storage.remove);
      savedAt = 0;
    },
  };
  const play = () => {
    // Autoplay rules may refuse a play outside a gesture; the element then stays paused and the state already says so.
    element?.play().catch(() => undefined);
  };
  const pause = () => { element?.pause(); };
  const seek = (seconds: number) => {
    if (!element || !state.track) return;
    if (Number.isFinite(element.duration) && element.duration > 0) element.currentTime = seconds;
    else pendingAt = seconds;
    set({ time: seconds });
    save(seconds);
  };
  const close = () => {
    if (element) {
      element.pause();
      element.removeAttribute("src");
      element.load();
    }
    pendingAt = null;
    set({ track: null, playing: false, time: 0, duration: 0, shown: false });
    if (session) { session.metadata = null; session.playbackState = "none"; }
  };
  const store = {
    snapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    attach(next: MediaElementLike) {
      element = next;
      element.playbackRate = state.rate;
      for (const [name, handler] of Object.entries(events)) element.addEventListener(name, handler);
      if (session) {
        const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
          ["play", play], ["pause", pause], ["stop", close],
          ["seekbackward", details => seek(Math.max(0, state.time - (details.seekOffset ?? SKIP_SECONDS)))],
          ["seekforward", details => seek(Math.min(state.duration, state.time + (details.seekOffset ?? SKIP_SECONDS)))],
          ["seekto", details => { if (details.seekTime !== undefined) seek(details.seekTime); }],
        ];
        for (const [action, handler] of handlers) {
          try { session.setActionHandler(action, handler); }
          catch { /* A browser that does not know an action throws; the others still apply. */ }
        }
      }
      return () => {
        for (const [name, handler] of Object.entries(events)) next.removeEventListener(name, handler);
        if (element === next) element = null;
      };
    },
    /** Plays `track` (from its saved position unless `at` says where), or carries on with it when it is already the one loaded. */
    start(track: Track, { play: autoplay, at }: { readonly play: boolean; readonly at?: number }) {
      if (!element) return;
      if (state.track?.src === track.src) {
        if (at !== undefined) seek(at);
        if (autoplay) play();
        return;
      }
      if (!element.paused) element.pause();
      pendingAt = at ?? savedPosition(track.recordId, track.src, storage.read);
      savedAt = pendingAt;
      set({ track, playing: false, time: pendingAt, duration: track.durationMs / 1000, shown: shownFor(track) });
      element.src = track.src;
      element.playbackRate = state.rate;
      element.load();
      if (session && typeof MediaMetadata !== "undefined") {
        session.metadata = new MediaMetadata({ title: track.title, artist: config.appName, artwork: [{ src: "/brand-mark.png" }] });
      }
      if (autoplay) play();
    },
    toggle() {
      if (!element || !state.track) return;
      if (element.paused) play();
      else pause();
    },
    seek,
    setRate(rate: number) {
      storage.write(RATE_KEY, String(rate));
      if (element) element.playbackRate = rate;
      set({ rate });
      position();
    },
    close,
    /** Stops `src` when it is what plays (its audio was deleted). */
    stop(src: string) { if (state.track?.src === src) close(); },
    /** A player of `src` is on screen until the returned function runs. */
    mount(src: string) {
      mounted.set(src, (mounted.get(src) ?? 0) + 1);
      set({ shown: shownFor(state.track) });
      return () => {
        const left = (mounted.get(src) ?? 1) - 1;
        if (left > 0) mounted.set(src, left);
        else mounted.delete(src);
        set({ shown: shownFor(state.track) });
      };
    },
  };
  return store;
}

/** Outside a provider (tests, a static render) players get a store with no element: it shows state and plays nothing. */
export const PlaybackContext = createContext<PlaybackStore>(createPlayback({ media: null }));

/** Wraps the whole app: the one audio element lives here, beside the routes, so changing screens never unmounts it. */
export function PlaybackProvider({ children }: { readonly children: ReactNode }) {
  const [store] = useState(() => createPlayback());
  const audio = useRef<HTMLAudioElement>(null);
  useEffect(() => audio.current ? store.attach(audio.current) : undefined, [store]);
  return <PlaybackContext.Provider value={store}>
    {children}
    <audio ref={audio} preload="metadata" />
  </PlaybackContext.Provider>;
}

export function usePlayback(store?: PlaybackStore): { readonly store: PlaybackStore; readonly snapshot: PlaybackSnapshot } {
  const context = useContext(PlaybackContext);
  const current = store ?? context;
  const snapshot = useSyncExternalStore(current.subscribe, current.snapshot, current.snapshot);
  return { store: current, snapshot };
}

/** Whether the mini player is up; a boolean, so the app shell re-renders only when it appears or goes, not on every tick. */
export function useMiniPlayerShown(): boolean {
  const store = useContext(PlaybackContext);
  const shown = () => { const state = store.snapshot(); return state.track !== null && !state.shown; };
  return useSyncExternalStore(store.subscribe, shown, shown);
}

/**
 * The playback that goes on while its record's player is off screen: the record's title (a link back to the screen it was started
 * on), its time, play/pause and close, with a thin progress line. Sits above the phone's tab bar, in the corner on wider screens.
 */
export function MiniPlayer({ store }: { readonly store?: PlaybackStore }) {
  const { store: playback, snapshot } = usePlayback(store);
  const t = text();
  const { track, playing, time, duration } = snapshot;
  if (!track || snapshot.shown) return null;
  const percent = duration > 0 ? Math.min(100, Math.floor((time / duration) * 100)) : 0;
  return <section className="mini-player" aria-label={t.region}>
    <span className="mini-progress" role="progressbar" aria-label={t.position} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}
      aria-valuetext={`${clock(time)} / ${clock(duration)}`}>
      <span className="mini-fill" style={{ transform: `scaleX(${percent / 100})` }} />
    </span>
    <a className="mini-title" href={track.back}>
      <Headphones size={16} aria-hidden="true" />
      <span className="mini-text"><strong>{track.title}</strong><span aria-hidden="true">{clock(time)} / {clock(duration)}</span></span>
    </a>
    <button type="button" className="listen-play mini-toggle" aria-label={playing ? t.pause : t.play} onClick={() => playback.toggle()}>
      {playing ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
    </button>
    <button type="button" className="icon-btn mini-close" aria-label={t.close} title={t.close} onClick={() => playback.close()}>
      <X size={18} aria-hidden="true" />
    </button>
  </section>;
}

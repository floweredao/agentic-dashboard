import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { NarrationBar } from "./Listen";
import { createPlayback, MiniPlayer, PlaybackContext, savedPosition } from "./playback";
import type { MediaElementLike, Track } from "./playback";

class FakeAudio extends EventTarget implements MediaElementLike {
  src = "";
  currentTime = 0;
  duration = Number.NaN;
  paused = true;
  playbackRate = 1;
  loads = 0;
  load() { this.loads += 1; }
  removeAttribute(name: string) { if (name === "src") this.src = ""; }
  play() { this.paused = false; this.dispatchEvent(new Event("play")); return Promise.resolve(); }
  pause() { if (this.paused) return; this.paused = true; this.dispatchEvent(new Event("pause")); }
  meta(duration: number) { this.duration = duration; this.dispatchEvent(new Event("loadedmetadata")); }
  tick(seconds: number) { this.currentTime = seconds; this.dispatchEvent(new Event("timeupdate")); }
}

const track = (n: number, back = `#/inbox/record-${n}`): Track => ({
  src: `/api/v1/records/record-${n}/narration/audio?v=${n}`, recordId: `record-${n}`, title: `기록 ${n}`, durationMs: 600_000, back,
});

function setup(saved: Record<string, string> = {}) {
  const storage = new Map(Object.entries(saved));
  const store = createPlayback({
    read: key => storage.get(key) ?? null, write: (key, value) => { storage.set(key, value); }, remove: key => { storage.delete(key); }, media: null,
  });
  const audio = new FakeAudio();
  store.attach(audio);
  return { store, audio, storage };
}

test("one audio element plays one record at a time, and starting another replaces the first", () => {
  // Given record 1 playing
  const { store, audio } = setup();
  store.start(track(1), { play: true });
  expect(audio.src).toBe(track(1).src);
  expect(store.snapshot()).toMatchObject({ track: track(1), playing: true });
  // When record 2 is started from its own player
  store.start(track(2), { play: true });
  // Then the same element now plays record 2 only
  expect(audio.src).toBe(track(2).src);
  expect(store.snapshot().track?.recordId).toBe("record-2");
  expect(store.snapshot().playing).toBe(true);
});

test("playback continues while its player is away, and the mini player shows only then", () => {
  // Given record 1 started from its player on the record screen
  const { store, audio } = setup();
  const unmount = store.mount(track(1).src);
  store.start(track(1), { play: true });
  audio.tick(42);
  expect(store.snapshot()).toMatchObject({ shown: true, time: 42 });
  // When the owner opens another tab (the record's player unmounts)
  unmount();
  audio.tick(50);
  // Then the audio keeps playing and the mini player is due
  expect(store.snapshot()).toMatchObject({ shown: false, playing: true, time: 50 });
  // And back on the record, its player shows the same playback again
  const again = store.mount(track(1).src);
  expect(store.snapshot()).toMatchObject({ shown: true, playing: true, time: 50 });
  again();
  // A player of another record does not count as showing this one
  store.mount(track(2).src);
  expect(store.snapshot().shown).toBe(false);
});

test("the mini player pauses, plays and closes; closing stops the audio and clears the track", () => {
  const { store, audio } = setup();
  store.start(track(1), { play: true });
  store.toggle();
  expect(audio.paused).toBe(true);
  expect(store.snapshot()).toMatchObject({ playing: false, track: track(1) });
  store.toggle();
  expect(audio.paused).toBe(false);
  store.close();
  expect(audio.paused).toBe(true);
  expect(audio.src).toBe("");
  expect(store.snapshot()).toMatchObject({ track: null, playing: false });
});

test("deleting a record's audio stops it only when that audio is the one playing", () => {
  const { store, audio } = setup();
  store.start(track(1), { play: true });
  store.stop(track(2).src);
  expect(store.snapshot().track?.recordId).toBe("record-1");
  store.stop(track(1).src);
  expect(store.snapshot().track).toBeNull();
  expect(audio.paused).toBe(true);
});

test("the position is kept per record and file, and a start resumes from it", () => {
  // Given record 1 played to 130 s, then paused
  const { store, audio, storage } = setup();
  store.start(track(1), { play: true });
  audio.meta(600);
  audio.tick(130);
  audio.pause();
  const read = (key: string) => storage.get(key) ?? null;
  expect(savedPosition("record-1", track(1).src, read)).toBe(130);
  // A newer file of the same record does not resume from the old one's position
  expect(savedPosition("record-1", `${track(1).src}x`, read)).toBe(0);
  // When it is started again later, it resumes there
  store.close();
  store.start(track(1), { play: true });
  audio.meta(600);
  expect(audio.currentTime).toBe(130);
  // And playing to the end forgets it
  audio.dispatchEvent(new Event("ended"));
  expect(savedPosition("record-1", track(1).src, read)).toBe(0);
});

test("a seek before the file has loaded lands once its length is known, and the rate carries over to the next record", () => {
  const { store, audio, storage } = setup();
  store.setRate(1.5);
  expect(storage.get("agentic:listen-rate-v2")).toBe("1.5");
  store.start(track(1), { play: false, at: 200 });
  audio.meta(600);
  expect(audio.currentTime).toBe(200);
  store.start(track(2), { play: true });
  expect(audio.playbackRate).toBe(1.5);
  expect(store.snapshot().rate).toBe(1.5);
});

const narration = (src: string) => ({ narration: {
  recordId: "record-1", style: "read" as const, stale: false, progress: null, waitUntil: null, stepAt: null, attempts: 0, error: null, requestedBy: "owner",
  requestedAt: "2026-10-07T12:00:00Z", updatedAt: "2026-10-07T12:00:00Z", status: "ready" as const, script: null,
  audio: { url: src, mime: "audio/mp4", bytes: 1000, durationMs: 600_000, model: "m", voice: "Kore", style: "read" as const, createdAt: "2026-10-07T12:01:00Z" },
}, available: true });
const noop = () => {};
const recordBar = (store: ReturnType<typeof createPlayback>) => renderToStaticMarkup(<PlaybackContext.Provider value={store}>
  <NarrationBar record={{ id: "record-1", title: "기록 1" }} state={narration(track(1).src)} pending={false} cancelling={false} dismissed={false}
    open finishing={false} playNonce={0} onCancel={noop} onRetry={noop} onDismiss={noop} onOpen={noop} onFold={noop} onRemove={noop} />
</PlaybackContext.Provider>);

test("back on the record, its player shows the playback that kept going, not a second one", () => {
  // Given record 1 playing at 1:05 while the owner was on another screen
  const { store, audio } = setup();
  store.start(track(1), { play: true });
  audio.tick(65);
  // When the record's player renders again
  const html = recordBar(store);
  // Then it shows that playback: pause, its time, and no audio element of its own
  expect(html).toContain('aria-label="일시정지"');
  expect(html).toContain("1:05 / 10:00");
  expect(html).not.toContain("<audio");
  // While another record plays, this one's player waits at play
  store.start(track(2), { play: true });
  expect(recordBar(store)).toContain('aria-label="재생"');
});

test("the mini player names the record and offers play/pause, close and the way back", () => {
  const { store, audio } = setup();
  expect(renderToStaticMarkup(<MiniPlayer store={store} />)).toBe("");
  store.start(track(1, "#/digest/d-1"), { play: true });
  audio.meta(600);
  audio.tick(30);
  const html = renderToStaticMarkup(<MiniPlayer store={store} />);
  expect(html).toContain("기록 1");
  expect(html).toContain('href="#/digest/d-1"');
  expect(html).toContain('aria-label="일시정지"');
  expect(html).toContain('aria-label="재생 닫기"');
  expect(html).toMatch(/role="progressbar"[^>]*aria-valuenow="5"/);
  // Not while the record's own player is on screen
  store.mount(track(1).src);
  expect(renderToStaticMarkup(<MiniPlayer store={store} />)).toBe("");
});

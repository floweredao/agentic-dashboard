import { useEffect, useRef, useState, type ReactNode } from "react";
import { HTTPError } from "ky";
import { formatDateTime, strings } from "../i18n";
import type { DashboardRecord, NarrationState, NarrationStyle } from "../../shared/contracts";
import { cancelNarration, deleteNarration, errorCode, errorMessage, loadNarration, requestNarration, type NarrationCollection } from "../api";
import { retryAfterMs, useRateLimited } from "../rate-limit";
import { useDashboard } from "../state";
import { forgetPosition, usePlayback } from "./playback";
import { Dialog } from "./primitives";
import { text, type Failures } from "./listen-copy";
import { working, failureDismissed, rememberDismissed } from "./listen-state";
import { NarrationBar, narrationItems, StyleChoice, type NarrationMenuItem } from "./ListenControls";
const POLL_MS = 3000;
const FINISH_HOLD_MS = 900;
const retryText = strings({
  en: { wait: (seconds: number, at: string) => `Try again in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} · ${at}` },
  ko: { wait: (seconds: number, at: string) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} 뒤에 다시 시도할 수 있어요 · ${at}` },
});
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
  const limited = useRateLimited();
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
  const [retryUntil, setRetryUntil] = useState(0);
  const [clock, setClock] = useState(Date.now);
  const alive = useRef(true);
  const wasWorking = useRef(false);
  const finishTimer = useRef(0);
  useEffect(() => { alive.current = true; return () => { alive.current = false; window.clearTimeout(finishTimer.current); }; }, []);
  useEffect(() => {
    setOpen(false); setPlayNonce(0); setScript(false); setDismissed(null); setChoosing(null); setFinishing(false);
    setRetryUntil(0);
    wasWorking.current = false;
  }, [id]);
  const state = id && loaded?.id === id ? loaded.state : null;
  const deadline = Math.max(retryUntil, state?.narration?.retryAt ? Date.parse(state.narration.retryAt) : 0);
  const remaining = Math.max(0, Math.ceil((deadline - clock) / 1000));
  useEffect(() => {
    setClock(Date.now());
    if (deadline <= Date.now()) return;
    const timer = window.setInterval(() => {
      setClock(Date.now()); if (Date.now() >= deadline) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [deadline]);
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
    if (error instanceof HTTPError && error.response.status === 429) setRetryUntil(Date.now() + retryAfterMs(error.response.headers.get("Retry-After")));
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
    if (limited || pending) return;
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
    pending: pending || limited, retryBlocked: remaining > 0, cancelling, label,
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
    {remaining > 0 && <p className="setting-note" role="status">{retryText().wait(remaining, formatDateTime(deadline, { hour: "numeric", minute: "2-digit", timeZoneName: "short" }))}</p>}
    <NarrationBar record={record} state={state} label={label} pending={pending || limited} retryBlocked={remaining > 0} cancelling={cancelling}
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
      <StyleChoice initial={state.narration?.style ?? "read"} force={choosing.force} pending={pending || limited || remaining > 0} onClose={() => setChoosing(null)}
        onSubmit={style => { setChoosing(null); void request(choosing.force, style); }} />
    </Dialog>}
  </>;
  return { items, bar, state, renew: () => { void request(false); } };
}

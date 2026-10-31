import { useEffect, useRef, useState } from "react";
import { CircleCheck, CircleDot, Headphones, Newspaper } from "lucide-react";
import { digestPartId } from "../../shared/contracts";
import type { DigestReactions, Digest, DigestNarration, DigestPart } from "../../shared/contracts";
import { errorMessage, loadDigest, reactToArticle } from "../api";
import { useNarration } from "../components/Listen";
import { Menu } from "../components/Menu";
import type { MenuItem } from "../components/Menu";
import { Dialog, Empty } from "../components/primitives";
import { digestPartItems, partReadAt } from "../model";
import { useDashboard } from "../state";
import { text, type DigestFilter, filterParts, dayTitle, slotTitle, partLabel } from "./digest-common";
import { useCollapsed, useDensity } from "./digest-interaction";
import { type ReactHandler } from "./DigestCards";
import { DigestView } from "./DigestView";
/** What a choice needs to know of a narration: whether it can be made, and whether it has audio, failed or is running. */
type VoiceState = { readonly available: boolean; readonly narration: { readonly status: string; readonly audio: unknown } | null };

export type VoiceOption = { readonly key: DigestNarration; readonly label: string; readonly hint: string; readonly make: MenuItem | undefined; readonly state: VoiceState | null };

/** Why an audio cannot be made now, in words (never colour alone): it has audio, is being made, failed, or lacks the key. */
function voiceNote({ make, state }: VoiceOption) {
  const notes = text().voiceNotes;
  const narration = state?.narration;
  if (make) return make.disabled ? state?.available ? notes.cannotNow : notes.keyNeeded : null;
  if (narration?.status === "ready" && narration.audio) return notes.ready;
  if (narration?.status === "failed") return notes.failed;
  return notes.making;
}

/** The choice behind a digest's one Make audio: which audio (the whole digest or one part) as radio cards; one that cannot be made says why. */
export function VoiceChoice({ options, onSubmit, onClose }: {
  readonly options: readonly VoiceOption[]; readonly onSubmit: (make: MenuItem) => void; readonly onClose: () => void;
}) {
  const t = text();
  const ready = options.filter(option => option.make && !option.make.disabled);
  const [chosen, setChosen] = useState<string>(ready[0]?.key ?? "");
  const pick = ready.find(option => option.key === chosen)?.make;
  return <form onSubmit={event => { event.preventDefault(); if (pick) onSubmit(pick); }}>
    <fieldset className="listen-styles">
      <legend className="visually-hidden">{t.voiceLegend}</legend>
      {options.map(option => {
        const note = voiceNote(option);
        const enabled = Boolean(option.make && !option.make.disabled);
        return <label key={option.key} className={`listen-style${enabled ? "" : " is-disabled"}`}>
          <input type="radio" name="digest-voice" value={option.key} checked={chosen === option.key} disabled={!enabled}
            data-autofocus={chosen === option.key ? "" : undefined} onChange={() => setChosen(option.key)} />
          <span className="listen-style-text"><strong>{option.label}</strong>{option.hint && <span>{option.hint}</span>}
            {note && <span className="listen-style-note">{note}</span>}</span>
        </label>;
      })}
    </fieldset>
    <div className="dialog-actions">
      <button type="button" className="btn btn-outline" onClick={onClose}>{t.cancel}</button>
      <button type="submit" className="btn btn-primary" disabled={!pick}>{t.create}</button>
    </div>
  </form>;
}


const cache = new Map<string, Digest>();

const reactionCache = new Map<string, DigestReactions>();


/**
 * The reader pane of the digest tab: loads the digest, shows the filter's parts, marks each unread part with items read once,
 * and offers listening to the whole digest or one part from the ⋯ More beside the date title.
 */
export function DigestReader({ id, part }: { readonly id: string; readonly part: DigestFilter }) {
  const t = text();
  const d = useDashboard();
  const [digest, setDigest] = useState<Digest | null>(() => cache.get(id) ?? null);
  const [reactions, setReactions] = useState<DigestReactions>(() => reactionCache.get(id) ?? {});
  // Only the latest reaction request settles the buttons, so quick taps never end on an older answer.
  const reactionTurn = useRef(0);
  const [failed, setFailed] = useState<string | null>(null);
  const [collapsed, setExpanded] = useCollapsed();
  const [density, setDensity] = useDensity();
  const [choosingVoice, setChoosingVoice] = useState(false);
  const marked = useRef(false);
  const scrolledTo = useRef<string | null>(null);
  const known = d.digests?.items.find(item => item.id === id);
  const readAtOf = (each: DigestPart) => {
    const readKey = `${id}:${each}`;
    return d.digestReads.has(readKey) ? d.digestReads.get(readKey) ?? null
      : known ? partReadAt(known, each) : digest ? partReadAt(digest, each) : null;
  };
  // Only a part with something to read has a read state to change and something to narrate.
  const filled = digest ? filterParts(part).filter(each => digestPartItems(digest, each) > 0) : [];
  // The whole digest is narrated as one audio when the filter shows both parts and both have items.
  const narrated = (each: DigestNarration) => each === "all" ? part === "all" && filled.length > 1 : filled.includes(each);
  const narrationOf = (each: DigestNarration) => digest && narrated(each)
    ? { id: digestPartId(id, each), title: `${dayTitle(digest.date)} ${slotTitle(digest.slot)}${each === "all" ? "" : ` · ${partLabel(each)}`}`, version: digest.version }
    : null;
  const label = (each: DigestNarration) => part === "all" ? each === "all" ? t.digestAudio : partLabel(each) : undefined;
  const allNarration = useNarration({ record: narrationOf("all"), collection: "digests", label: label("all") });
  const messagesNarration = useNarration({ record: narrationOf("messages"), collection: "digests", label: label("messages") });
  const articlesNarration = useNarration({ record: narrationOf("articles"), collection: "digests", label: label("articles") });
  useEffect(() => {
    let alive = true;
    setReactions(reactionCache.get(id) ?? {});
    loadDigest(id).then(next => {
      cache.set(id, next.digest); reactionCache.set(id, next.reactions);
      if (alive) { setDigest(next.digest); setReactions(next.reactions); }
    },
      async (error: unknown) => { if (alive) setFailed(await errorMessage(error)); });
    return () => { alive = false; };
  }, [id, known?.version]);
  useEffect(() => {
    if (!digest || marked.current) return;
    marked.current = true;
    document.getElementById("digest-title")?.closest(".pane")?.scrollTo({ top: 0 });
    if (window.matchMedia("(max-width: 767px)").matches) document.getElementById("digest-title")?.focus({ preventScroll: true });
    for (const each of filled) if (readAtOf(each) === null) void d.markDigest(id, each, true, true);
  }, [digest]);
  const focus = d.route.params.focus;
  useEffect(() => {
    if (!digest || !focus || scrolledTo.current === focus) return;
    // A search hit inside a collapsed section opens that section, then scrolls once it renders.
    const section = focus.split(":")[0] ?? "";
    if (collapsed.has(section)) { setExpanded(section, true); return; }
    scrolledTo.current = focus;
    document.getElementById(`item-${focus.replace(":", "-")}`)?.scrollIntoView({ block: "center" });
  }, [digest, focus, collapsed]);
  if (failed) return <div className="reader-empty" role="alert"><Empty>{failed}</Empty></div>;
  if (!digest) return <div className="reader-empty" role="status"><Empty icon={<Newspaper size={20} aria-hidden="true" />}>{t.loading}</Empty></div>;
  const unread = filled.some(each => readAtOf(each) === null);
  /** Mark as read marks every unread part; mark as unread (only when all are read) marks them all unread. One toast for the whole change. */
  const toggleRead = () => {
    const targets = filled.filter(each => (readAtOf(each) === null) === unread);
    targets.forEach((each, index) => { void d.markDigest(id, each, unread, index < targets.length - 1); });
  };
  const narrations = [{ key: "all", narration: allNarration }, { key: "messages", narration: messagesNarration },
    { key: "articles", narration: articlesNarration }] as const;
  // A narration with no job yet offers one command, Make audio; with several of them the commands fold into one that asks which.
  const voices: VoiceOption[] = narrations.flatMap(({ key, narration }) => narration.state ? [{ key, label: key === "all" ? t.wholeDigest : partLabel(key),
    hint: t.voiceHints[key], make: narration.state.narration === null ? narration.items[0] : undefined, state: narration.state }] : []);
  const folded = voices.length > 1 && voices.some(each => each.make);
  const narrationItems = narrations.flatMap(({ narration }) => folded && narration.state?.narration === null ? [] : narration.items);
  const makeItem: MenuItem[] = folded ? [{ label: t.makeAudio, icon: <Headphones size={16} aria-hidden="true" />,
    disabled: voices.every(each => !each.make || each.make.disabled), onSelect: () => setChoosingVoice(true) }] : [];
  /** Shows the choice at once and saves it; a refusal puts the buttons back and says why. */
  const react: ReactHandler = (section, key, reaction) => {
    const before = reactions;
    const next = { ...reactions };
    if (reaction) next[`${section}:${key}`] = reaction; else delete next[`${section}:${key}`];
    setReactions(next);
    const turn = ++reactionTurn.current;
    reactToArticle(id, section, key, reaction, d.csrfToken).then(saved => {
      reactionCache.set(id, saved);
      if (turn === reactionTurn.current) setReactions(saved);
    }, async (error: unknown) => {
      if (turn === reactionTurn.current) setReactions(before);
      d.notify(await errorMessage(error), "error");
    });
  };
  const readItem: MenuItem = { label: unread ? t.markRead : t.markUnread,
    icon: unread ? <CircleCheck size={16} aria-hidden="true" /> : <CircleDot size={16} aria-hidden="true" />, onSelect: toggleRead };
  const actions = filled.length > 0 && <Menu label={t.more} items={[readItem, ...makeItem, ...narrationItems]} />;
  return <DigestView digest={digest} part={part} actions={actions} collapsed={collapsed} onExpand={setExpanded} density={density} onDensity={setDensity}
    reactions={reactions} onReact={react}
    {...(focus ? { focus } : {})}
    listen={<>{allNarration.bar}{messagesNarration.bar}{articlesNarration.bar}
      {choosingVoice && folded && <Dialog title={t.makeAudio} onClose={() => setChoosingVoice(false)}>
        <VoiceChoice options={voices} onClose={() => setChoosingVoice(false)} onSubmit={make => { setChoosingVoice(false); make.onSelect(); }} />
      </Dialog>}</>} />;
}

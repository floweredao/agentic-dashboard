import { useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import type { NarrationVoiceSettings, NarrationVoices } from "../../shared/contracts";
import { NARRATION_STYLE_TEXT_MAX } from "../../shared/contracts";
import { errorMessage, loadVoiceSettings, saveVoiceSettings, voicePreviewUrl } from "../api";
import { strings } from "../i18n";
import { useDashboard } from "../state";

type Voice = NarrationVoiceSettings["voices"][number];
type Gender = "male" | "female";
type Role = "readVoice" | "hostA" | "hostB";
const ROLES: readonly Role[] = ["readVoice", "hostA", "hostB"];

const text = strings({
  en: {
    heading: "Narration voices",
    note: "Used from the next audio you make. Audio already made keeps its voice.",
    roles: { readVoice: "Read aloud", hostA: "Podcast host A (main)", hostB: "Podcast host B" } satisfies Record<Role, string>,
    male: "Male", female: "Female", gender: (role: string) => `${role} gender`, voice: (role: string) => `${role} voice`,
    pitch: { low: "low voice", medium: "medium voice", high: "high voice" },
    listen: "Listen", stop: "Stop", loading: "Making a sample",
    listenTo: (name: string) => `Listen to ${name}`,
    sameHost: "Pick a voice different from host A.",
    readStyle: "Read-aloud speaking style", podcastStyle: "Podcast speaking style",
    styleHint: "How the voice should speak: tone, pace, pauses.",
    defaults: "Default voices", save: "Save", saving: "Saving",
    saved: "Saved. New audio uses these voices.", previewFailed: "Couldn't play the sample.",
  },
  ko: {
    heading: "낭독 목소리",
    note: "다음에 만드는 음성부터 적용돼요. 이미 만든 음성은 그대로예요.",
    roles: { readVoice: "낭독", hostA: "팟캐스트 진행자 A(메인)", hostB: "팟캐스트 진행자 B" } satisfies Record<Role, string>,
    male: "남성", female: "여성", gender: (role: string) => `${role} 성별`, voice: (role: string) => `${role} 목소리`,
    pitch: { low: "낮은 목소리", medium: "중간 목소리", high: "높은 목소리" },
    listen: "미리 듣기", stop: "멈추기", loading: "샘플 만드는 중",
    listenTo: (name: string) => `${name} 미리 듣기`,
    sameHost: "진행자 A와 다른 목소리를 골라 주세요.",
    readStyle: "낭독 말투", podcastStyle: "팟캐스트 말투",
    styleHint: "목소리가 어떻게 말할지 적어요. 말투, 빠르기, 쉼 같은 것.",
    defaults: "기본 목소리로", save: "저장", saving: "저장하는 중",
    saved: "저장했어요. 새로 만드는 음성부터 이 목소리를 써요.", previewFailed: "샘플을 재생하지 못했어요.",
  },
});

/** Voices of `gender`, with voices of unknown gender (a provider's own) offered under both. */
export function voicesFor(voices: readonly Voice[], gender: Gender): Voice[] {
  return voices.filter(voice => voice.gender === gender || voice.gender === "neutral");
}
/** The gender tab a saved voice opens under: male for a male voice, else female. */
export const genderOf = (voices: readonly Voice[], id: string): Gender => voices.find(voice => voice.id === id)?.gender === "male" ? "male" : "female";
const same = (a: NarrationVoices, b: NarrationVoices) => (Object.keys(a) as (keyof NarrationVoices)[]).every(key => a[key] === b[key]);

/**
 * Settings › Narration voices (owner, when narration is configured): gender and voice for read-aloud and the two podcast hosts with a sample, and
 * the speaking style of each; an explicit save keeps the draft apart from what the server has, and a failed save keeps the draft.
 */
export function VoiceSettings() {
  const t = text();
  const d = useDashboard();
  const [loaded, setLoaded] = useState<NarrationVoiceSettings | null>(null);
  const [draft, setDraft] = useState<NarrationVoices | null>(null);
  const [genders, setGenders] = useState<Record<Role, Gender>>({ readVoice: "male", hostA: "male", hostB: "female" });
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);
  const audio = useRef<HTMLAudioElement | null>(null);
  const [preview, setPreview] = useState<{ voice: string; playing: boolean } | null>(null);

  useEffect(() => {
    let alive = true;
    loadVoiceSettings().then(value => {
      if (!alive) return;
      setLoaded(value);
      setDraft(value.settings);
      setGenders({ readVoice: genderOf(value.voices, value.settings.readVoice), hostA: genderOf(value.voices, value.settings.hostA),
        hostB: genderOf(value.voices, value.settings.hostB) });
    }, () => { if (alive) setLoaded(null); });
    return () => { alive = false; audio.current?.pause(); };
  }, []);
  if (!loaded || !draft) return null;

  const voices = loaded.voices;
  const name = (id: string) => voices.find(voice => voice.id === id)?.name ?? id;
  const sameHost = draft.hostA === draft.hostB;
  const tooLong = draft.readStyle.trim().length > NARRATION_STYLE_TEXT_MAX || draft.podcastStyle.trim().length > NARRATION_STYLE_TEXT_MAX;
  const empty = !draft.readStyle.trim() || !draft.podcastStyle.trim();
  const dirty = !same(draft, loaded.settings);
  const set = (changes: Partial<NarrationVoices>) => setDraft(current => current ? { ...current, ...changes } : current);

  const chooseGender = (role: Role, gender: Gender) => {
    setGenders(current => ({ ...current, [role]: gender }));
    const choices = voicesFor(voices, gender);
    if (!choices.some(voice => voice.id === draft[role])) set({ [role]: choices[0]?.id ?? draft[role] });
  };
  const listen = (voice: string) => {
    const player = audio.current ?? (audio.current = new Audio());
    if (preview?.voice === voice && preview.playing) { player.pause(); setPreview(null); return; }
    player.onplaying = () => setPreview({ voice, playing: true });
    player.onended = () => setPreview(null);
    player.onerror = () => { setPreview(null); d.notify(t.previewFailed, "error"); };
    player.src = voicePreviewUrl(voice);
    setPreview({ voice, playing: false });
    player.play().catch(() => undefined);
  };
  const save = async () => {
    if (inFlight.current || sameHost || tooLong || empty) return;
    inFlight.current = true;
    setSaving(true);
    const snapshot = { ...draft, readStyle: draft.readStyle.trim(), podcastStyle: draft.podcastStyle.trim() };
    try {
      const result = await saveVoiceSettings(snapshot, d.csrfToken);
      setLoaded(result);
      // Edits made while the save was in flight stay in the draft; only what was sent becomes the baseline.
      setDraft(current => current && same(current, draft) ? result.settings : current);
      d.notify(t.saved);
    } catch (error) {
      d.notify(await errorMessage(error), "error");
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };
  const resetToDefaults = () => {
    setDraft(loaded.defaults);
    setGenders({ readVoice: genderOf(voices, loaded.defaults.readVoice), hostA: genderOf(voices, loaded.defaults.hostA),
      hostB: genderOf(voices, loaded.defaults.hostB) });
  };

  return <section className="more-group voice-settings" aria-labelledby="settings-voices" id="settings-voices-section">
    <h2 id="settings-voices" className="more-heading">{t.heading}</h2>
    <p className="setting-note voice-settings-note">{t.note}</p>
    <ul className="more-list">
      {ROLES.map(role => {
        const label = t.roles[role];
        const invalid = role === "hostB" && sameHost;
        const playing = preview?.voice === draft[role];
        return <li key={role} className="voice-role">
          <div className="voice-role-head">
            <span className="more-label">{label}</span>
            <div className="segmented voice-gender" role="group" aria-label={t.gender(label)}>
              {(["male", "female"] as const).map(gender => <button key={gender} type="button" aria-pressed={genders[role] === gender}
                onClick={() => chooseGender(role, gender)}>{gender === "male" ? t.male : t.female}</button>)}
            </div>
          </div>
          <div className="voice-pick field">
            <select aria-label={t.voice(label)} value={draft[role]} aria-invalid={invalid || undefined}
              aria-describedby={invalid ? "voice-same-host" : undefined} onChange={event => set({ [role]: event.target.value })}>
              {voicesFor(voices, genders[role]).map(voice => <option key={voice.id} value={voice.id}>
                {voice.pitch ? `${voice.name} · ${t.pitch[voice.pitch]}` : voice.name}</option>)}
            </select>
            <button type="button" className="btn btn-outline voice-listen" aria-label={playing && preview?.playing ? t.stop : t.listenTo(name(draft[role]))}
              aria-busy={playing && !preview?.playing ? true : undefined} onClick={() => listen(draft[role])}>
              {playing && preview?.playing ? <Pause size={15} aria-hidden="true" /> : <Play size={15} aria-hidden="true" />}
              {playing && !preview?.playing ? t.loading : playing ? t.stop : t.listen}
            </button>
          </div>
          {invalid && <p id="voice-same-host" className="field-error voice-error" role="alert">{t.sameHost}</p>}
        </li>;
      })}
    </ul>
    <label className="field voice-style">{t.readStyle}
      <textarea rows={2} value={draft.readStyle} maxLength={NARRATION_STYLE_TEXT_MAX} aria-invalid={!draft.readStyle.trim() || undefined}
        onChange={event => set({ readStyle: event.target.value })} />
    </label>
    <label className="field voice-style">{t.podcastStyle}
      <textarea rows={2} value={draft.podcastStyle} maxLength={NARRATION_STYLE_TEXT_MAX} aria-invalid={!draft.podcastStyle.trim() || undefined}
        onChange={event => set({ podcastStyle: event.target.value })} />
      <small>{t.styleHint}</small>
    </label>
    <div className="voice-actions">
      <button type="button" className="btn btn-quiet" onClick={resetToDefaults} disabled={saving || same(draft, loaded.defaults)}>{t.defaults}</button>
      <button type="button" className="btn btn-primary" onClick={() => { void save(); }} disabled={saving || !dirty || sameHost || tooLong || empty}>
        {saving ? t.saving : t.save}</button>
    </div>
  </section>;
}

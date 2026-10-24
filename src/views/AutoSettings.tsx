import { useEffect, useState } from "react";
import type { NarrationAuto } from "../../shared/contracts";
import { errorMessage, loadNarrationAuto, saveNarrationAuto } from "../api";
import { strings } from "../i18n";
import { useDashboard } from "../state";
import { SettingsLoadState } from "./SettingsLoadState";
import { useRateLimited } from "../rate-limit";

type Key = keyof NarrationAuto;
const CHOICES: { readonly [K in Key]: readonly NarrationAuto[K][] } = {
  digests: ["off", "parts", "all"], records: ["off", "read", "podcast"], scope: ["full", "summary"],
};
const KEYS: readonly Key[] = ["digests", "records", "scope"];

const text = strings({
  en: {
    heading: "Automatic audio",
    rows: {
      digests: { label: "Digests", note: "When a digest arrives, audio is made for the parts that changed. It's ready a few minutes later." },
      records: { label: "New records", note: "Audio is made when a record is saved, and made again when its text changes. While this is on, up to 30 audio files can be made a day." },
      scope: { label: "What records read", note: "Summary only reads the conclusion, summary and next steps in a minute or two. Applies to audio made from now on." },
    } satisfies Record<Key, { label: string; note: string }>,
    options: { off: "Off", parts: "Each part", all: "All in one", read: "Read aloud", podcast: "Podcast", full: "Full document", summary: "Summary only" },
  },
  ko: {
    heading: "음성 자동 생성",
    rows: {
      digests: { label: "다이제스트 음성 자동 생성", note: "다이제스트가 올라오면 바뀐 부분의 음성을 만들어요. 몇 분 뒤에 들을 수 있어요." },
      records: { label: "새 기록 음성 자동 생성", note: "기록이 저장되면 음성을 만들고, 내용이 바뀌면 다시 만들어요. 켜 두면 하루에 음성을 30개까지 만들 수 있어요." },
      scope: { label: "기록 듣는 범위", note: "요약만은 결론, 요약, 다음 할 일을 1~2분 안에 읽어요. 다음에 만드는 음성부터 적용돼요." },
    } satisfies Record<Key, { label: string; note: string }>,
    options: { off: "끔", parts: "부분마다 따로", all: "전체 한 음성", read: "낭독", podcast: "팟캐스트", full: "전체 문서", summary: "요약만" },
  },
});

/**
 * Settings › Automatic audio (owner): digest audio on arrival, audio for new records and what a record's audio reads. Each choice
 * is saved the moment it is picked (one save at a time); the control shows what the server holds, and a failed save leaves it unchanged.
 */
export function AutoSettings() {
  const t = text();
  const d = useDashboard();
  const limited = useRateLimited();
  const [saved, setSaved] = useState<NarrationAuto | null>(null);
  const [pending, setPending] = useState<Key | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    setError("");
    loadNarrationAuto().then(value => { if (alive) setSaved(value); }, async (cause: unknown) => {
      const message = await errorMessage(cause);
      if (alive) setError(message);
    });
    return () => { alive = false; };
  }, [attempt]);
  if (!saved) return <SettingsLoadState id="settings-auto" heading={t.heading} error={error} retry={() => setAttempt(value => value + 1)} />;

  const choose = async <K extends Key>(key: K, value: NarrationAuto[K]) => {
    if (pending || limited || saved[key] === value) return;
    setPending(key);
    try { setSaved(await saveNarrationAuto({ ...saved, [key]: value }, d.csrfToken)); }
    catch (error) { d.notify(await errorMessage(error), "error"); }
    finally { setPending(null); }
  };

  return <section className="more-group auto-settings" aria-labelledby="settings-auto">
    <h2 id="settings-auto" className="more-heading">{t.heading}</h2>
    <ul className="more-list">
      {KEYS.map(key => <li key={key} className="voice-role auto-row">
        <span className="more-text">
          <span className="more-label" id={`auto-${key}`}>{t.rows[key].label}</span>
          <span className="setting-note">{t.rows[key].note}</span>
        </span>
        <div className={`segmented auto-choice auto-choice-${CHOICES[key].length}`} role="group" aria-labelledby={`auto-${key}`}
          aria-busy={pending === key || undefined}>
          {CHOICES[key].map(value => <button key={value} type="button" aria-pressed={saved[key] === value} disabled={limited || pending !== null}
            onClick={() => { void choose(key, value); }}>{t.options[value]}</button>)}
        </div>
      </li>)}
    </ul>
  </section>;
}

import { strings } from "../i18n";
import { useRateLimited } from "../rate-limit";

const text = strings({
  en: { loading: "Loading audio settings…", failed: "Couldn't load audio settings.", retry: "Retry" },
  ko: { loading: "음성 설정을 불러오는 중…", failed: "음성 설정을 불러오지 못했어요.", retry: "다시 시도" },
});

export function SettingsLoadState({ id, heading, error, retry }: {
  readonly id: string; readonly heading: string; readonly error: string; readonly retry: () => void;
}) {
  const limited = useRateLimited();
  const t = text();
  return <section className="more-group" aria-labelledby={id}>
    <h2 id={id} className="more-heading">{heading}</h2>
    {error ? <>
      <p className="form-error" role="alert">{t.failed} {error}</p>
      <button type="button" className="btn btn-outline" disabled={limited} onClick={retry}>{t.retry}</button>
    </> : <p className="setting-note" role="status">{t.loading}</p>}
  </section>;
}

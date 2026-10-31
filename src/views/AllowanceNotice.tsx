import { useEffect, useState } from "react";
import type { Allowance } from "../../shared/allowance";
import { loadAllowance } from "../profile-api";
import { errorMessage } from "../api-errors";
import { formatDateTime, strings } from "../i18n";

const text = strings({
  en: { count: (left: number, limit: number) => `${left} of ${limit} starts remaining`,
    reset: (at: string, zone: string) => `Resets ${at} (${zone}). Failed starts count toward this allowance.`,
    cost: "This is an app allowance, not a free Google quota or spending cap. One start may make several provider calls. Your Google project's quotas and billing also apply.",
    loading: "Checking your allowance…", retry: "Retry", quotas: "Google project quotas and limits" },
  ko: { count: (left: number, limit: number) => `시작 한도 ${limit}회 중 ${left}회 남음`,
    reset: (at: string, zone: string) => `${at} (${zone})에 초기화돼요. 실패한 시작도 한도에 포함돼요.`,
    cost: "앱의 시작 한도이며 Google 무료 이용량이나 지출 상한이 아니에요. 한 번의 시작에 여러 제공자 요청이 발생할 수 있고 내 Google 프로젝트의 한도·요금도 적용돼요.",
    loading: "내 한도를 확인하는 중…", retry: "다시 시도", quotas: "Google 프로젝트 한도 안내" },
});
export function AllowanceNotice({ revision }: { readonly revision: string }) {
  const [value, setValue] = useState<Allowance | null>(null);
  const [error, setError] = useState("");
  const t = text();
  const load = () => { setError(""); void loadAllowance().then(setValue, async cause => setError(await errorMessage(cause))); };
  useEffect(load, [revision]);
  return <div className="account-stack" aria-live="polite">
    {value ? <><p><strong>{t.count(value.remaining, value.limit)}</strong></p>
      <p className="setting-note">{t.reset(formatDateTime(value.resetsAt, { timeZone: value.timeZone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }), value.timeZone)}</p></>
      : !error && <p>{t.loading}</p>}
    {error && <><p role="alert">{error}</p><div><button className="btn btn-outline" onClick={load}>{t.retry}</button></div></>}
    <p className="setting-note">{t.cost}</p><a href="https://ai.google.dev/gemini-api/docs/rate-limits" target="_blank" rel="noreferrer">{t.quotas}</a>
  </div>;
}

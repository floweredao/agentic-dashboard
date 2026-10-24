import { useState } from "react";
import type { Account } from "../../shared/account";
import { AccountLocaleSchema } from "../../shared/account";
import { savePreferences } from "../profile-api";
import { choosePreference, localeNames, strings } from "../i18n";
import { errorMessage } from "../api-errors";

const text = strings({
  en: { heading: "Language and calendar", language: "Language", system: "Follow this device",
    zone: "Calendar time zone", note: "Saved to your account and restored when you sign in on any device. Follow this device uses that device's language; there is no separate device override.",
    quota: "Audio allowances reset in the server time zone shown with your allowance, not this calendar setting.", save: "Save preferences", saved: "Preferences saved." },
  ko: { heading: "언어와 날짜", language: "언어", system: "이 기기 설정 따르기",
    zone: "날짜 표시 시간대", note: "계정에 저장하고 어느 기기에서든 로그인하면 적용해요. 기기 설정 따르기는 해당 기기의 언어를 사용하며, 별도의 기기별 덮어쓰기는 없어요.",
    quota: "음성 한도는 이 날짜 설정이 아니라 한도 옆에 표시된 서버 시간대를 기준으로 초기화돼요.", save: "설정 저장", saved: "설정을 저장했어요." },
});
export function AccountPreferences({ account, csrfToken, onAccount }: {
  readonly account: Account; readonly csrfToken: string; readonly onAccount: (account: Account) => void;
}) {
  const t = text();
  const [locale, setLocale] = useState(account.locale);
  const [timeZone, setTimeZone] = useState(account.timeZone);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  return <section className="more-group account-stack" aria-labelledby="account-preferences-heading">
    <h2 id="account-preferences-heading" className="more-heading">{t.heading}</h2>
    <p className="setting-note">{t.note}</p>
    <form className="account-stack" onSubmit={event => {
      event.preventDefault(); setPending(true); setError(""); setMessage("");
      void savePreferences({ locale, timeZone }, csrfToken).then(next => {
        onAccount(next); setMessage(t.saved);
        if (locale !== account.locale) choosePreference(locale);
      }, async cause => setError(await errorMessage(cause))).finally(() => setPending(false));
    }}>
      <label className="field"><span>{t.language}</span><select value={locale} onChange={event => setLocale(AccountLocaleSchema.parse(event.target.value))}>
        <option value="system">{t.system}</option><option value="en">{localeNames.en}</option><option value="ko">{localeNames.ko}</option>
      </select></label>
      <label className="field"><span>{t.zone}</span><input list="account-zones" value={timeZone} onChange={event => setTimeZone(event.target.value)} required maxLength={100} /></label>
      <datalist id="account-zones">{["UTC", ...Intl.supportedValuesOf("timeZone")].map(zone => <option key={zone} value={zone} />)}</datalist>
      <p className="setting-note">{t.quota}</p>
      <div><button className="btn btn-outline" disabled={pending}>{t.save}</button></div>
      {message && <p role="status">{message}</p>}{error && <p role="alert" className="form-error">{error}</p>}
    </form>
  </section>;
}

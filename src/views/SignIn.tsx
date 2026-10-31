import { config } from "../config";
import { strings } from "../i18n";
import "../styles/accounts.css";

const text = strings({
  en: {
    intro: "Your inbox for results from your AI agents.",
    access: "A Google account is required. New accounts are available only while capacity remains.",
    button: "Sign in with Google", privacy: "Privacy", terms: "Terms",
    optional: "Reading and saving do not need a Gemini key.",
  },
  ko: {
    intro: "AI 에이전트의 결과를 모아 읽는 공간이에요.",
    access: "Google 계정이 필요해요. 정원이 남아 있을 때만 새 계정을 만들 수 있어요.",
    button: "Google 계정으로 로그인", privacy: "개인정보처리방침", terms: "이용약관",
    optional: "기록을 읽고 저장하는 데는 Gemini 키가 필요하지 않아요.",
  },
});

export function SignIn() {
  const t = text();
  return <section className="gate account-signin" aria-labelledby="signin-title">
    <img src="/brand-mark.png" alt="" width={56} height={56} />
    <h1 id="signin-title">{config.appName}</h1>
    <p>{t.intro}</p>
    <p>{t.access}</p>
    <a className="google-signin" href="/auth/google/start">
      <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true">
        <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5Z" />
        <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65Z" />
        <path fill="#FBBC05" d="M10.53 28.59A14.4 14.4 0 0 1 9.75 24c0-1.59.27-3.13.76-4.59l-7.98-6.19A23.87 23.87 0 0 0 0 24c0 3.87.93 7.53 2.56 10.78l7.97-6.19Z" />
        <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.91-5.8l-7.73-6c-2.15 1.45-4.92 2.3-8.18 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48Z" />
      </svg>
      {t.button}
    </a>
    <p>{t.optional}</p>
    <nav className="account-legal" aria-label={t.terms}>
      <a href="/privacy">{t.privacy}</a><a href="/terms">{t.terms}</a>
    </nav>
  </section>;
}

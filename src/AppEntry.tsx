import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { Account } from "../shared/account";
import { AccountContext, SetupCredentials } from "./account-context";
import { fetchSession, primeSession, type Session } from "./session-data";
import { errorMessage } from "./api-errors";
import { loadAccount } from "./profile-api";
import { config, configure } from "./config";
import { applyLocale, strings, systemLocale } from "./i18n";
import { entryView } from "./entry-state";
import { SignIn } from "./views/SignIn";
import { SyncNotice } from "./components/SyncNotice";
import "./styles/accounts.css";
import "./styles/onboarding.css";

const Dashboard = lazy(() => import("./App").then(module => ({ default: module.App })));
const Welcome = lazy(() => import("./views/Welcome").then(module => ({ default: module.Welcome })));
const Legal = lazy(() => import("./views/Legal").then(module => ({ default: module.Legal })));
const text = strings({
  en: { loading: "Starting the service…", failed: "Couldn't start the dashboard", retry: "Retry", owner: "Owner key",
    signIn: "Sign in", local: "Sign in with the owner key from your server. The key is not stored in this browser.", dismiss: "Dismiss" },
  ko: { loading: "서비스를 시작하는 중…", failed: "대시보드를 시작하지 못했어요", retry: "다시 시도", owner: "소유자 키",
    signIn: "로그인", local: "서버의 소유자 키로 로그인해 주세요. 키는 이 브라우저에 저장하지 않아요.", dismiss: "닫기" },
});
export function applyAccountPreferences(account: Account) {
  configure({ timeZone: account.timeZone });
  localStorage.setItem("agentic:locale", account.locale);
  applyLocale(account.locale === "system" ? systemLocale() : account.locale);
}
export function AppEntry({ initial, initialError = "", entryPath = location.pathname }: {
  readonly initial: Session | null; readonly initialError?: string; readonly entryPath?: string;
}) {
  const [auth, setAuth] = useState(initial);
  const [error, setError] = useState(initialError);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [key, setKey] = useState("");
  const serverFeatures = useRef({ ...config.features });
  const account = auth?.account ?? null;
  if (account) configure({ features: { digest: serverFeatures.current.digest && account.features.digest } });
  const update = (next: Account) => {
    applyAccountPreferences(next);
    configure({ features: { digest: serverFeatures.current.digest && next.features.digest } });
    setAuth(current => current ? { ...current, account: next } : null);
  };
  const refresh = async () => { if (config.authMode === "google") update(await loadAccount()); };
  const accept = (session: Session) => {
    if (session.account) applyAccountPreferences(session.account);
    primeSession(session);
    setAuth(session);
  };
  useEffect(() => {
    const ended = () => { primeSession(null); setAuth(null); setNotice(""); };
    window.addEventListener("agentic:signed-out", ended);
    return () => window.removeEventListener("agentic:signed-out", ended);
  }, []);
  const run = async (token?: string) => {
    setBusy(true); setError("");
    try { accept(await fetchSession(token)); setKey(""); }
    catch (cause) { setError(await errorMessage(cause)); }
    finally { setBusy(false); }
  };
  const t = text();
  const view = entryView({ path: entryPath, mode: config.authMode, signedIn: auth !== null, onboarded: account?.onboardedAt != null });
  const content = (() => {
    switch (view) {
      case "privacy": case "terms": return <Legal page={view} />;
      case "welcome": return account && auth ? <Welcome account={account} csrfToken={auth.csrfToken} onAccount={update} /> : null;
      case "dashboard": return <Dashboard />;
      case "signin": return <main className="entry-page">
        {config.authMode === "google" ? <SignIn /> : <section className="gate">
          <h1>{config.appName}</h1><p>{t.local}</p>
          <form className="account-stack" onSubmit={event => { event.preventDefault(); void run(key); }}>
            <label className="field"><span>{t.owner}</span><input type="password" autoComplete="off" value={key} required
              onChange={event => setKey(event.target.value)} /></label>
            <button className="btn btn-primary" disabled={busy}>{t.signIn}</button>
          </form>
        </section>}
      </main>;
      default: { const unreachable: never = view; return unreachable; }
    }
  })();
  if (error && !auth && view !== "privacy" && view !== "terms") return <main className="gate" data-startup-error>
    <h1>{t.failed}</h1><p role="alert">{error}</p><button className="btn btn-primary" disabled={busy} onClick={() => void run()}>{t.retry}</button>
  </main>;
  return <AccountContext.Provider value={{ account, refresh, update, resumeDeletion: entryPath === "/delete-confirm" }}>
    <SetupCredentials.Provider value={{ csrfToken: auth?.csrfToken ?? "", refresh, notify: setNotice }}>
      <Suspense fallback={<main className="gate" role="status">{t.loading}</main>}>{content}</Suspense>
      {view === "dashboard" && <SyncNotice />}
      {notice && <div className="toast" role="status"><span>{notice}</span><button onClick={() => setNotice("")}>{t.dismiss}</button></div>}
    </SetupCredentials.Provider>
  </AccountContext.Provider>;
}

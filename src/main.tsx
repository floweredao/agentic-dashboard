import { createRoot } from "react-dom/client";
import { loadConfig } from "./config";
import { applyLocale, detectLocale, followSystemLanguage, strings } from "./i18n";
import { errorMessage, isUnauthorized } from "./api-errors";
import { fetchSession, primeSession } from "./session-data";
import { useRateLimited } from "./rate-limit";
import "./styles/tokens.css";
import "./styles/shell.css";
import "./styles/list.css";
import "./styles/reader.css";
import "./styles/forms.css";
import "./styles/work.css";
import "./styles/views.css";
import "./styles/digest.css";

const text = strings({
  en: { loading: "Starting the service…", failed: "Couldn't start the dashboard", retry: "Retry" },
  ko: { loading: "서비스를 시작하는 중…", failed: "대시보드를 시작하지 못했어요", retry: "다시 시도" },
});
const element = document.getElementById("root");
if (!element) throw new Error("Application root is missing.");
const root = createRoot(element);
function ConfigFailure({ message }: { readonly message: string }) {
  const limited = useRateLimited();
  return <main className="gate" data-startup-error><h1>{text().failed}</h1><p role="alert">{message}</p>
    <button type="button" className="btn btn-primary" disabled={limited} onClick={() => { void start(); }}>{text().retry}</button></main>;
}

async function start() {
  applyLocale(detectLocale());
  root.render(<main className="gate" role="status">{text().loading}</main>);
  const authentication = fetchSession().then(auth => ({ auth, error: "" }), async cause =>
    ({ auth: null, error: isUnauthorized(cause) ? "" : await errorMessage(cause) }));
  try {
    const [, { AppEntry, applyAccountPreferences }, auth, { registerWorker }, { PlaybackProvider }] =
      await Promise.all([loadConfig(), import("./AppEntry"), authentication, import("./push"), import("./components/playback")]);
    applyLocale(detectLocale());
    followSystemLanguage();
    if (auth.auth?.account) applyAccountPreferences(auth.auth.account);
    primeSession(auth.auth);
    const entryPath = location.pathname;
    if (auth.auth && (entryPath === "/account" || entryPath === "/delete-confirm")) history.replaceState(null, "", "/#/settings");
    // The one audio element lives beside the app, outside its routes, so listening goes on across screens.
    root.render(<PlaybackProvider><AppEntry initial={auth.auth} initialError={auth.error} entryPath={entryPath} /></PlaybackProvider>);
    registerWorker();
  } catch (cause) { root.render(<ConfigFailure message={await errorMessage(cause)} />); }
}

void start();

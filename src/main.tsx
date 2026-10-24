import { createRoot } from "react-dom/client";
import { loadConfig } from "./config";
import { applyLocale, detectLocale, followSystemLanguage, strings } from "./i18n";
import { errorMessage } from "./api";
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
  try { await loadConfig(); }
  catch (cause) { root.render(<ConfigFailure message={await errorMessage(cause)} />); return; }
  applyLocale(detectLocale());
  followSystemLanguage();
  // The app loads after the language is known, so labels built when its modules load are in that language.
  const [{ App }, { registerWorker }, { PlaybackProvider }] = await Promise.all([import("./App"), import("./push"), import("./components/playback")]);
  // The one audio element lives beside the app, outside its routes, so listening goes on across screens.
  root.render(<PlaybackProvider><App /></PlaybackProvider>);
  registerWorker();
}

void start();

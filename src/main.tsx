import { createRoot } from "react-dom/client";
import { loadConfig } from "./config";
import { applyLocale, detectLocale, followSystemLanguage } from "./i18n";
import "./styles/tokens.css";
import "./styles/shell.css";
import "./styles/list.css";
import "./styles/reader.css";
import "./styles/forms.css";
import "./styles/work.css";
import "./styles/views.css";
import "./styles/digest.css";

async function start() {
  const root = document.getElementById("root");
  if (!root) throw new Error("Application root is missing.");
  // Without the config the app still works with its defaults; the reason goes to the console.
  await loadConfig().catch((error: unknown) => console.error("Could not load /api/v1/config, using defaults.", error));
  applyLocale(detectLocale());
  followSystemLanguage();
  // The app loads after the language is known, so labels built when its modules load are in that language.
  const [{ App }, { registerWorker }] = await Promise.all([import("./App"), import("./push")]);
  createRoot(root).render(<App />);
  registerWorker();
}

void start();

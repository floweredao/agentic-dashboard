import { createRoot } from "react-dom/client";
import { App } from "./App";
import { registerWorker } from "./push";
import "./styles/tokens.css";
import "./styles/shell.css";
import "./styles/list.css";
import "./styles/reader.css";
import "./styles/forms.css";
import "./styles/work.css";
import "./styles/views.css";
import "./styles/digest.css";

const root = document.getElementById("root");
if (!root) throw new Error("Application root is missing.");
createRoot(root).render(<App />);
registerWorker();

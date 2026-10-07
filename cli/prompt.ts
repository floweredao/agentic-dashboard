import { createInterface } from "node:readline/promises";
import { t } from "./i18n";

export const say = (text = "") => process.stdout.write(`${text}\n`);
/** Questions are only asked on a real terminal; scripts, agents and pipes get flags and defaults instead. */
export const interactive = () => Boolean(process.stdin.isTTY && process.stdout.isTTY) && !process.env["CI"];

export async function ask(question: string, fallback = ""): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on("SIGINT", () => { rl.close(); process.stdout.write("\n"); process.exit(130); });
  try {
    const answer = (await rl.question(`${question}${fallback ? ` [${fallback}]` : ""}: `)).trim();
    return answer || fallback;
  } finally {
    rl.close();
  }
}

export async function confirm(question: string, fallback: boolean): Promise<boolean> {
  for (;;) {
    const answer = (await ask(`${question} ${fallback ? t("yesNo") : t("noYes")}`)).toLowerCase();
    if (!answer) return fallback;
    if (["y", "yes", "예", "네", "ㅇ"].includes(answer)) return true;
    if (["n", "no", "아니오", "아니요", "ㄴ"].includes(answer)) return false;
  }
}

export async function choose(question: string, options: readonly string[], fallback = 0): Promise<number> {
  say(question);
  options.forEach((option, index) => say(`  ${index + 1}. ${option}`));
  for (;;) {
    const answer = await ask(t("choose"), String(fallback + 1));
    const index = Number(answer) - 1;
    if (Number.isInteger(index) && index >= 0 && index < options.length) return index;
    say(t("chooseInvalid"));
  }
}

/** Reads a line without echoing it, for keys. */
export function askSecret(question: string): Promise<string> {
  const input = process.stdin;
  process.stdout.write(`${question}: `);
  input.setRawMode(true);
  input.resume();
  return new Promise(resolve => {
    let value = "";
    const finish = () => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
      process.stdout.write("\n");
      resolve(value.trim());
    };
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\r" || char === "\n") return finish();
        if (char === "\u0003") { input.setRawMode(false); process.stdout.write("\n"); process.exit(130); }
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else if (char >= " ") value += char;
      }
    };
    input.on("data", onData);
  });
}

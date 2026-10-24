import { strings } from "../shared/strings";

const text = strings({
  en: {
    capacity: "Sign-ups are full", failed: "Sign-in could not be completed",
    full: "Existing accounts can still sign in. While new accounts are at capacity, you can host your own dashboard.",
    retry: "Please start sign-in again.", host: "Self-hosting guide", back: "Back to sign-in",
  },
  ko: {
    capacity: "지금은 가입이 마감되었습니다", failed: "로그인을 완료하지 못했습니다",
    full: "기존 계정은 계속 이용할 수 있습니다. 새 계정을 위한 자리가 생길 때까지 직접 호스팅할 수 있습니다.",
    retry: "로그인을 처음부터 다시 시작해 주세요.", host: "직접 호스팅 안내", back: "로그인 화면",
  },
});

/** Public failures contain no callback values, provider responses or user identity. */
export function authPage(capacity: boolean, korean: boolean) {
  const t = text(korean ? "ko" : "en");
  const title = capacity ? t.capacity : t.failed;
  return `<!doctype html><html lang="${korean ? "ko" : "en"}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><link rel="stylesheet" href="/auth.css"><body><main><h1>${title}</h1><p>${capacity ? t.full : t.retry}</p><p><a href="https://github.com/floweredao/agentic-dashboard">${t.host}</a></p>${capacity ? "" : `<a href="/">${t.back}</a>`}</main></body></html>`;
}

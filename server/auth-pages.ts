/** Public failures contain no callback values, provider responses or user identity. */
export function authPage(capacity: boolean, korean: boolean) {
  const title = capacity ? (korean ? "지금은 가입이 마감되었습니다" : "Sign-ups are full")
    : (korean ? "로그인을 완료하지 못했습니다" : "Sign-in could not be completed");
  const body = capacity ? (korean ? "기존 계정은 계속 이용할 수 있습니다. 새 계정을 위한 자리가 생길 때까지 직접 호스팅할 수 있습니다." : "Existing accounts can still sign in. While new accounts are at capacity, you can host your own dashboard.")
    : (korean ? "로그인을 처음부터 다시 시작해 주세요." : "Please start sign-in again.");
  return `<!doctype html><html lang="${korean ? "ko" : "en"}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body><main><h1>${title}</h1><p>${body}</p><p><a href="https://github.com/floweredao/agentic-dashboard">${korean ? "직접 호스팅 안내" : "Self-hosting guide"}</a></p>${capacity ? "" : `<a href="/">${korean ? "로그인 화면" : "Back to sign-in"}</a>`}</main></body></html>`;
}

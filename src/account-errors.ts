import { strings } from "./i18n";

export const accountErrorText = strings({
  en: {
    gemini_key_required: "Add your Gemini key in Settings to generate audio. Reading and saving still work.",
    gemini_key_invalid: "Google did not accept that key. Replace it in Gemini key settings.",
    reauth_required: "Sign in with Google again to continue this action.",
    signup_capacity: "Sign-ups are full. Existing accounts can still sign in.",
    operator: "The service's audio provider needs attention from the operator. You do not need to change server credentials.",
    settings: "Gemini key settings", signIn: "Sign in again", capacity: "View availability",
  },
  ko: {
    gemini_key_required: "음성을 만들려면 설정에 내 Gemini 키를 추가해 주세요. 기록을 읽고 저장하는 기능은 계속 쓸 수 있어요.",
    gemini_key_invalid: "Google이 키를 승인하지 않았어요. Gemini 키 설정에서 바꿔 주세요.",
    reauth_required: "이 작업을 계속하려면 Google 계정으로 다시 로그인해 주세요.",
    signup_capacity: "지금은 가입 정원이 찼어요. 기존 계정은 계속 로그인할 수 있어요.",
    operator: "서비스의 음성 제공자 설정을 운영자가 확인해야 해요. 서버 인증 정보를 직접 바꿀 필요는 없어요.",
    settings: "Gemini 키 설정", signIn: "다시 로그인", capacity: "가입 가능 여부",
  },
});

export function accountErrorMessage(code: string) {
  const t = accountErrorText();
  switch (code) {
    case "gemini_key_required": return t.gemini_key_required;
    case "gemini_key_invalid": return t.gemini_key_invalid;
    case "reauth_required": return t.reauth_required;
    case "signup_capacity": return t.signup_capacity;
    default: return undefined;
  }
}
export function accountErrorAction(code: string | null) {
  const t = accountErrorText();
  switch (code) {
    case "gemini_key_required": case "gemini_key_invalid": case "no_key": case "http_401": case "http_403":
      return { href: "#/settings?section=gemini", label: t.settings };
    case "reauth_required": return { href: "/auth/google/start", label: t.signIn };
    case "signup_capacity": return { href: "/auth/capacity", label: t.capacity };
    default: return null;
  }
}
export function audioRecovery(code: string | null, mode: "local" | "google") {
  if (code === "vertex_auth" || code === "vertex_disabled") return mode === "google" ? "operator" : "admin";
  if (mode === "google" && (code === "no_key" || code === "http_401" || code === "http_403" || code === "gemini_key_required")) return "key";
  return null;
}

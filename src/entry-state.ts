export function entryView(input: {
  readonly path: string; readonly mode: "google" | "local"; readonly signedIn: boolean; readonly onboarded: boolean;
}): "privacy" | "terms" | "signin" | "welcome" | "dashboard" {
  if (input.path === "/privacy") return "privacy";
  if (input.path === "/terms") return "terms";
  if (!input.signedIn) return "signin";
  if (input.path === "/account" || input.path === "/delete-confirm") return "dashboard";
  switch (input.mode) {
    case "google": return !input.onboarded || input.path === "/welcome" ? "welcome" : "dashboard";
    case "local": return "dashboard";
    default: { const unreachable: never = input.mode; return unreachable; }
  }
}

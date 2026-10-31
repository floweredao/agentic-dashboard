import { expect, test } from "bun:test";
import { entryView } from "./entry-state";

test("signed-out entry never mounts dashboard navigation", () => {
  // Given/When: either authentication mode without a session.
  for (const mode of ["local", "google"] as const) {
    // Then: only the sign-in surface is selected.
    expect(entryView({ path: "/", mode, signedIn: false, onboarded: false })).toBe("signin");
  }
});
test("new hosted accounts enter setup but returning accounts keep dashboard routing", () => {
  // Given/When/Then: only an incomplete hosted account or explicit replay selects setup.
  expect(entryView({ path: "/", mode: "google", signedIn: true, onboarded: false })).toBe("welcome");
  expect(entryView({ path: "/", mode: "google", signedIn: true, onboarded: true })).toBe("dashboard");
  expect(entryView({ path: "/welcome", mode: "google", signedIn: true, onboarded: true })).toBe("welcome");
  expect(entryView({ path: "/", mode: "local", signedIn: true, onboarded: false })).toBe("dashboard");
});
test("legal routes remain public without mounting the signed-in dashboard", () => {
  // Given/When/Then: policy and terms do not depend on authentication.
  expect(entryView({ path: "/privacy", mode: "google", signedIn: false, onboarded: false })).toBe("privacy");
  expect(entryView({ path: "/terms", mode: "google", signedIn: false, onboarded: false })).toBe("terms");
});

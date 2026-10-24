import { afterEach, expect, test } from "bun:test";
import { accountErrorAction, audioRecovery } from "./account-errors";
import { configure } from "./config";
import { narrationItems } from "./components/Listen";
import { NarrationStateSchema } from "../shared/contracts";

afterEach(() => configure({ authMode: "local" }));

test("hosted key and session errors route to their actual recovery destinations", () => {
  expect(accountErrorAction("gemini_key_required")?.href).toBe("#/settings?section=gemini");
  expect(accountErrorAction("gemini_key_invalid")?.href).toBe("#/settings?section=gemini");
  expect(accountErrorAction("reauth_required")?.href).toBe("/auth/google/start");
  expect(accountErrorAction("signup_capacity")?.href).toBe("/auth/capacity");
});

test("hosted provider credential failures belong to the operator rather than the reader", () => {
  expect(audioRecovery("vertex_auth", "google")).toBe("operator");
  expect(audioRecovery("vertex_disabled", "google")).toBe("operator");
  expect(audioRecovery("vertex_auth", "local")).toBe("admin");
  expect(audioRecovery("http_401", "google")).toBe("key");
  expect(audioRecovery("http_403", "google")).toBe("permission");
  expect(audioRecovery("http_404", "google")).toBe("model");
});

test("a hosted reader can open key settings from the unavailable-audio command", () => {
  configure({ authMode: "google" });
  const noop = () => {};
  const items = narrationItems({ available: false, narration: null }, {
    pending: false, cancelling: false, onRequest: noop, onMake: noop, onCancel: noop, onListen: noop, onScript: noop, onRemove: noop,
  });
  expect(items[0]?.disabled).not.toBe(true);
  const original = Object.getOwnPropertyDescriptor(globalThis, "location");
  const target = new URL("http://localhost/");
  Object.defineProperty(globalThis, "location", { configurable: true, value: target });
  try {
    items[0]?.onSelect();
    expect(target.hash).toBe("#/settings?section=gemini");
  } finally {
    if (original) Object.defineProperty(globalThis, "location", original);
    else Reflect.deleteProperty(globalThis, "location");
  }
});

test("removing a hosted key does not remove playback or cancellation controls", () => {
  configure({ authMode: "google" });
  const noop = () => {};
  const onListen = () => {};
  const onCancel = () => {};
  const options = { pending: false, cancelling: false, onRequest: noop, onMake: noop, onCancel, onListen, onScript: noop, onRemove: noop };
  const narration = {
    recordId: crypto.randomUUID(), style: "read", status: "ready", stale: false, progress: null, waitUntil: null, stepAt: null,
    attempts: 1, error: null, requestedBy: "owner", requestedAt: "2026-10-24T00:00:00Z", updatedAt: "2026-10-24T00:00:00Z", script: "A saved script.",
    audio: { url: "/audio", mime: "audio/wav", bytes: 100, durationMs: 1000, model: "test", voice: "Kore", style: "read", createdAt: "2026-10-24T00:00:00Z" },
  };
  const saved = NarrationStateSchema.parse({ available: false, narration });
  expect(narrationItems(saved, options).some(item => item.onSelect === onListen)).toBe(true);
  const running = NarrationStateSchema.parse({ available: false, narration: { ...narration, status: "speaking", audio: null } });
  expect(narrationItems(running, options).some(item => item.onSelect === onCancel)).toBe(true);
});

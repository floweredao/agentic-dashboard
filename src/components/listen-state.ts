import type { NarrationState, NarrationStatus } from "../../shared/contracts";
const WORKING: ReadonlySet<NarrationStatus> = new Set(["queued", "scripting", "speaking"]);
const dismissKey = (recordId: string) => `agentic:listen-dismissed:${recordId}`;
const stored = (key: string) => typeof localStorage === "undefined" ? null : localStorage.getItem(key);
type Failure = Pick<NonNullable<NarrationState["narration"]>, "updatedAt" | "error" | "audio">;
/** A failure is the same one while its reason and the audio it left are: a retry that fails again the same way is not new. */
const failureKey = (failure: Failure) => `${failure.error ?? ""}|${failure.audio?.url ?? ""}`;

/**
 * Whether the owner already closed this failure here. It stays closed on every visit, and when a retry fails again for the
 * same reason on the same audio; another reason or new audio shows again. A value saved as the failure's time still counts.
 */
export function failureDismissed(recordId: string, failure: Failure | null | undefined, read: (key: string) => string | null = stored): boolean {
  if (!failure) return false;
  const saved = read(dismissKey(recordId));
  return saved !== null && (saved === failureKey(failure) || saved === failure.updatedAt);
}
export function rememberDismissed(recordId: string, failure: Failure, write: (key: string, value: string) => void = (key, value) => localStorage.setItem(key, value)) {
  write(dismissKey(recordId), failureKey(failure));
}

export const working = (state: NarrationState | null) => state?.narration ? WORKING.has(state.narration.status) : false;
export const failedFor = (state: NarrationState | null) => state?.narration?.status === "failed" && state.narration.error !== "cancelled";

import ky from "ky";
import { z } from "zod";
import { AccountPreferencesSchema, AccountSchema, type AccountPreferences } from "../shared/account";
import { AllowanceSchema } from "../shared/allowance";

const http = ky.create({ prefixUrl: "/api/v1", credentials: "same-origin", retry: 0, timeout: 15000 });
const response = z.object({ account: AccountSchema });
export async function loadAccount() { return response.parse(await http.get("account").json()).account; }
export async function verifyAgentSave() {
  const account = await loadAccount();
  if (account.agentSaveRecordId) await http.get(`records/${encodeURIComponent(account.agentSaveRecordId)}`).json();
  return account;
}
export async function savePreferences(input: AccountPreferences, csrfToken: string) {
  return response.parse(await http.patch("account/preferences", {
    json: AccountPreferencesSchema.parse(input), headers: { "X-CSRF-Token": csrfToken },
  }).json()).account;
}
export async function finishOnboarding(csrfToken: string) {
  return response.parse(await http.post("onboarding/done", { json: {}, headers: { "X-CSRF-Token": csrfToken } }).json()).account;
}
export async function removeAccount(confirm: string, csrfToken: string) {
  await http.delete("account", { json: { confirm }, headers: { "X-CSRF-Token": csrfToken } });
}
export async function loadAllowance() { return AllowanceSchema.parse(await http.get("narration/allowance").json()); }

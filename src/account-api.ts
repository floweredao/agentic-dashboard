import ky from "ky";
import { z } from "zod";
import { DashboardRecordSchema, type RecordInput } from "../shared/contracts";

const http = ky.create({ prefixUrl: "/api/v1", credentials: "same-origin", retry: 0, timeout: 15000 });
const agent = z.object({ name: z.string(), capture: z.boolean(), createdAt: z.string().nullable(), lastUsedAt: z.string().nullable(), revokedAt: z.string().nullable() });
const issued = z.object({ agent, key: z.string() });
const modelStatus = z.object({ name: z.string(), listed: z.boolean() });
const keyStatus = z.object({ configured: z.boolean(), last4: z.string().nullable(),
  modelAvailability: z.object({ script: modelStatus, speech: modelStatus }).optional() });
export type AccountAgent = z.infer<typeof agent>;
export type IssuedAgent = z.infer<typeof issued>;
export type KeyStatus = z.infer<typeof keyStatus>;

export async function accountAgents() { return z.object({ items: z.array(agent) }).parse(await http.get("agents").json()).items; }
export async function createAgent(input: { readonly name: string; readonly capture: boolean }, csrfToken: string) {
  return issued.parse(await http.post("agents", { json: input, headers: { "X-CSRF-Token": csrfToken } }).json());
}
export async function inviteAgent(name: string, csrfToken: string) {
  return z.object({ agent: z.string(), code: z.string(), expiresAt: z.string() }).parse(await http.post("agents/invites", {
    json: { name }, headers: { "X-CSRF-Token": csrfToken },
  }).json());
}
export async function rotateAgent(name: string, csrfToken: string) {
  return issued.parse(await http.post(`agents/${encodeURIComponent(name)}/rotate`, { headers: { "X-CSRF-Token": csrfToken } }).json());
}
export async function revokeAgent(name: string, csrfToken: string) {
  await http.delete(`agents/${encodeURIComponent(name)}`, { headers: { "X-CSRF-Token": csrfToken } });
}
export async function testAgent(key: string, record: RecordInput) {
  const saved = z.object({ record: DashboardRecordSchema }).parse(await http.post("records", {
    credentials: "omit", headers: { Authorization: `Bearer ${key}` }, json: { requestId: crypto.randomUUID(), record },
  }).json()).record;
  // Verify the saved id through the owner's actual read API, not a copied token or last-used timestamp.
  return z.object({ record: DashboardRecordSchema }).parse(await http.get(`records/${saved.id}`).json()).record;
}
export async function getGemini() { return keyStatus.parse(await http.get("settings/gemini").json()); }
export async function saveGemini(key: string, csrfToken: string) {
  return keyStatus.parse(await http.put("settings/gemini", { json: { key }, headers: { "X-CSRF-Token": csrfToken } }).json());
}
export async function removeGemini(csrfToken: string) {
  await http.delete("settings/gemini", { headers: { "X-CSRF-Token": csrfToken } });
}

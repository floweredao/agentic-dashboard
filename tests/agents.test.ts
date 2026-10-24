import { afterAll, afterEach, expect, test } from "bun:test";
import { z } from "zod";
import { agentRecord, bearer, fixture, payload, recordResult } from "./backend-helper";

let f = (await fixture());
afterEach(async () => { (await f.close()); f = (await fixture()); });
afterAll(async () => (await f.close()));
const auth = (key: string) => ({ Authorization: `Bearer ${key}` });
const save = (key: string) => f.call("/api/v1/records", "POST", payload(agentRecord()), auth(key));

test("an added agent saves under its own name and is listed for the owner only", async () => {
  const key = (await f.app.agents.add("research-bot"));
  const response = await save(key);
  expect(response.status).toBe(201);
  const record = recordResult.parse(await response.json()).record;
  expect([record.source, record.createdBy]).toEqual(["research-bot", "research-bot"]);
  const listed = z.object({ items: z.array(z.object({ name: z.string(), lastUsedAt: z.string().nullable() })) })
    .parse(await (await f.call("/api/v1/agents", "GET", undefined, await f.login())).json());
  expect(listed.items.find(item => item.name === "research-bot")?.lastUsedAt).not.toBeNull();
  expect((await f.call("/api/v1/agents", "GET", undefined, auth(key))).status).toBe(403);
});

test("a removed agent's key stops working at once and cannot be rotated", async () => {
  const key = (await f.app.agents.add("helper"));
  (await f.app.agents.revoke("helper"));
  expect((await save(key)).status).toBe(401);
  await expect(f.app.agents.rotate("helper")).rejects.toMatchObject({ status: 409, code: "agent_revoked" });
  expect((await save(key)).status).toBe(401);
});

test("rotating an active agent replaces its key", async () => {
  const key = (await f.app.agents.add("helper"));
  const rotated = (await f.app.agents.rotate("helper"));
  expect((await save(key)).status).toBe(401);
  expect((await save(rotated)).status).toBe(201);
});

test("names are validated, unique and never the owner's", async () => {
  for (const name of ["manual", "owner", "Upper", "1st", "has space", ""]) await expect(f.app.agents.add(name)).rejects.toThrow();
  (await f.app.agents.add("twice"));
  await expect(f.app.agents.add("twice")).rejects.toThrow("already exists");
  await expect(f.app.agents.rotate("owner")).rejects.toThrow("No agent");
  await expect(f.app.agents.revoke("nobody")).rejects.toThrow("No agent");
});

test("config needs no sign-in and turned-off features answer 404", async () => {
  const off = (await fixture(10000, Date.now, { pushEnabled: false, digestEnabled: false, appName: "Team Desk" }));
  try {
    expect(await (await off.call("/api/v1/config")).json()).toEqual({ appName: "Team Desk", version: "0.4.0", timeZone: "Asia/Seoul", locale: "en", authMode: "local",
      features: { narration: false, push: false, digest: false, trustedLogin: false, demo: false } });
    expect((await off.call("/api/v1/push", "GET", undefined, await off.login())).status).toBe(404);
    expect((await off.call("/api/v1/digests", "GET", undefined, bearer("omo"))).status).toBe(404);
  } finally { (await off.close()); }
});

test("the owner key cannot act as an agent and agents cannot delete", async () => {
  expect((await f.call("/api/v1/records", "POST", payload(agentRecord()), bearer("owner"))).status).toBe(403);
  const created = recordResult.parse(await (await save((await f.app.agents.add("deleter")))).json()).record;
  expect((await f.call(`/api/v1/records/${created.id}`, "DELETE", { expectedVersion: 1 }, bearer("codex"))).status).toBe(403);
});

import { afterEach, expect, test } from "bun:test";
import { z } from "zod";
import { agentRecord, bearer, fixture, payload, recordResult } from "./backend-helper";

let f = fixture();
afterEach(() => { f.close(); f = fixture(); });
const auth = (key: string) => ({ Authorization: `Bearer ${key}` });
const save = (key: string) => f.call("/api/v1/records", "POST", payload(agentRecord()), auth(key));

test("an added agent saves under its own name and is listed for the owner only", async () => {
  const key = f.app.agents.add("research-bot");
  const response = await save(key);
  expect(response.status).toBe(201);
  const record = recordResult.parse(await response.json()).record;
  expect([record.source, record.createdBy]).toEqual(["research-bot", "research-bot"]);
  const listed = z.object({ items: z.array(z.object({ name: z.string(), lastUsedAt: z.string().nullable() })) })
    .parse(await (await f.call("/api/v1/agents", "GET", undefined, await f.login())).json());
  expect(listed.items.find(item => item.name === "research-bot")?.lastUsedAt).not.toBeNull();
  expect((await f.call("/api/v1/agents", "GET", undefined, auth(key))).status).toBe(403);
});

test("a removed agent's key stops working at once and rotating issues a new one", async () => {
  const key = f.app.agents.add("helper");
  f.app.agents.revoke("helper");
  expect((await save(key)).status).toBe(401);
  const rotated = f.app.agents.rotate("helper");
  expect((await save(key)).status).toBe(401);
  expect((await save(rotated)).status).toBe(201);
});

test("names are validated, unique and never the owner's", () => {
  for (const name of ["manual", "owner", "Upper", "1st", "has space", ""]) expect(() => f.app.agents.add(name)).toThrow();
  f.app.agents.add("twice");
  expect(() => f.app.agents.add("twice")).toThrow("already exists");
  expect(() => f.app.agents.rotate("owner")).toThrow("No agent");
  expect(() => f.app.agents.revoke("nobody")).toThrow("No agent");
});

test("config needs no sign-in and turned-off features answer 404", async () => {
  const off = fixture(10000, Date.now, { pushEnabled: false, digestEnabled: false, appName: "Team Desk" });
  try {
    expect(await (await off.call("/api/v1/config")).json()).toEqual({ appName: "Team Desk", timeZone: "Asia/Seoul", locale: "en",
      features: { narration: false, push: false, digest: false, trustedLogin: false } });
    expect((await off.call("/api/v1/push", "GET", undefined, await off.login())).status).toBe(404);
    expect((await off.call("/api/v1/briefings", "GET", undefined, bearer("omo"))).status).toBe(404);
  } finally { off.close(); }
});

test("the owner key cannot act as an agent and agents cannot delete", async () => {
  expect((await f.call("/api/v1/records", "POST", payload(agentRecord()), bearer("owner"))).status).toBe(403);
  const created = recordResult.parse(await (await save(f.app.agents.add("deleter"))).json()).record;
  expect((await f.call(`/api/v1/records/${created.id}`, "DELETE", { expectedVersion: 1 }, bearer("codex"))).status).toBe(403);
});

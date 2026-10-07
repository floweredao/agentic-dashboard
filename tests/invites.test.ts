import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { z } from "zod";
import { createApp } from "../server/app";
import { INVITE_TTL_MS } from "../server/invites";
import { agentRecord, fixture, payload } from "./backend-helper";

let clock = Date.parse("2026-10-07T10:00:00Z");
let f = fixture(10000, () => clock);
afterEach(() => { f.close(); clock = Date.parse("2026-10-07T10:00:00Z"); f = fixture(10000, () => clock); });
const connected = z.object({ agent: z.string(), key: z.string().min(32) }).strict();
const redeem = (code: string, publicOnly = false) => f.call("/api/v1/agents/connect", "POST", { code }, {}, publicOnly);
const errorCode = async (response: Response) => z.object({ error: z.object({ code: z.string() }) }).parse(await response.json()).error.code;

test("a connection code registers the agent once and its key saves records", async () => {
  const invite = f.app.invites.create("laptop-codex");
  expect(invite.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
  expect(invite.expiresAt).toBe(new Date(clock + INVITE_TTL_MS).toISOString());
  expect(f.app.agents.get("laptop-codex")).toBeNull();
  const response = await redeem(invite.code.toLowerCase());
  expect(response.status).toBe(201);
  const { agent, key } = connected.parse(await response.json());
  expect(agent).toBe("laptop-codex");
  const saved = await f.call("/api/v1/records", "POST", payload(agentRecord()), { Authorization: `Bearer ${key}` });
  expect(saved.status).toBe(201);
  const again = await redeem(invite.code);
  expect([again.status, await errorCode(again)]).toEqual([404, "invite_invalid"]);
});

test("unknown, expired and malformed codes are refused alike, and only a hash is stored", async () => {
  const invite = f.app.invites.create("late-agent");
  expect(JSON.stringify(f.app.agents.list())).not.toContain(invite.code);
  const db = new Database(f.options.databasePath, { readonly: true });
  const stored = db.query("SELECT * FROM agent_invites").all();
  db.close();
  expect(stored).toHaveLength(1);
  expect(JSON.stringify(stored)).not.toContain(invite.code);
  expect(JSON.stringify(stored)).not.toContain(invite.code.replaceAll("-", ""));
  clock += INVITE_TTL_MS;
  const expired = await redeem(invite.code);
  expect([expired.status, await errorCode(expired)]).toEqual([404, "invite_invalid"]);
  expect(f.app.agents.get("late-agent")).toBeNull();
  const unknown = await redeem("0000-0000-0000-0000");
  expect([unknown.status, await errorCode(unknown)]).toEqual([404, "invite_invalid"]);
  expect((await redeem("")).status).toBe(400);
});

test("a code cannot be issued for a registered or invalid name, and a later code replaces an earlier one", async () => {
  expect(() => f.app.invites.create("codex")).toThrow("already exists");
  expect(() => f.app.invites.create("Not Valid")).toThrow();
  const first = f.app.invites.create("desk");
  const second = f.app.invites.create("desk");
  expect((await redeem(first.code)).status).toBe(404);
  expect((await redeem(second.code)).status).toBe(201);
});

test("the agent ingress and the demo never redeem codes", async () => {
  const invite = f.app.invites.create("outside");
  expect((await redeem(invite.code, true)).status).toBe(404);
  const demo = createApp({ ...f.options, demo: true });
  try {
    const response = await demo.fetch(new Request("http://127.0.0.1:4310/api/v1/agents/connect", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: invite.code }),
    }));
    expect(response.status).toBe(403);
  } finally { demo.close(); }
  expect((await redeem(invite.code)).status).toBe(201);
});

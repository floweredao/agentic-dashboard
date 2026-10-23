import { afterEach, expect, test } from "bun:test";
import { z } from "zod";
import { agentRecord, bearer, fixture, origin, payload, recordResult } from "./backend-helper";

// CONTRACT.md promises that had no test of their own, one test per claim, in the order the document makes them.

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });
function setup(...args: Parameters<typeof fixture>) {
  const f = fixture(...args);
  cleanups.push(() => f.close());
  return f;
}
const errorBody = z.object({ error: z.object({ code: z.string(), message: z.string(), details: z.array(z.unknown()).optional() }).strict() }).strict();
const error = async (response: Response) => ({ status: response.status, ...errorBody.parse(await response.json()).error });
const created = z.object({ record: recordResult.shape.record, replayed: z.boolean() }).strict();
const DAY = 24 * 60 * 60 * 1000;

test("RecordInput: status is 1..50 characters; agents keep other kinds new while the owner's plain schema takes any status", async () => {
  const f = setup();
  const owner = await f.login();
  const note = await f.call("/api/v1/records", "POST", payload({ kind: "note", title: "Owner note", status: " read " }), owner);
  expect(created.parse(await note.json()).record.status).toBe("read");
  for (const status of ["", " ", "s".repeat(51)]) {
    expect(await error(await f.call("/api/v1/records", "POST", payload({ kind: "note", title: "Bad", status }), owner))).toMatchObject({ status: 400, code: "invalid_input" });
  }
  const agent = await error(await f.call("/api/v1/records", "POST", payload(agentRecord({ kind: "note", status: "read" })), bearer("omo")));
  expect(agent).toMatchObject({ status: 400, code: "record_incomplete" });
  expect(agent.message).toContain("status: leave it unset for this kind");
});

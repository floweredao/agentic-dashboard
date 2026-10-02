import { afterAll, afterEach, expect, test } from "bun:test";
import { z } from "zod";
import { agentRecord, bearer, fixture, payload, recordResult } from "./backend-helper";

let f = fixture();
afterEach(() => { f.close(); f = fixture(); });
afterAll(() => f.close());

const errorBody = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
const count = async () => z.object({ items: z.array(z.unknown()) })
  .parse(await (await f.call("/api/v1/records?archived=all", "GET", undefined, await f.login())).json()).items.length;

test("every agent gets one record_incomplete error listing each missing part, and nothing is saved", async () => {
  for (const source of ["codex", "omo", "chatgpt"] as const) {
    // Given: a research record with only a kind and a title, the shape agents used to send.
    // When: the agent saves it.
    const response = await f.call("/api/v1/records", "POST", payload({ kind: "research", title: "요약 없는 조사" }), bearer(source));
    // Then: it is refused with every missing part named at once.
    expect(response.status).toBe(400);
    const { error } = errorBody.parse(await response.json());
    expect(error.code).toBe("record_incomplete");
    for (const part of ["body:", "tags:", "fields.summary: required", "fields.conclusion: required", "fields.nextActions: required"]) expect(error.message).toContain(part);
  }
  expect(await count()).toBe(0);
});

test("tags, field keys, one-line conclusions, action lists and link names follow one format", async () => {
  // Given: a research record whose parts are all present but written in each agent's own style.
  const styled = agentRecord({
    tags: ["#AI", "멀티 에이전트", "AI", "ai", "b", "c"],
    status: "done",
    links: [{ label: "", url: "https://example.com/" }],
    fields: { conclusion: "첫 줄\n둘째 줄", nextActions: "1) 확인\n2) 적용", summary: "1\n2\n3\n4", verificationStatus: "검증 필요" },
  });
  // When: omo saves it.
  const response = await f.call("/api/v1/records", "POST", payload(styled), bearer("omo"));
  // Then: each deviation is reported, so the agent can rewrite them in one retry.
  expect(response.status).toBe(400);
  const { error } = errorBody.parse(await response.json());
  for (const part of ["status:", "links.0.label", "tags: give 1-5", "tags.0: one word", "tags.1: one word", "tags.3: duplicate", "fields.verificationStatus: not part of the research format",
    "fields.summary: at most 3 lines", "fields.conclusion: one line", "fields.nextActions: one action per line"]) expect(error.message).toContain(part);
});

test("social links need a link and a summary, notes need a body, and complete records save for every kind", async () => {
  const social = await f.call("/api/v1/records", "POST", payload({ kind: "social", title: "링크", tags: ["링크"] }), bearer("codex"));
  expect(errorBody.parse(await social.json()).error.message).toMatch(/links: include the original link.*fields\.summary: required/);
  const note = await f.call("/api/v1/records", "POST", payload({ kind: "note", title: "메모", tags: ["메모"] }), bearer("codex"));
  expect(errorBody.parse(await note.json()).error.message).toContain("body: write the detailed content");
  for (const record of [
    agentRecord(), agentRecord({ kind: "work-report" }), agentRecord({ kind: "note" }),
    agentRecord({ kind: "social", links: [{ label: "원문", url: "https://example.com/a" }] }),
    agentRecord({ kind: "task", status: "todo", fields: { today: true } }), agentRecord({ kind: "project", status: "active", fields: { nextAction: "설계 확정" } }),
  ]) {
    const response = await f.call("/api/v1/records", "POST", payload(record), bearer("codex"));
    expect(response.status).toBe(201);
    expect(recordResult.parse(await response.json()).record.tags).toEqual(["테스트"]);
  }
});

test("the owner keeps free-form saves and the schema publishes the agent format", async () => {
  const owner = await f.call("/api/v1/records", "POST", payload({ kind: "research", title: "메모만" }), await f.login());
  expect(owner.status).toBe(201);
  const schema = z.object({ agentRecord: z.object({ tags: z.object({ min: z.number(), max: z.number() }),
    kinds: z.record(z.string(), z.object({ required: z.array(z.string()), fields: z.array(z.string()) })) }) })
    .parse(await (await f.call("/api/v1/schema")).json());
  expect(schema.agentRecord.tags).toMatchObject({ min: 1, max: 5 });
  expect(schema.agentRecord.kinds["research"]?.required).toEqual(["summary", "conclusion", "nextActions"]);
});

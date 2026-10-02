import { expect, test } from "bun:test";
import { HTTPError } from "ky";
import { DashboardRecordSchema } from "../shared/contracts";
import { deleteRecord, errorMessage } from "./api";

const httpError = (status: number, body: unknown) =>
  new HTTPError(new Response(JSON.stringify(body), { status }), new Request("http://localhost/api/v1/records"), {} as never);

test("a server validation failure is reported in Korean, not the raw English message", async () => {
  const message = await errorMessage(httpError(400, { error: { code: "invalid_input", message: "Input validation failed" } }));
  expect(message).not.toContain("Input validation failed");
  expect(message).toBe("형식에 맞지 않는 값이 있어요. 입력한 내용을 확인해 주세요.");
});

test("deleteRecord sends a version-checked DELETE with the CSRF header", async () => {
  // Given: a record at version 4, and a browser-like Request that resolves relative URLs.
  const record = DashboardRecordSchema.parse({
    id: "00000000-0000-4000-8000-000000000201", kind: "note", title: "메모", body: "", source: "manual", createdBy: "owner",
    reviewState: "approved", archivedAt: null, createdAt: "2026-09-28T01:00:00Z", updatedAt: "2026-09-28T01:00:00Z", version: 4, fields: {},
  });
  const NativeRequest = globalThis.Request;
  const nativeFetch = globalThis.fetch;
  const sent: { readonly request: Request; readonly body: unknown }[] = [];
  globalThis.Request = class extends NativeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      super(typeof input === "string" ? new URL(input, "http://localhost") : input, init);
    }
  } as typeof Request;
  globalThis.fetch = (async (request: Request) => { sent.push({ request, body: await request.clone().json() }); return new Response(null, { status: 204 }); }) as typeof fetch;
  try {
    // When: it is deleted.
    await deleteRecord(record, "csrf-1");
  } finally {
    globalThis.Request = NativeRequest;
    globalThis.fetch = nativeFetch;
  }
  // Then: one DELETE to the record path carries the version and the CSRF token.
  expect(sent).toHaveLength(1);
  const { request, body } = sent[0] ?? {};
  expect(request?.method).toBe("DELETE");
  expect(new URL(request?.url ?? "").pathname).toBe(`/api/v1/records/${record.id}`);
  expect(request?.headers.get("X-CSRF-Token")).toBe("csrf-1");
  expect(body).toEqual({ expectedVersion: 4 });
});

test("a stale delete reports the version conflict", async () => {
  expect(await errorMessage(httpError(409, { error: { code: "version_conflict", message: "stale" } })))
    .toBe("다른 곳에서 먼저 바뀌었어요. 새로고침한 뒤 다시 시도해 주세요.");
});

test.each([
  [429, "rate_limited", "Request limit exceeded", "요청이 너무 많아요. 잠시 뒤 다시 시도해 주세요."],
  [404, "not_found", "Record not found", "항목을 찾을 수 없어요."],
  [403, "forbidden", "Owner session required", "권한이 없어요. 다시 로그인해 주세요."],
  [403, "csrf", "Allowed Origin and CSRF token required", "권한이 없어요. 다시 로그인해 주세요."],
  [400, "invalid_query", "from must not follow to", "입력값을 확인해 주세요."],
  [503, "narration_unavailable", "No TTS key is configured", "음성 생성이 설정되어 있지 않아요."],
])("server code %p %p is shown in Korean", async (status, code, message, expected) => {
  // Given: an error response carrying an English server message.
  // When: it is turned into UI text.
  const text = await errorMessage(httpError(status, { error: { code, message } }));
  // Then: the Korean mapping replaces the English message.
  expect(text).toBe(expected);
});

test("an unknown code keeps a Korean server message and otherwise falls back to the status", async () => {
  expect(await errorMessage(httpError(400, { error: { code: "odd", message: "이미 한국어예요." } }))).toBe("이미 한국어예요.");
  expect(await errorMessage(httpError(500, { error: { code: "odd", message: "Boom" } }))).toBe("요청을 처리하지 못했어요 (500).");
  expect(await errorMessage(httpError(502, "<html>"))).toBe("요청을 처리하지 못했어요 (502).");
});

test("a network failure is reported as a connection problem", async () => {
  expect(await errorMessage(new TypeError("Failed to fetch"))).toBe("서버에 연결하지 못했어요. 네트워크 연결을 확인하고 다시 시도해 주세요.");
});

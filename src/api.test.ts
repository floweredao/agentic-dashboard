import { expect, test } from "bun:test";
import { HTTPError } from "ky";
import { DashboardRecordSchema, RecordInputSchema } from "../shared/contracts";
import { deleteRecord, errorMessage, retryAfterMs } from "./api";

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
  [403, "forbidden", "Owner session required", "이 계정으로는 이 작업을 할 수 없어요."],
  [403, "csrf", "Allowed Origin and CSRF token required", "페이지 보안 확인에 실패했어요. 페이지를 새로고침한 뒤 다시 시도해 주세요."],
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

test("an expired session in Korean names the owner key, as the sign-in screen does", async () => {
  expect(await errorMessage(httpError(401, { error: { code: "unauthenticated", message: "Authentication required" } })))
    .toBe("로그인이 필요하거나 세션이 만료됐어요. 소유자 키로 다시 연결해 주세요.");
});

test("a client-side validation failure names the field in words, never the schema path", async () => {
  // Given: a link whose URL is not a web address and an empty title, as the editor would send them.
  const parsed = RecordInputSchema.safeParse({ kind: "social", title: "", links: [{ label: "", url: "not a url" }] });
  if (parsed.success) throw new Error("expected a validation failure");
  // When: the failure is turned into the message the owner sees.
  const message = await errorMessage(parsed.error);
  // Then: it names 제목 and 링크 and shows no dotted path or English schema message.
  expect(message).toBe("형식이 맞지 않는 값이 있어요: 제목, 링크. 고쳐서 다시 저장해 주세요.");
});

test("a malformed server response is reported without its internal paths", async () => {
  const parsed = DashboardRecordSchema.safeParse({ id: 1 });
  if (parsed.success) throw new Error("expected a validation failure");
  expect(await errorMessage(parsed.error)).toBe("서버에서 받은 데이터를 읽지 못했어요. 새로고침한 뒤 다시 시도해 주세요.");
});

test("validation preserves safe paths but never arbitrary detail objects", async () => {
  // Given: structured field issues mixed with untrusted diagnostic data.
  const error = httpError(400, { error: { code: "record_incomplete", message: "invalid", details: [
    { path: ["fields", "summary"], message: "Required" },
    { path: ["links", 0, "url"], message: "Invalid URL" },
    { secret: "never-display-this" },
  ] } });
  // When: the UI formats the error.
  const message = await errorMessage(error);
  // Then: actionable paths survive, unrelated diagnostics do not.
  expect(message).toContain("fields.summary");
  expect(message).toContain("links.0.url");
  expect(message).not.toContain("never-display-this");
});

test("only an expired session recommends signing in", async () => {
  // Given: independent deployment, permission and session failures.
  const codes = ["csrf", "origin", "invalid_host", "forbidden"];
  // When: each failure is translated.
  const messages = await Promise.all(codes.map(code => errorMessage(httpError(403, { error: { code, message: "denied" } }))));
  const expired = await errorMessage(httpError(401, { error: { code: "unauthenticated", message: "expired" } }));
  // Then: recovery is distinct, and none mistakes a configuration failure for expiry.
  expect(new Set(messages).size).toBe(4);
  expect(messages.every(message => !message.includes("로그인"))).toBe(true);
  expect(expired).toContain("로그인");
  expect(await errorMessage(new Error("client bug"))).not.toBe(await errorMessage(new TypeError("Failed to fetch")));
});

test("rate limit feedback honors delta seconds and HTTP dates", async () => {
  // Given: a rate-limited response with an explicit retry deadline.
  const error = httpError(429, { error: { code: "rate_limited", message: "limited" } });
  error.response.headers.set("Retry-After", "60");
  // When: the error is formatted.
  const message = await errorMessage(error);
  // Then: it retains the server's waiting period rather than an immediate retry.
  expect(message).toContain("60");
  const now = Date.parse("2026-10-24T00:00:00Z");
  expect(retryAfterMs("60", now)).toBe(60000);
  expect(retryAfterMs("Sat, 24 Oct 2026 00:01:00 GMT", now)).toBe(60000);
  expect(retryAfterMs("Fri, 23 Oct 2026 00:01:00 GMT", now)).toBe(0);
  expect(retryAfterMs("garbage", now)).toBe(0);
});

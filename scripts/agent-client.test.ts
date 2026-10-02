import { expect, test } from "bun:test";
import { getRecord, listComments, markComment, postComment, readShared, searchRecords, sendRecord, updateRecord } from "./agent-client";

test("agent comment calls reach the comment routes with their credential, query and body", async () => {
  // Given: a real local HTTP boundary that records each request.
  const received: { method: string; path: string; query: Record<string, string>; body: unknown; authorization: string | null }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      received.push({ method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams),
        body: request.method === "POST" && request.headers.get("content-type")?.includes("json") ? await request.json() : null,
        authorization: request.headers.get("authorization") });
      return Response.json({ ok: url.pathname });
    },
  });
  const connection = { url: `http://127.0.0.1:${server.port}`, token: "test-credential" };
  try {
    // When: an agent lists new comments, replies and marks one done.
    await listComments(connection, { state: "new" });
    await postComment(connection, { requestId: "reply-1", replyTo: "c-1", body: "답", done: true });
    const marked = await markComment(connection, "c-1", "done");
    // Then: each call reaches its route with the agent credential and exactly that query or body.
    expect(received).toEqual([
      { method: "GET", path: "/api/v1/comments", query: { state: "new" }, body: null, authorization: "Bearer test-credential" },
      { method: "POST", path: "/api/v1/comments", query: {}, body: { requestId: "reply-1", replyTo: "c-1", body: "답", done: true }, authorization: "Bearer test-credential" },
      { method: "POST", path: "/api/v1/comments/c-1/done", query: {}, body: null, authorization: "Bearer test-credential" },
    ]);
    expect(marked).toEqual({ ok: "/api/v1/comments/c-1/done" });
  } finally {
    await server.stop(true);
  }
});

test("agent search sends its credential and query to the record list and returns the page", async () => {
  // Given: a real local HTTP boundary answering the record list.
  const received: { method?: string; path?: string; query?: Record<string, string>; authorization?: string | null } = {};
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      received.method = request.method;
      received.path = url.pathname;
      received.query = Object.fromEntries(url.searchParams);
      received.authorization = request.headers.get("authorization");
      return Response.json({ items: [{ id: "r-1", title: "알파 조사" }], nextCursor: null });
    },
  });
  try {
    // When: an agent searches with words, a kind, a page size and a cursor.
    const page = await searchRecords({ url: `http://127.0.0.1:${server.port}`, token: "test-credential" },
      { q: "알파", kind: "note", limit: 5, cursor: "next" });
    // Then: the GET reaches /api/v1/records with exactly those parameters and the page comes back.
    expect(received).toEqual({ method: "GET", path: "/api/v1/records", query: { q: "알파", kind: "note", limit: "5", cursor: "next" },
      authorization: "Bearer test-credential" });
    expect(page).toEqual({ items: [{ id: "r-1", title: "알파 조사" }], nextCursor: null });
  } finally {
    await server.stop(true);
  }
});

test("agent submission reaches the HTTP API with its credential and retry identity", async () => {
  // Given: a real local HTTP boundary, not an SDK mock.
  const received: { body?: unknown; authorization?: string | null } = {};
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      received.authorization = request.headers.get("authorization");
      received.body = await request.json();
      return Response.json(
        { record: { id: "saved-123", source: "codex" }, replayed: false },
        { status: 201 },
      );
    },
  });
  const submission = {
    requestId: "session-123-record-1",
    record: { kind: "research", title: "연결 검증", body: "실제 HTTP 저장" },
  };
  try {
    // When: an agent submits a record.
    const result = await sendRecord(
      { url: `http://127.0.0.1:${server.port}`, token: "test-credential" },
      submission,
    );
    // Then: identity and payload cross the real network boundary intact.
    expect(received.body).toEqual(submission);
    expect(received.authorization).toBe("Bearer test-credential");
    expect(result).toEqual({
      record: { id: "saved-123", source: "codex" },
      replayed: false,
    });
  } finally {
    await server.stop(true);
  }
});

test("shared reader fetches Markdown without credentials and rejects missing shares", async () => {
  // Given: a real local server that knows one share code.
  const received: { path?: string; authorization?: string | null } = {};
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      received.path = path;
      received.authorization = request.headers.get("authorization");
      return path === "/s/ABCD-EFGH-JKMN"
        ? new Response("# 공유 기록\n", { headers: { "Content-Type": "text/plain; charset=utf-8" } })
        : new Response("공유 링크를 찾을 수 없어요.", { status: 404 });
    },
  });
  try {
    // When: an agent reads the share URL.
    const markdown = await readShared(`http://127.0.0.1:${server.port}/s/ABCD-EFGH-JKMN`);
    // Then: the Markdown arrives as text and no credential is sent.
    expect(markdown).toBe("# 공유 기록\n");
    expect(received.authorization).toBeNull();
    await expect(readShared(`http://127.0.0.1:${server.port}/s/0000-0000-0000`)).rejects.toThrow();
  } finally {
    await server.stop(true);
  }
});

test("agent submission rejects HTTP errors instead of claiming a save", async () => {
  // Given: a reachable server rejects authentication.
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ error: { code: "UNAUTHORIZED" } }, { status: 401 }),
  });
  try {
    // When/Then: a failed save is observable to the caller.
    await expect(
      sendRecord(
        { url: `http://127.0.0.1:${server.port}`, token: "wrong" },
        { requestId: "r", record: { kind: "note", title: "x" } },
      ),
    ).rejects.toThrow();
  } finally {
    await server.stop(true);
  }
});

test("agent read sends its credential to the record route and returns the record", async () => {
  // Given: a real local HTTP boundary serving one record.
  const received: { method?: string; path?: string; authorization?: string | null } = {};
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      received.method = request.method;
      received.path = new URL(request.url).pathname;
      received.authorization = request.headers.get("authorization");
      return Response.json({ record: { id: "rec-1", version: 3 } });
    },
  });
  try {
    // When: an agent reads its record.
    const result = await getRecord(
      { url: `http://127.0.0.1:${server.port}`, token: "test-credential" },
      "rec-1",
    );
    // Then: the GET carries the Bearer credential and the record arrives intact.
    expect(received.method).toBe("GET");
    expect(received.path).toBe("/api/v1/records/rec-1");
    expect(received.authorization).toBe("Bearer test-credential");
    expect(result).toEqual({ record: { id: "rec-1", version: 3 } });
  } finally {
    await server.stop(true);
  }
});

test("agent update sends expectedVersion and changes as PATCH with its credential", async () => {
  // Given: a real local HTTP boundary accepting the patch.
  const received: {
    method?: string;
    path?: string;
    body?: unknown;
    authorization?: string | null;
  } = {};
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      received.method = request.method;
      received.path = new URL(request.url).pathname;
      received.authorization = request.headers.get("authorization");
      received.body = await request.json();
      return Response.json({ record: { id: "rec-1", version: 4, reviewState: "pending" } });
    },
  });
  const patch = { expectedVersion: 3, changes: { title: "수정된 제목" } };
  try {
    // When: an agent updates its record.
    const result = await updateRecord(
      { url: `http://127.0.0.1:${server.port}`, token: "test-credential" },
      "rec-1",
      patch,
    );
    // Then: method, path, credential and payload cross the boundary intact.
    expect(received.method).toBe("PATCH");
    expect(received.path).toBe("/api/v1/records/rec-1");
    expect(received.authorization).toBe("Bearer test-credential");
    expect(received.body).toEqual(patch);
    expect(result).toEqual({ record: { id: "rec-1", version: 4, reviewState: "pending" } });
  } finally {
    await server.stop(true);
  }
});

test("agent read and update reject HTTP errors instead of claiming success", async () => {
  // Given: a server that reports a missing record and a stale version.
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) =>
      request.method === "PATCH"
        ? Response.json({ error: { code: "version_conflict" } }, { status: 409 })
        : Response.json({ error: { code: "not_found" } }, { status: 404 }),
  });
  const connection = { url: `http://127.0.0.1:${server.port}`, token: "t" };
  try {
    // When/Then: both failures are observable to the caller.
    await expect(getRecord(connection, "missing")).rejects.toThrow();
    await expect(
      updateRecord(connection, "rec-1", { expectedVersion: 1, changes: {} }),
    ).rejects.toThrow();
  } finally {
    await server.stop(true);
  }
});

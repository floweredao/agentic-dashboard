import { expect } from "bun:test";
import { z } from "zod";
import { digestInput, noteInput, subscription, type IsolationFixture } from "./isolation-fixture";

type PrivateCase = {
  readonly kind: "private";
  readonly status: number;
  readonly agent?: boolean;
  readonly query?: string;
  readonly body?: (f: IsolationFixture) => unknown;
  readonly check?: (value: unknown, f: IsolationFixture) => void;
};
export type IsolationCase = PrivateCase | { readonly kind: "public"; readonly reason: string };
const hidden: PrivateCase = { kind: "private", status: 404 };
const empty: PrivateCase = { kind: "private", status: 200, check: value => {
  expect(z.object({ items: z.array(z.unknown()) }).parse(value).items).toEqual([]);
} };
const freshRecord = (value: unknown, f: IsolationFixture) => {
  const saved = z.object({ record: z.object({ id: z.string() }), replayed: z.boolean() }).parse(value);
  expect(saved.replayed).toBe(false);
  expect(saved.record.id).not.toBe(f.record.id);
};

/** Every concrete route must have a scenario, or a narrowly justified public response. */
export const CASES: Readonly<Record<string, IsolationCase>> = {
  "ALL /*": { kind: "public", reason: "Security/static middleware, not a data endpoint" },
  "ALL /api/*": { kind: "public", reason: "Unknown API routes return only 404" },
  "GET /*": { kind: "public", reason: "Static application shell" },
  "GET /api/health": { kind: "public", reason: "Liveness only" },
  "GET /api/v1/health": { kind: "public", reason: "Liveness only" },
  "GET /api/v1/schema": { kind: "public", reason: "Public input schema, no stored data" },
  "GET /api/v1/config": { kind: "public", reason: "Public installation metadata, no account data" },
  "GET /auth/google/start": { kind: "public", reason: "Starts a signed one-time OIDC transaction, no account content" },
  "GET /auth/google/callback": { kind: "public", reason: "OIDC callback verifies state, signature and claims before issuing a session" },
  "GET /auth/capacity": { kind: "public", reason: "Public capacity explanation only" },
  "POST /auth/logout": { kind: "private", status: 204 },
  "ALL /mcp": { kind: "private", status: 405, agent: true },
  "POST /internal/tasks/:kind": { kind: "private", status: 401, body: () => ({}) },
  "POST /api/v1/agents": { kind: "private", status: 201, body: () => ({ name: "new-agent" }) },
  "POST /api/v1/agents/invites": { kind: "private", status: 201, body: () => ({ name: "new-computer" }) },
  "POST /api/v1/agents/:name/rotate": { kind: "private", status: 404 },
  "DELETE /api/v1/agents/:name": { kind: "private", status: 404 },
  "GET /api/v1/settings/gemini": { kind: "private", status: 404 },
  "PUT /api/v1/settings/gemini": { kind: "private", status: 404, body: () => ({ key: "fixture-invalid" }) },
  "DELETE /api/v1/settings/gemini": { kind: "private", status: 404 },
  "GET /api/v1/shared/:code": { kind: "public", reason: "A share code explicitly grants access to its account's projection" },
  "GET /s/:code": { kind: "public", reason: "The same share capability as plain text" },
  "POST /api/v1/agents/connect": { kind: "public", reason: "A single-use invitation grants its issuing account's agent capability" },
  "POST /api/v1/capture": { kind: "private", status: 401, agent: true, body: () => ({ url: "https://example.test/private-a" }) },
  "GET /api/v1/agents": { kind: "private", status: 200, check: value => {
    expect(z.object({ items: z.array(z.object({ name: z.string() })) }).parse(value).items.map(item => item.name)).toEqual(["writer"]);
  } },
  "POST /api/v1/auth/session": { kind: "private", status: 200, body: f => ({ token: f.tokens.ownerB }),
    check: value => { expect(z.object({ csrfToken: z.string() }).parse(value).csrfToken.length).toBeGreaterThan(0); } },
  "GET /api/v1/auth/session": { kind: "private", status: 200, check: (value, f) => {
    expect(z.object({ csrfToken: z.string() }).parse(value).csrfToken).toBe(f.ownerB["X-CSRF-Token"]);
  } },
  "DELETE /api/v1/auth/session": { kind: "private", status: 204 },
  "GET /api/v1/records": empty,
  "POST /api/v1/records": { kind: "private", status: 201, agent: true, body: () => ({ requestId: "overlap", record: noteInput }), check: freshRecord },
  "GET /api/v1/records/:id": hidden,
  "PATCH /api/v1/records/:id": { ...hidden, body: () => ({ expectedVersion: 1, changes: { title: "B overwrite" } }) },
  "DELETE /api/v1/records/:id": { ...hidden, agent: true, body: () => ({ expectedVersion: 1 }) },
  "GET /api/v1/comments": empty,
  "POST /api/v1/comments": { ...hidden, body: f => ({ requestId: "b-comment", recordId: f.task.id, body: "B write" }) },
  "POST /api/v1/comments/:id/seen": { ...hidden, agent: true },
  "POST /api/v1/comments/:id/done": { ...hidden, agent: true },
  "GET /api/v1/trash": empty,
  "POST /api/v1/trash/:id/restore": hidden,
  "DELETE /api/v1/trash/:id": hidden,
  "DELETE /api/v1/trash": { kind: "private", status: 204 },
  "GET /api/v1/narration/auto": { kind: "private", status: 200, check: value => {
    expect(value).toEqual({ digests: "off", records: "off", scope: "summary" });
  } },
  "PUT /api/v1/narration/auto": { kind: "private", status: 200, body: () => ({ digests: "parts", records: "read", scope: "summary" }) },
  "GET /api/v1/narration/voices": { kind: "private", status: 200, check: value => {
    expect(z.object({ settings: z.object({ readStyle: z.string() }) }).parse(value).settings.readStyle).not.toBe("Private A style");
  } },
  "PUT /api/v1/narration/voices": { kind: "private", status: 200, body: () => ({
    readVoice: "test-read", hostA: "test-a", hostB: "test-b", readStyle: "B style", podcastStyle: "B podcast",
  }) },
  "GET /api/v1/narration/voices/:voice/preview": { kind: "private", status: 200 },
  "GET /api/v1/records/:id/narration": hidden,
  "POST /api/v1/records/:id/narration": { ...hidden, body: () => ({}) },
  "DELETE /api/v1/records/:id/narration": hidden,
  "POST /api/v1/records/:id/narration/cancel": hidden,
  "GET /api/v1/records/:id/narration/audio": hidden,
  "GET /api/v1/records/:id/document": hidden,
  "PUT /api/v1/records/:id/document": { ...hidden, body: () => ({ html: "<p>B overwrite</p>" }) },
  "DELETE /api/v1/records/:id/document": hidden,
  "POST /api/v1/digests": { kind: "private", status: 201, agent: true, body: () => digestInput, check: (value, f) => {
    expect(z.object({ digest: z.object({ id: z.string() }) }).parse(value).digest.id).not.toBe(f.digest.id);
  } },
  "GET /api/v1/digests": empty,
  "GET /api/v1/digests/search": { ...empty, query: "?q=Only" },
  "GET /api/v1/digests/reactions": empty,
  "GET /api/v1/digests/:id": hidden,
  "PUT /api/v1/digests/:id/reactions": { ...hidden, body: () => ({ section: "tech", key: "a1", reaction: "dislike" }) },
  "POST /api/v1/digests/:id/read": { ...hidden, body: () => ({ read: true }) },
  "GET /api/v1/digests/:id/narration": hidden,
  "POST /api/v1/digests/:id/narration": { ...hidden, body: () => ({}) },
  "DELETE /api/v1/digests/:id/narration": hidden,
  "POST /api/v1/digests/:id/narration/cancel": hidden,
  "GET /api/v1/digests/:id/narration/audio": hidden,
  "GET /api/v1/push": { kind: "private", status: 200, query: `?endpoint=${encodeURIComponent(subscription("a").endpoint)}`, check: value => {
    expect(value).toMatchObject({ device: null, devices: 1 });
  } },
  "PUT /api/v1/push/subscription": { kind: "private", status: 200, body: () => ({ subscription: subscription("b"), kinds: { digest: false, review: true, reply: true } }) },
  "DELETE /api/v1/push/subscription": { kind: "private", status: 204, body: () => ({ endpoint: subscription("a").endpoint }) },
  "POST /api/v1/push/test": { ...hidden, body: () => ({ endpoint: subscription("a").endpoint }) },
  "GET /api/v1/records/:id/share": hidden,
  "POST /api/v1/records/:id/share": hidden,
  "DELETE /api/v1/records/:id/share": hidden,
};

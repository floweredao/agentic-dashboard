import { expect, test } from "bun:test";
import { z } from "zod";
import { cloudJobs, localJobs, taskVerifier } from "../server/jobs";
import { cloudClient } from "../server/cloud-client";
import { hostedFixture } from "./helpers/hosted";
import { fake, deferred } from "./narration-helper";
import { mockOidc } from "./helpers/mock-oidc";

test("Cloud Tasks targets the configured origin with its service account audience", async () => {
  // Given: a local Tasks API fake.
  let received: unknown;
  const server = Bun.serve({ port: 0, fetch: async request => { received = await request.json(); return Response.json({}); } });
  try {
    const queue = cloudJobs({ queue: "projects/test/locations/test/queues/test", origin: "https://dashboard.example.test",
      serviceAccount: "tasks@example.test", client: cloudClient({ tasksOrigin: server.url.origin, accessToken: async () => "fixture" }) });
    // When: enqueuing one account's narration.
    await queue.enqueue("narration", { userId: "a", id: "record", revision: "version" });
    // Then: a Google OIDC token authenticates the exact application audience.
    expect(received).toMatchObject({ task: { httpRequest: { url: "https://dashboard.example.test/internal/tasks/narration",
      httpMethod: "POST", oidcToken: { serviceAccountEmail: "tasks@example.test", audience: "https://dashboard.example.test" } } } });
  } finally { server.stop(true); }
});

test("local jobs await their work at idle without blocking enqueue", async () => {
  // Given: a provider-independent completion signal.
  const gate = deferred<void>();
  let completed = false;
  const jobs = localJobs(async () => { await gate.promise; completed = true; });
  // When: enqueue returns while work is pending.
  await jobs.enqueue("ai-fill", { userId: "a", id: "one", revision: "1" });
  expect(completed).toBe(false);
  gate.resolve();
  await jobs.idle();
  // Then: idle observes actual completion.
  expect(completed).toBe(true);
});

test("internal routes reject unsigned calls before touching tenant work", async () => {
  // Given: enabled Tasks with a fake enqueue, never Google.
  const f = await hostedFixture({ tasks: { queue: "projects/test/locations/test/queues/test",
    serviceAccount: "tasks@example.test" }, jobs: localJobs(async () => undefined) });
  try {
    // When: a caller supplies no service-account token.
    const response = await f.call("/internal/tasks/maintenance", { method: "POST", headers: {}, body: {} });
    // Then: neither browser credentials nor an unsigned request may start maintenance.
    expect(response.status).toBe(401);
  } finally { await f.close(); }
});

test("task verifier rejects a signed JWT for the wrong audience", async () => {
  // Given: PR-C's local Google issuer issuing an otherwise valid identity.
  const issuer = await mockOidc();
  issuer.state.claims = { email: "tasks@example.test" };
  const f = await hostedFixture({ hosted: { google: { clientId: "other-audience", clientSecret: "fixture" },
    sessionSigningKey: "fixture-signing-key-long-enough-for-test", maxUsers: 50, endpoints: issuer.endpoints } });
  try {
    const start = await f.call("/auth/google/start", { headers: {} });
    const location = start.headers.get("location");
    expect(location).not.toBeNull();
    const url = new URL(location ?? "");
    // The verifier is tested with the same generated RSA key via a PKCE-bound token.
    const verifier = "fixture-verifier";
    url.searchParams.set("code_challenge", new Bun.CryptoHasher("sha256").update(verifier).digest("base64url"));
    const authorized = await fetch(url, { redirect: "manual" });
    const code = new URL(authorized.headers.get("location") ?? "").searchParams.get("code") ?? "";
    const token = z.object({ id_token: z.string() }).parse(await (await fetch(issuer.endpoints.token, {
      method: "POST", body: new URLSearchParams({ code, client_id: "other-audience", redirect_uri: url.searchParams.get("redirect_uri") ?? "",
        grant_type: "authorization_code", code_verifier: verifier }),
    })).json()).id_token;
    const verify = taskVerifier({ serviceAccount: "tasks@example.test", origin: "https://dashboard.example.test",
      jwks: issuer.endpoints.jwks, issuers: issuer.endpoints.issuers });
    // When/Then: even a genuine signature cannot authorize another audience.
    await expect(verify(new Request("https://dashboard.example.test/internal/tasks/maintenance",
      { headers: { Authorization: `Bearer ${token}` } }))).rejects.toMatchObject({ status: 401 });
  } finally { await f.close(); issuer.close(); }
});

test("duplicate task delivery starts one provider run across requests", async () => {
  // Given: queued narration that the external queue has not executed yet.
  const tts = fake();
  const issuer = await mockOidc();
  const payloads: { userId: string; id: string; revision: string }[] = [];
  const f = await hostedFixture({ tasks: { queue: "projects/test/locations/test/queues/test", serviceAccount: "tasks@example.test",
      jwks: issuer.endpoints.jwks, issuers: issuer.endpoints.issuers },
    jobs: { enqueue: async (_kind, payload) => { payloads.push(payload); }, idle: async () => undefined },
    narration: { provider: tts.provider, encode: async path => ({ path, mime: "audio/wav" }), retryDelayMs: 0 } });
  try {
    const saved = await f.a.scope.store.create({ id: "owner", source: "manual" }, "one",
      { kind: "note", title: "One", body: "A short note.", status: "new", projectId: null, taskId: null, dueDate: null, tags: [], links: [], fields: {} }, {});
    await f.a.scope.narration.request({ id: "owner", source: "manual" }, saved.record, false);
    const payload = payloads[0];
    if (!payload) throw new Error("Expected an enqueued narration");
    // When: two deliveries race.
    const token = await issuer.serviceToken({ aud: "http://127.0.0.1:4390", email: "tasks@example.test" });
    const responses = await Promise.all([1, 2].map(() => f.call("/internal/tasks/narration", { method: "POST",
      headers: { Authorization: `Bearer ${token}` }, body: payload })));
    // Then: only one script and speech call happen.
    expect(tts.calls.script).toBe(1);
    expect(tts.calls.speak).toHaveLength(1);
    expect(responses.map(response => response.status)).toEqual([204, 204]);
  } finally { await f.close(); issuer.close(); }
});

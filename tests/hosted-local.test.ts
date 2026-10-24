import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createApp } from "../server/app";
import { ApiError } from "../server/errors";
import { secret } from "../server/agents";
import { RecordInputSchema } from "../shared/contracts";
import { hostedFixture } from "./helpers/hosted";

const origin = "http://127.0.0.1:4390";
const owner = { id: "owner", source: "manual" };
const input = RecordInputSchema.parse({ kind: "note", title: "Legacy local record", body: "A local-only fixture." });

async function upgraded() {
  const directory = mkdtempSync(join(tmpdir(), "hosted-local-"));
  const localOptions = { databasePath: join(directory, "database.sqlite"), credentialsPath: join(directory, "credentials.json"),
    privateOrigin: origin, port: 4390, pushEnabled: false };
  const local = await createApp(localOptions);
  const record = (await local.store.create(owner, "legacy-record", input, input)).record;
  await local.store.putDocument(record.id, "<p>Legacy private document</p>", owner);
  const { share } = await local.shares.create(record.id);
  const invite = await local.invites.create("legacy-invite");
  const token = await local.agents.add("legacy-agent");
  const session = await local.auth.createOwnerSession();
  await local.close();
  const app = await createApp({ ...localOptions, hosted: {
    google: { clientId: "fixture-client", clientSecret: secret() }, sessionSigningKey: secret(), maxUsers: 50,
  } });
  return { app, localOptions, record, share, invite, token, session,
    async close() { await app.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test("hosted anonymous requests do not select or create a local account context", async () => {
  const f = await upgraded();
  try {
    // Given a database containing the old local account.
    const request = new Request(`${origin}/api/v1/records`);
    // When no hosted authority is presented.
    const user = await f.app.auth.resolveUser(request);
    // Then there is no local fallback or persisted replacement account.
    expect(user).toBeNull();
    expect(f.app.store.db.userId === "local").toBe(false);
    expect(z.object({ count: z.number() }).parse(await f.app.sql.get("SELECT count(*) AS count FROM users")).count).toBe(1);
  } finally { await f.close(); }
});

for (const surface of ["json", "page", "document"] as const) {
  test(`upgraded local data is unavailable on the hosted ${surface} surface`, async () => {
    const f = await upgraded();
    try {
      // Given local data and capabilities from before the mode switch.
      const targets = {
        json: { path: `/api/v1/shared/${f.share.code}`, headers: {}, status: 404 },
        page: { path: `/s/${f.share.code}`, headers: {}, status: 404 },
        document: { path: `/api/v1/records/${f.record.id}/document`, headers: { Cookie: `session=${f.session.value}` }, status: 401 },
      };
      const target = targets[surface];
      // When that capability reaches the hosted origin.
      const response = await f.app.fetch(new Request(origin + target.path, { headers: target.headers }));
      // Then the legacy local account is not exposed.
      expect(response.status).toBe(target.status);
    } finally { await f.close(); }
  });
}

test("hosted requests cannot redeem a legacy local invitation", async () => {
  const f = await upgraded();
  try {
    // Given an unexpired invitation issued by the local account.
    const request = new Request(`${origin}/api/v1/agents/connect`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: f.invite.code }) });
    // When it is redeemed on the hosted origin.
    const response = await f.app.fetch(request);
    // Then it does not create a local agent credential.
    expect(response.status).toBe(404);
  } finally { await f.close(); }
});

test("legacy local bearers and sessions do not authenticate in hosted mode", async () => {
  const f = await upgraded();
  try {
    // Given still-valid credentials in the old local account.
    const requests = [
      new Request(`${origin}/api/v1/records`, { headers: { Authorization: `Bearer ${f.token}` } }),
      new Request(`${origin}/api/v1/records`, { headers: { Cookie: `session=${f.session.value}` } }),
    ];
    // When both credential forms are used at the hosted origin.
    const responses = await Promise.all(requests.map(request => f.app.fetch(request)));
    // Then neither resolves local authority.
    expect(responses.map(response => response.status)).toEqual([401, 401]);
  } finally { await f.close(); }
});

test("hosted mode refuses explicit local service resolution", async () => {
  const f = await upgraded();
  try {
    // Given hosted mode over an upgraded database.
    let resolved = false;
    // When an internal caller asks for the local tenant.
    try { await f.app.tenant("local"); resolved = true; }
    catch (error) {
      if (!(error instanceof ApiError)) throw error;
      expect(error.code).toBe("local_account_unavailable");
    }
    // Then no local graph is returned.
    expect(resolved).toBe(false);
  } finally { await f.close(); }
});

test("a legacy Google binding cannot select the local account in hosted mode", async () => {
  const f = await upgraded();
  try {
    // Given a local row explicitly linked before the mode switch.
    await f.app.sql.run("UPDATE users SET google_sub=? WHERE id='local'", ["legacy-subject"]);
    // When that identity is resolved by hosted sign-in.
    const result = f.app.auth.control.googleUser({ sub: "legacy-subject", email: "legacy@example.test",
      name: "Legacy", now: Date.parse("2026-10-24T12:00:00Z"), maxUsers: 50 });
    // Then hosted sign-in cannot turn it into local authority.
    await expect(result).rejects.toMatchObject({ status: 403, code: "local_account_unavailable" });
  } finally { await f.close(); }
});

test("hosted account shares still resolve without a browser session", async () => {
  const f = await hostedFixture();
  try {
    // Given a share belonging to a hosted account.
    const record = (await f.a.scope.store.create(owner, "hosted-share", input, input)).record;
    const { share } = await f.a.scope.shares.create(record.id);
    // When an anonymous reader uses its explicit capability.
    const response = await f.call(`/api/v1/shared/${share.code}`, { headers: {} });
    // Then the hosted record remains publicly reachable by that capability.
    expect(response.status).toBe(200);
  } finally { await f.close(); }
});

test("the old local data and shares remain intact in local mode", async () => {
  const f = await upgraded();
  const local = await createApp(f.localOptions);
  try {
    // Given the same database opened explicitly in local mode.
    // When its existing share is read there.
    const response = await local.fetch(new Request(`${origin}/api/v1/shared/${f.share.code}`));
    // Then the hosted policy did not delete or rewrite local capabilities.
    expect(response.status).toBe(200);
    expect((await local.store.get(f.record.id)).id).toBe(f.record.id);
  } finally { await local.close(); await f.close(); }
});

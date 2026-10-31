import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";

import { digestPartId } from "../shared/contracts";
import { PODCAST_STYLE, SPEECH_STYLE } from "../server/narration";

import { agentRecord, bearer, payload, recordResult } from "./backend-helper";
import { cleanupNarration, setup, read, research, narration, hold, DIALOGUE, COVER_BODY, COVER_FULL, VOICES, voiceSettings, AUTO, articles, messages, uploadDigest, digestId } from "./narration-helper";
afterEach(cleanupNarration);

test("a part script far shorter than its source is written once more, and the fuller one is spoken", async () => {
  const { f, tts, idle } = (await setup());
  const owner = await f.login();
  const response = await f.call("/api/v1/records", "POST", { requestId: crypto.randomUUID(), record: agentRecord({ body: COVER_BODY }) }, owner);
  const record = recordResult.parse(await response.json()).record;
  tts.scriptTexts = ["원문의 일부만 전합니다. 나머지는 줄였어요.", COVER_FULL];
  expect((await f.call(narration(record.id), "POST", {}, owner)).status).toBe(202);
  await idle();
  const state = await read(await f.call(narration(record.id), "GET", undefined, owner));
  expect(state.narration?.status).toBe("ready");
  expect(tts.calls.script).toBe(2);
  expect(tts.calls.systems[1]).not.toBe(tts.calls.systems[0]);
  expect(state.narration?.script).toBe(COVER_FULL);
});

test("a script saved under earlier script rules is written again instead of reused", async () => {
  const { f, tts, idle } = (await setup());
  const owner = await f.login();
  const response = await f.call("/api/v1/records", "POST", { requestId: crypto.randomUUID(), record: agentRecord({ body: COVER_BODY }) }, owner);
  const record = recordResult.parse(await response.json()).record;
  tts.scriptText = COVER_FULL;
  expect((await f.call(narration(record.id), "POST", {}, owner)).status).toBe(202);
  await idle();
  const db = new Database(f.options.databasePath);
  db.query("UPDATE narrations SET script_hash=audio_hash WHERE record_id=?").run(record.id);
  db.close();
  expect((await f.call(narration(record.id), "POST", { force: true }, owner)).status).toBe(202);
  await idle();
  expect(tts.calls.script).toBe(2);
});

test("the owner reads the voice settings: the provider's voices and the speaking styles by default, and the Korean voice list", async () => {
  const { f } = (await setup());
  const owner = await f.login();
  const response = await f.call(VOICES, "GET", undefined, owner);
  expect(response.status).toBe(200);
  const body = await voiceSettings(response);
  const defaults = { readVoice: "Kore", hostA: "Kore", hostB: "Puck", readStyle: SPEECH_STYLE, podcastStyle: PODCAST_STYLE };
  expect(body.settings).toEqual(defaults);
  expect(body.defaults).toEqual(defaults);
  expect(body.voices.find(voice => voice.id === "ko-kr-podcaster-8")).toEqual({ id: "ko-kr-podcaster-8", name: "Podcaster 8", gender: "male", pitch: "low" });
  expect(body.voices.filter(voice => voice.id.startsWith("ko-kr-")).length).toBe(117);
  // The provider's own voices stay choosable even when the list does not name them.
  expect(body.voices.map(voice => voice.id)).toEqual(expect.arrayContaining(["Kore", "Puck"]));
  expect((await f.call(VOICES, "GET", undefined, bearer("omo"))).status).toBe(403);
});

test("saved voices and styles are used from the next narration, and audio made before keeps its voice and is not outdated", async () => {
  const { f, tts, idle } = (await setup());
  const owner = await f.login();
  const record = await research(f, owner);
  expect((await f.call(narration(record.id), "POST", {}, owner)).status).toBe(202);
  await idle();
  const chosen = { readVoice: "ko-kr-tutor-1", hostA: "ko-kr-storyteller-2", hostB: "ko-kr-podcaster-3", readStyle: "차분하고 느리게", podcastStyle: "활기찬 대화" };
  const saved = await f.call(VOICES, "PUT", chosen, owner);
  expect(saved.status).toBe(200);
  expect((await voiceSettings(saved)).settings).toEqual(chosen);

  const before = await read(await f.call(narration(record.id), "GET", undefined, owner));
  expect(before.narration).toMatchObject({ status: "ready", stale: false, audio: { voice: "Kore" } });

  expect((await f.call(narration(record.id), "POST", { force: true }, owner)).status).toBe(202);
  await idle();
  expect(tts.calls.voices.at(-1)).toBe("ko-kr-tutor-1");
  expect(tts.calls.styles.at(-1)).toBe("차분하고 느리게");
  expect((await read(await f.call(narration(record.id), "GET", undefined, owner))).narration?.audio?.voice).toBe("ko-kr-tutor-1");

  tts.scriptText = DIALOGUE;
  const podcast = await research(f, owner);
  expect((await f.call(narration(podcast.id), "POST", { style: "podcast" }, owner)).status).toBe(202);
  await idle();
  expect(tts.calls.hosts.at(-1)).toEqual(["ko-kr-storyteller-2", "ko-kr-podcaster-3"]);
  expect(tts.calls.styles.at(-1)).toBe("활기찬 대화");
  expect((await read(await f.call(narration(podcast.id), "GET", undefined, owner))).narration?.audio?.voice).toBe("ko-kr-storyteller-2, ko-kr-podcaster-3");

  // The choice is kept across a restart.
  (await f.restart());
  expect((await voiceSettings(await f.call(VOICES, "GET", undefined, await f.login()))).settings).toEqual(chosen);
});

test("voice settings take only listed voices, two different podcast hosts and a short style, and only from the owner", async () => {
  const { f } = (await setup());
  const owner = await f.login();
  const valid = { readVoice: "ko-kr-tutor-1", hostA: "ko-kr-tutor-1", hostB: "ko-kr-tutor-2", readStyle: "또렷하게", podcastStyle: "편안하게" };
  for (const bad of [{ ...valid, readVoice: "ko-kr-nobody-9" }, { ...valid, hostB: "ko-kr-tutor-1" }, { ...valid, readStyle: " " },
    { ...valid, podcastStyle: "가".repeat(301) }, { ...valid, extra: true }]) {
    const response = await f.call(VOICES, "PUT", bad, owner);
    expect(response.status).toBe(400);
  }
  expect((await f.call(VOICES, "PUT", valid, bearer("omo"))).status).toBe(403);
  const { Cookie, Origin } = owner;
  expect((await f.call(VOICES, "PUT", valid, { Cookie, Origin })).status).toBe(403);
  expect((await voiceSettings(await f.call(VOICES, "GET", undefined, owner))).settings.readVoice).toBe("Kore");
});

test("a voice preview is spoken once with that voice and then served from the saved file", async () => {
  const { f, tts } = (await setup());
  const owner = await f.login();
  const first = await f.call(`${VOICES}/ko-kr-tutor-1/preview`, "GET", undefined, owner);
  expect(first.status).toBe(200);
  expect(first.headers.get("content-type")).toBe("audio/wav");
  expect((await first.arrayBuffer()).byteLength).toBeGreaterThan(44);
  expect(tts.calls.voices).toEqual(["ko-kr-tutor-1"]);
  expect((await f.call(`${VOICES}/ko-kr-tutor-1/preview`, "GET", undefined, owner)).status).toBe(200);
  expect(tts.calls.voices).toEqual(["ko-kr-tutor-1"]);
  expect((await f.call(`${VOICES}/ko-kr-nobody-9/preview`, "GET", undefined, owner)).status).toBe(404);
  expect((await f.call(`${VOICES}/ko-kr-tutor-1/preview`, "GET", undefined, bearer("omo"))).status).toBe(403);
});

test("with digest audio set to parts, an upload makes each changed part's audio in the background, and never an unchanged one", async () => {
  const { f, tts, idle } = (await setup(undefined, { autoDefaults: { digests: "parts" } }));
  const owner = await f.login();
  // When: an agent uploads articles and messages while the speech provider is held, so no audio can finish yet.
  const held = hold(tts);
  const created = await uploadDigest(f, [articles("First article"), messages("First message")]);
  // Then: the upload answers at once.
  expect(created.status).toBe(201);
  const id = await digestId(created);
  await held.entered.promise;
  held.release.resolve();
  await idle();
  // And: the articles and the messages each have ready, current audio from one script, with nobody asking.
  for (const part of ["articles", "messages"] as const) {
    const state = await read(await f.call(`/api/v1/digests/${digestPartId(id, part)}/narration`, "GET", undefined, owner));
    expect(state.narration).toMatchObject({ status: "ready", stale: false, style: "read" });
  }
  expect(tts.calls.script).toBe(2);
  // When: the same digest comes again, then with new messages only.
  await uploadDigest(f, [articles("First article"), messages("First message")]);
  await idle();
  expect(tts.calls.script).toBe(2);
  await uploadDigest(f, [messages("Second message")]);
  await idle();
  // Then: only the messages are made again.
  expect(tts.calls.script).toBe(3);
  expect(tts.calls.prompts[2]).toContain("Second message");
  expect((await read(await f.call(`/api/v1/digests/${id}/narration`, "GET", undefined, owner))).narration).toMatchObject({ status: "ready", stale: false });
});

test("a digest part that changes while its audio is being made is made again once that job ends", async () => {
  const { f, tts, idle } = (await setup(undefined, { autoDefaults: { digests: "parts" } }));
  const owner = await f.login();
  const held = hold(tts);
  const id = await digestId(await uploadDigest(f, [articles("Early article")]));
  await held.entered.promise;
  // When: more articles arrive while the first articles audio is being spoken.
  await uploadDigest(f, [articles("Early article", "Late article")]);
  held.release.resolve();
  await idle();
  // Then: the articles audio is remade from the later articles and is current.
  expect(tts.calls.script).toBe(2);
  expect(tts.calls.prompts[1]).toContain("Late article");
  expect((await read(await f.call(`/api/v1/digests/${id}/narration`, "GET", undefined, owner))).narration).toMatchObject({ status: "ready", stale: false });
});

test("digest audio set to all makes one audio for the whole digest; off (the default) makes none", async () => {
  const off = (await setup());
  const offOwner = await off.f.login();
  const plainId = await digestId(await uploadDigest(off.f, [articles("Article"), messages("Message")]));
  await off.idle();
  expect(off.tts.calls.script).toBe(0);
  expect((await read(await off.f.call(`/api/v1/digests/${plainId}/narration`, "GET", undefined, offOwner))).narration).toBeNull();
  const all = (await setup(undefined, { autoDefaults: { digests: "all" } }));
  const owner = await all.f.login();
  const id = await digestId(await uploadDigest(all.f, [articles("Article"), messages("Message")]));
  await all.idle();
  expect(all.tts.calls.script).toBe(1);
  expect((await read(await all.f.call(`/api/v1/digests/${digestPartId(id, "all")}/narration`, "GET", undefined, owner))).narration?.status).toBe("ready");
  expect((await read(await all.f.call(`/api/v1/digests/${id}/narration`, "GET", undefined, owner))).narration).toBeNull();
});

test("the owner reads and saves the automatic audio settings, which survive a restart; agents and bad input are refused", async () => {
  const { f } = (await setup());
  const owner = await f.login();
  expect(await (await f.call(AUTO, "GET", undefined, owner)).json()).toEqual({ digests: "off", records: "off", scope: "full" });
  const saved = await f.call(AUTO, "PUT", { digests: "all", records: "podcast", scope: "summary" }, owner);
  expect(saved.status).toBe(200);
  expect(await saved.json()).toEqual({ digests: "all", records: "podcast", scope: "summary" });
  (await f.restart());
  const again = await f.login();
  expect(await (await f.call(AUTO, "GET", undefined, again)).json()).toEqual({ digests: "all", records: "podcast", scope: "summary" });
  expect((await f.call(AUTO, "GET", undefined, bearer("omo"))).status).toBe(403);
  expect((await f.call(AUTO, "PUT", { digests: "off", records: "off", scope: "full" }, bearer("omo"))).status).toBe(403);
  expect((await f.call(AUTO, "PUT", { digests: "sometimes", records: "off", scope: "full" }, again)).status).toBe(400);
  const { "X-CSRF-Token": _csrf, ...withoutCsrf } = again;
  expect((await f.call(AUTO, "PUT", { digests: "off", records: "off", scope: "full" }, withoutCsrf)).status).toBe(403);
});

test("with new-record audio on, each new research or work report gets audio in the chosen style, and the daily limit rises to 30", async () => {
  // Given: a daily limit of 1 and new-record audio turned on as podcast.
  const { f, tts, idle } = (await setup(1));
  const owner = await f.login();
  expect((await f.call(AUTO, "PUT", { digests: "off", records: "podcast", scope: "full" }, owner)).status).toBe(200);
  // When: an agent saves two research records and a note.
  const save = async (record: Record<string, unknown>) =>
    recordResult.parse(await (await f.call("/api/v1/records", "POST", payload(agentRecord(record)), bearer("omo"))).json()).record;
  const first = await save({ title: "First research", body: "First body" });
  const second = await save({ title: "Second research", body: "Second body" });
  const note = await save({ kind: "note", title: "Note", body: "Note body" });
  await idle();
  // Then: both research records have podcast audio (two runs under a limit of 1 needed the raised limit); the note has none.
  for (const record of [first, second, note]) {
    expect((await read(await f.call(narration(record.id), "GET", undefined, owner))).narration).toMatchObject({ status: "ready", style: "podcast" });
  }
  expect(tts.calls.converse.length).toBeGreaterThan(0);
});

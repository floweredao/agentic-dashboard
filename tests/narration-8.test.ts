
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";

import { bearer } from "./backend-helper";
import { cleanupNarration, hold, narration, read, research, setup } from "./narration-helper";
afterEach(cleanupNarration);

test("a job cut off by a restart while the key is gone fails as no_key without an attempt and without the old run's progress", async () => {
  const { f, tts, idle } = (await setup());
  const owner = await f.login();
  const record = await research(f, owner);
  expect((await f.call(narration(record.id), "POST", {}, owner)).status).toBe(202);
  await idle();
  // Given: the server stopped halfway through speaking, and comes back without a key.
  const db = new Database(f.options.databasePath);
  db.query("UPDATE narrations SET status='speaking', progress_done=1, progress_total=2, audio_file=NULL, audio_hash=NULL WHERE record_id=?").run(record.id);
  db.close();
  tts.available = false;
  (await f.restart());
  await f.app.narration.idle();
  // Then: the job failed for the key and shows no half-done progress.
  const state = (await read(await f.call(narration(record.id), "GET", undefined, owner))).narration;
  expect(state).toMatchObject({ status: "failed", error: "no_key", attempts: 0, progress: null, audio: null });
});

test("jobs cut off by a restart wait in the queue without the cut-off run's progress, then finish", async () => {
  const { f, tts, idle } = (await setup());
  const owner = await f.login();
  const first = await research(f, owner);
  const second = await research(f, owner);
  for (const record of [first, second]) {
    expect((await f.call(narration(record.id), "POST", {}, owner)).status).toBe(202);
    await idle();
  }
  // Given: both jobs were cut off halfway by a restart.
  const db = new Database(f.options.databasePath);
  db.query("UPDATE narrations SET status='speaking', progress_done=1, progress_total=2").run();
  db.close();
  const gate = hold(tts);
  (await f.restart());
  await gate.entered.promise;
  // Then: the one still waiting shows no progress from the cut-off run.
  const states = await Promise.all([first, second].map(async record => (await read(await f.call(narration(record.id), "GET", undefined, owner))).narration));
  expect(states.filter(state => state?.status === "queued")).toEqual([expect.objectContaining({ progress: null })]);
  gate.release.resolve();
  await f.app.narration.idle();
  for (const record of [first, second]) {
    expect((await read(await f.call(narration(record.id), "GET", undefined, owner))).narration).toMatchObject({ status: "ready", progress: null });
  }
});

test("audio whose file is gone from the audio folder is not offered, answers 404 and is made again on the next request", async () => {
  const { f, tts, audioFiles, idle } = (await setup());
  const owner = await f.login();
  const record = await research(f, owner);
  expect((await f.call(narration(record.id), "POST", {}, owner)).status).toBe(202);
  await idle();
  // Given: the audio file left the audio folder.
  const [file] = audioFiles();
  rmSync(join(f.dir, "audio", file ?? ""));
  // Then: no audio is offered, the audio route answers 404, and a new request makes it again.
  expect((await read(await f.call(narration(record.id), "GET", undefined, owner))).narration?.audio).toBeNull();
  expect((await f.call(`${narration(record.id)}/audio`, "GET", undefined, owner)).status).toBe(404);
  expect((await f.call(narration(record.id), "POST", {}, bearer("codex"))).status).toBe(202);
  await idle();
  expect(tts.calls.speak.length).toBe(2);
  const remade = (await read(await f.call(narration(record.id), "GET", undefined, owner))).narration;
  expect(remade?.status).toBe("ready");
  expect((await f.call(remade?.audio?.url ?? "", "GET", undefined, owner)).status).toBe(200);
  expect(audioFiles()).toHaveLength(1);
});

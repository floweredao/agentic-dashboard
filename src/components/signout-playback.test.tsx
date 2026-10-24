import { expect, test } from "bun:test";
import { DashboardRecordSchema } from "../../shared/contracts";

type View = InstanceType<typeof Bun.WebView>;

const record = DashboardRecordSchema.parse({
  id: "00000000-0000-4000-8000-000000000501", kind: "research", title: "비공개 조사", body: "본문",
  source: "chatgpt", createdBy: "chatgpt", reviewState: "approved", archivedAt: null,
  createdAt: "2026-09-28T01:00:00Z", updatedAt: "2026-09-28T01:00:00Z", version: 1, fields: {},
});
const audioPath = `/api/v1/records/${record.id}/narration/audio`;
const narration = {
  narration: {
    recordId: record.id, status: "ready", style: "read", stale: false, progress: null, waitUntil: null, stepAt: null, attempts: 1, error: null,
    requestedBy: "owner", requestedAt: "2026-09-28T01:00:00Z", updatedAt: "2026-09-28T01:01:00Z", script: null,
    audio: { url: audioPath, mime: "audio/wav", bytes: 32044, durationMs: 2000, model: "test-tts", voice: "Test", style: "read", createdAt: "2026-09-28T01:01:00Z" },
  },
  available: true,
};

/** Two seconds of 8 kHz mono 16-bit silence. */
function silence(): ArrayBuffer {
  const samples = 16000;
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (at: number, value: string) => { for (let i = 0; i < value.length; i++) bytes[at + i] = value.charCodeAt(i); };
  ascii(0, "RIFF"); view.setUint32(4, 36 + samples * 2, true); ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true); view.setUint32(28, 16000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  ascii(36, "data"); view.setUint32(40, samples * 2, true);
  return bytes.buffer;
}

const until = (view: View, condition: string) => view.evaluate(`new Promise((resolve, reject) => {
  const read = ${condition};
  const stop = () => { observer.disconnect(); clearInterval(poll); clearTimeout(timer); };
  const check = () => { const value = read(); if (value) { stop(); resolve(value); } };
  const observer = new MutationObserver(check);
  const poll = setInterval(check, 50);
  const timer = setTimeout(() => { stop(); reject(new Error(${JSON.stringify(`timed out: ${condition}`)})); }, 5000);
  observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
  check();
})`);

async function press(view: View, selector: string) {
  const point = await until(view, `() => { const target = document.querySelector(${JSON.stringify(selector)}); if (!target || target.disabled) return null;
    target.scrollIntoView({ block: "center" }); const box = target.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; }`) as { x: number; y: number };
  await view.click(point.x, point.y);
}

test("signing out stops a private record's audio and takes its title off the system media controls", async () => {
  // Given: the app bundle beside a mock API whose one record has finished audio.
  const build = await Bun.build({ entrypoints: [`${import.meta.dir}/../main.tsx`], target: "browser" });
  expect(build.success).toBe(true);
  const [script, styles] = await Promise.all([".js", ".css"].map(extension => build.outputs.find(output => output.path.endsWith(extension))?.text() ?? ""));
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", routes: {
    "/": new Response(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><link rel="stylesheet" href="/app.css"></head><body><script>localStorage.setItem("agentic:locale", "ko")</script><div id="root"></div><script type="module" src="/app.js"></script></body></html>`,
      { headers: { "Content-Type": "text/html; charset=utf-8" } }),
    "/app.js": new Response(script, { headers: { "Content-Type": "text/javascript; charset=utf-8" } }),
    "/app.css": new Response(styles, { headers: { "Content-Type": "text/css; charset=utf-8" } }),
    "/api/v1/config": Response.json({ appName: "Agentic Dashboard", timeZone: "Asia/Seoul", locale: "ko", features: { narration: true, push: false, digest: false, trustedLogin: false } }),
    "/api/v1/auth/session": request => request.method === "DELETE" ? new Response(null, { status: 204 })
      : Response.json({ csrfToken: "csrf-1", expiresAt: "2026-10-06T00:00:00.000Z" }),
    "/api/v1/records": Response.json({ items: [record], nextCursor: null }),
    [`/api/v1/records/${record.id}/narration`]: Response.json(narration),
    [audioPath]: new Response(silence(), { headers: { "Content-Type": "audio/wav" } }),
  } });
  const view = new Bun.WebView({ width: 1024, height: 768 });
  const player = `() => JSON.stringify({ src: document.querySelector("audio")?.getAttribute("src") ?? null,
    paused: document.querySelector("audio")?.paused ?? null, media: navigator.mediaSession?.metadata?.title ?? null })`;
  try {
    await view.navigate(`${server.url.href}#/library/${record.id}`);
    // And: the owner starts listening to it.
    await press(view, ".listen-open");
    await until(view, `() => navigator.mediaSession?.metadata?.title === ${JSON.stringify(record.title)}`);
    expect(JSON.parse(String(await view.evaluate(`(${player})()`)))).toMatchObject({ src: audioPath, media: record.title });

    // When: the owner signs out from Channels.
    await view.evaluate(`location.hash = "#/channels"`);
    await press(view, ".session-section .btn");
    await until(view, `() => document.querySelector(".toast > span")?.textContent === "로그아웃했어요."`);

    // Then: nothing of the record is left playing, loaded or named on the lock screen.
    expect(JSON.parse(String(await view.evaluate(`(${player})()`)))).toEqual({ src: null, paused: true, media: null });
  } finally {
    view.close();
    server.stop(true);
  }
}, 30_000);

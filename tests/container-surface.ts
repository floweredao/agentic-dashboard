import { z } from "zod";

const name = `pr-c-qa-${crypto.randomUUID().slice(0, 8)}`;
const origin = "http://127.0.0.1:4391";
const image = process.env.QA_IMAGE ?? "agentic-dashboard-pr-c:qa";
async function docker(args: readonly string[]) {
  const process = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(process.stdout).text(), process.exited]);
  if (code !== 0) throw new Error(`Docker command ${args[0]} failed (${code})`);
  return out;
}
const container = Bun.spawn(["docker", "run", "--rm", "--name", name, "-p", "127.0.0.1:4391:8080",
  "-e", `APP_ORIGIN=${origin}`, "-e", "PUSH=off", "-e", "NARRATION=off", image], { stdout: "pipe", stderr: "pipe" });
const ready = new TextDecoderStream();
const lines = container.stdout.pipeThrough(ready).getReader();
const timeout = setTimeout(() => { container.kill(); }, 60000);
try {
  let log = "";
  while (!log.includes(" listening on ")) {
    const next = await lines.read();
    if (next.done) throw new Error("Container exited before readiness");
    log += next.value;
  }
  clearTimeout(timeout);
  const health = await fetch(`${origin}/api/health`);
  if (health.status !== 200) throw new Error("Container health failed");
  // This container is disposable; the generated owner key stays in memory and never enters output.
  const credentials = z.object({ owner: z.string() }).parse(JSON.parse(await docker(["exec", name, "bun", "-e",
    'process.stdout.write(await Bun.file("data/credentials.json").text())'])));
  const login = await fetch(`${origin}/api/v1/auth/session`, { method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ token: credentials.owner }) });
  const session = z.object({ csrfToken: z.string() }).parse(await login.json());
  const headers = { Cookie: login.headers.getSetCookie()[0]?.split(";")[0] ?? "", Origin: origin,
    "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken };
  const save = await fetch(`${origin}/api/v1/records`, { method: "POST", headers,
    body: JSON.stringify({ requestId: "container-proof", record: { kind: "note", title: "Container proof", body: "Isolated QA." } }) });
  if (save.status !== 201) throw new Error("Configured origin mutation failed");
  const forbidden = await fetch(`${origin}/api/v1/records`, { method: "POST", headers: { ...headers, Origin: "https://evil.example" }, body: "{}" });
  if (forbidden.status !== 403) throw new Error("Foreign origin was accepted");
  const ffmpeg = (await docker(["exec", name, "ffmpeg", "-version"])).split("\n")[0];
  console.log(JSON.stringify({ health: health.status, configuredOriginMutation: save.status, foreignOrigin: forbidden.status, ffmpeg }));
} finally {
  clearTimeout(timeout);
  await docker(["stop", name]);
  await lines.cancel();
  await container.exited;
}

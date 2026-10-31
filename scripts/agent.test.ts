import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DigestInputSchema } from "../shared/contracts";

test.each(["--briefing", "--briefing-file"])("%s uploads selected sections quietly with the public credential", async flag => {
  // Given: synthetic files and a real HTTP boundary receiving the CLI request.
  const dir = await mkdtemp(join(tmpdir(), "digest-cli-"));
  const received: { body?: unknown; authorization?: string | null } = {};
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      received.authorization = request.headers.get("authorization");
      received.body = await request.json();
      const input = DigestInputSchema.parse(received.body);
      return Response.json({ digest: { ...input, id: "digest-example", version: 1 },
        created: true, changed: input.sections.map(section => section.key), notified: false });
    },
  });
  try {
    await writeFile(join(dir, "news.json"), JSON.stringify({
      edition: "ai-morning", targetScheduledAt: "2026-10-01T08:10:00+09:00",
      articles: { aiDevelopment: [{ eventKey: "sample-ai", title: "Example compiler update", url: "https://example.com/compiler" }] },
      shortfalls: { aiDevelopment: null },
    }));
    const body = { date: "2026-10-01", slot: "08:10", sections: [
      { key: "ai-development", title: "Example AI", kind: "articles", items: [] },
      { key: "social", title: "Example Social", kind: "articles", items: [] },
    ] };
    await writeFile(join(dir, "digest.json"), JSON.stringify(body));
    // When: the CLI selects an input-format section alias and uploads without notification.
    const child = Bun.spawn([process.execPath, "scripts/agent.ts", flag,
      flag === "--briefing" ? dir : join(dir, "digest.json"), "--sections", "aiDevelopment", "--quiet"], {
      cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe", timeout: 10000,
      env: { ...process.env, DASHBOARD_URL: `http://127.0.0.1:${server.port}`, DASHBOARD_TOKEN: "synthetic-test-key" },
    });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    // Then: the public API receives only the chosen section, and stdout reports the saved digest.
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    expect(received.authorization).toBe("Bearer synthetic-test-key");
    const input = DigestInputSchema.parse(received.body);
    expect(input.notify).toBe(false);
    expect(input.sections.map(section => section.key)).toEqual(["ai-development"]);
    expect(JSON.parse(stdout)).toMatchObject({ id: "digest-example", notified: false, changed: ["ai-development"] });
  } finally {
    await server.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
});

test.each([
  ["--briefings", "/api/v1/digests"],
  ["--briefing-reactions", "/api/v1/digests/reactions"],
])("%s reaches its public digest endpoint", async (flag, path) => {
  // Given: a real HTTP boundary serving the list or reaction response.
  const received: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) { received.push(new URL(request.url).pathname); return Response.json({ items: [] }); },
  });
  try {
    // When: the briefing alias is invoked with the public agent key.
    const child = Bun.spawn([process.execPath, "scripts/agent.ts", flag], {
      cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe", timeout: 10000,
      env: { ...process.env, DASHBOARD_URL: `http://127.0.0.1:${server.port}`, DASHBOARD_TOKEN: "synthetic-test-key" },
    });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    // Then: the alias returns the endpoint's response without changing the API route.
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    expect(received).toEqual([path]);
    expect(JSON.parse(stdout)).toEqual({ items: [] });
  } finally {
    await server.stop(true);
  }
});

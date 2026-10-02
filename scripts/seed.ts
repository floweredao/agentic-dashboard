import { join } from "node:path";
import { z } from "zod";
import { createApp } from "../server/app";
import { readCredentials } from "../server/auth";
import { Store } from "../server/store";
import { zonedDate } from "../shared/time";

const usage = `Adds demo agents, records, a task timeline and a digest so you can try the dashboard.

  bun run seed

Uses the same database as the server (DATABASE_PATH, or DATA_DIR/dashboard.sqlite). It refuses a database that already
holds records, so it never mixes demo content into real data; point DATA_DIR at a fresh folder to keep a separate demo.`;
if (Bun.argv.includes("--help")) { console.log(usage); process.exit(0); }

const dataDir = process.env["DATA_DIR"] ?? "data";
const databasePath = process.env["DATABASE_PATH"] ?? join(dataDir, "dashboard.sqlite");
const credentialsPath = process.env["CREDENTIALS_PATH"] ?? join(dataDir, "credentials.json");
const port = Number(process.env["PORT"] ?? 4310);
const origin = `http://127.0.0.1:${port}`;
const timeZone = process.env["TIME_ZONE"] ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
const agentNames = ["research-bot", "claude-code", "codex"] as const;

const probe = new Store(databasePath, Date.now);
const count = z.object({ n: z.number() }).parse(probe.db.query("SELECT count(*) AS n FROM records").get()).n;
const taken = agentNames.filter(name => probe.db.query("SELECT id FROM principals WHERE id=?").get(name));
probe.close();
if (count > 0 || taken.length) {
  console.error(count > 0
    ? `${databasePath} already has ${count} records; demo data goes into an empty database (for example DATA_DIR=demo-data bun run seed).`
    : `Agents ${taken.join(", ")} already exist in ${databasePath}; seed an empty database instead.`);
  process.exit(1);
}

// Demo records arrive over the last few days instead of all at once, so lists group into Today, Yesterday and earlier.
let clock = Date.now();
const at = (hoursAgo: number) => { clock = Date.now() - hoursAgo * 3_600_000; };
at(80);
const app = createApp({ databasePath, credentialsPath, port, timeZone, now: () => clock });
const keys = Object.fromEntries(agentNames.map(name => [name, app.agents.add(name)])) as Record<(typeof agentNames)[number], string>;
const idOf = z.object({ record: z.object({ id: z.string(), version: z.number() }) });
async function call(path: string, method: string, body: unknown, headers: Record<string, string>) {
  const response = await app.fetch(new Request(`${origin}${path}`, { method, headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }));
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${await response.text()}`);
  return await response.json() as unknown;
}
const login = await app.fetch(new Request(`${origin}/api/v1/auth/session`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
  body: JSON.stringify({ token: readCredentials(credentialsPath).owner }) }));
const csrf = z.object({ csrfToken: z.string() }).parse(await login.json()).csrfToken;
const owner = { Cookie: login.headers.get("set-cookie")?.split(";")[0] ?? "", Origin: origin, "X-CSRF-Token": csrf };
const as = (agent: keyof typeof keys) => ({ Authorization: `Bearer ${keys[agent]}` });
let n = 0;
let records = 0;
let comments = 0;
const save = async (headers: Record<string, string>, record: Record<string, unknown>) => {
  records += 1;
  return idOf.parse(await call("/api/v1/records", "POST", { requestId: `demo-${++n}`, record }, headers)).record;
};

at(78);
const project = await save(owner, { kind: "project", title: "Launch the team wiki", status: "active", tags: ["wiki"],
  body: "Move scattered notes into one searchable wiki before the next hiring round.", fields: { nextAction: "Pick a search engine" } });
at(76);
await save(owner, { kind: "project", title: "Home lab clean-up", status: "idea", tags: ["homelab"], body: "Retire the old NAS and document the backups." });
at(50);
const research = await save(as("research-bot"), { kind: "research", title: "Search engines for a small wiki", tags: ["search", "wiki"],
  body: "## Candidates\n\n| Engine | Hosting | Notes |\n|---|---|---|\n| SQLite FTS5 | built in | Zero extra services, good enough below ~1M documents |\n| Meilisearch | one binary | Typo tolerance and facets out of the box |\n| OpenSearch | cluster | Powerful, heavy to operate |\n\nFTS5 covers the wiki's size today; Meilisearch is the upgrade path if typo tolerance matters.",
  links: [{ label: "SQLite FTS5", url: "https://sqlite.org/fts5.html" }, { label: "Meilisearch docs", url: "https://www.meilisearch.com/docs" }],
  fields: { summary: "Compared SQLite FTS5, Meilisearch and OpenSearch for a wiki of about 5,000 pages.\nFTS5 needs no new service and is fast enough at this size.",
    conclusion: "Start with SQLite FTS5 and revisit Meilisearch if people ask for typo tolerance.", nextActions: "- Prototype FTS5 on the current export\n- Measure query time on 5,000 pages" } });
at(30);
await save(as("claude-code"), { kind: "work-report", title: "Dependency updates for September", tags: ["maintenance"],
  body: "Updated 14 packages. Two needed code changes: the router's `loader` signature and a stricter date parser. All tests pass.",
  fields: { summary: "14 packages updated, 2 needed small code changes.\nTest suite and build are green.", conclusion: "Safe to deploy.", nextActions: "- Deploy on Monday\n- Watch error rates for a day" } });
at(26);
await save(as("codex"), { kind: "work-report", title: "Flaky upload test fixed", tags: ["tests", "ci"],
  body: "The upload test waited a fixed 200 ms for the queue. It now waits for the queue's `drained` event with a 5 s timeout.",
  fields: { summary: "Replaced a fixed sleep with an event wait.\n200 consecutive runs passed.", conclusion: "The flake is gone.", nextActions: "- none" } });
at(20);
await save(as("research-bot"), { kind: "note", title: "Backup rule of thumb", tags: ["backup"],
  body: "Three copies, two kinds of storage, one off site. Test a restore every quarter, not just the backup job." });
at(8);
await save(as("research-bot"), { kind: "social", title: "SQLite in production, lessons learned", tags: ["sqlite"],
  links: [{ label: "SQLite: Appropriate Uses", url: "https://sqlite.org/whentouse.html" }],
  fields: { summary: "When SQLite fits a server workload and when a client/server database is the better choice." } });
at(5);
await save(as("claude-code"), { kind: "research", title: "Web push on iOS home-screen apps", tags: ["push", "pwa"],
  body: "Web push works for web apps added to the home screen on iOS 16.4 and later. The permission prompt must follow a user gesture.",
  links: [{ label: "WebKit blog", url: "https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/" }],
  fields: { summary: "iOS supports web push only for home-screen web apps (16.4+).\nAsk for permission from a button tap.", conclusion: "Add an explicit Enable notifications button in Settings.", nextActions: "- Test on a real device" } });
at(4);
const task = await save(as("claude-code"), { kind: "task", title: "Prototype FTS5 search", status: "active", tags: ["wiki"], projectId: project.id,
  fields: { today: true, evidenceIds: [research.id] } });
at(3.5);
await save(owner, { kind: "task", title: "Write the backup runbook", status: "todo", tags: ["backup"], dueDate: zonedDate(new Date(Date.now() + 3 * 86400000), timeZone) });
const comment = (headers: Record<string, string>, body: Record<string, unknown>) => (comments += 1, call("/api/v1/comments", "POST", { requestId: `demo-comment-${++n}`, ...body }, headers));
at(3);
await comment(as("claude-code"), { recordId: task.id, body: "Indexed the 5,000-page export in 1.8 s; typical queries take 2-4 ms.", status: "active" });
at(1.5);
await comment(owner, { recordId: task.id, body: "Nice. Can you add prefix search for titles?" });
at(0.5);
await comment(as("claude-code"), { recordId: task.id, body: "Added `title*` prefix queries and a test. Ready for a look.", status: "review" });

const today = zonedDate(new Date(), timeZone);
at(0.3);
await call("/api/v1/digests", "POST", { date: today, slot: "morning", notify: false, sections: [
  { key: "inbox", title: "Mail", kind: "messages", items: [
    { key: "m1", importance: "urgent", from: "Billing", address: "billing@example.com", subject: "Card expires this week", summary: "The card on the hosting account expires on Friday.", action: "Update the card before Friday" },
    { key: "m2", importance: "check", from: "Ana", address: "ana@example.com", subject: "Wiki outline draft", summary: "Ana shared a first outline for the wiki and asks for comments." },
  ] },
  { key: "tech", title: "Tech", kind: "articles", items: [
    { key: "a1", title: "SQLite adds faster JSON functions", source: "Example News", summary: "The new release speeds up json_extract on large documents.", url: "https://example.com/news/sqlite-json" },
    { key: "a2", title: "A practical guide to web push", source: "Example Dev", summary: "Step-by-step setup of VAPID keys and service workers.", url: "https://example.com/news/web-push" },
  ] },
  { key: "world", title: "World", kind: "articles", items: [
    { key: "w1", title: "Open data portal adds transit feeds", source: "Example Times", summary: "Real-time transit data is now available under an open licence.", url: "https://example.com/news/transit" },
  ] },
] }, as("research-bot"));
at(15);
const yesterday = zonedDate(new Date(Date.now() - 86_400_000), timeZone);
await call("/api/v1/digests", "POST", { date: yesterday, slot: "evening", notify: false, sections: [
  { key: "releases", title: "Releases", kind: "articles", items: [
    { key: "r1", title: "Vite adds a faster dev server cache", source: "Example Dev", summary: "Cold starts are about twice as fast on large projects.", url: "https://example.com/news/vite-cache" },
    { key: "r2", title: "Hono 5 beta is out", source: "Example Dev", summary: "Smaller core and typed middleware chains.", url: "https://example.com/news/hono-5" } ] },
  { key: "alerts", title: "Alerts", kind: "messages", items: [
    { key: "x1", importance: "todo", from: "Uptime monitor", subject: "Wiki staging was down for 4 minutes", summary: "It recovered on its own at 18:12.", action: "Check the staging logs" } ] },
] }, as("research-bot"));
app.close();
console.log(`Added demo agents (${agentNames.join(", ")}), ${records} records, ${comments} task comments and two digests to ${databasePath}.
The demo agents' keys were not saved; add your own agents with bun run agents add <name>.`);

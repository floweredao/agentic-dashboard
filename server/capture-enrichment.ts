import { z } from "zod";
import { abortable, CAPTURE_BYTES, CaptureUnavailable, fetchPublicPage, publicUrl } from "./capture-http";

export interface CaptureEnrichment {
  readonly title: string;
  readonly fields: {
    readonly summary: string;
    readonly captureEnrichment: {
      readonly status: "available" | "partial" | "unavailable";
      readonly source: "page" | "github" | "url";
      readonly titleSource?: string;
      readonly summarySource?: string;
      readonly reason?: string;
    };
  };
}
export interface EnrichmentDependencies {
  readonly page?: (url: URL, signal: AbortSignal) => Promise<string>;
  readonly github?: (args: readonly string[], signal: AbortSignal) => Promise<string>;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}
const entities: Readonly<Record<string, string>> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ensp: " ", emsp: " ", thinsp: " ",
  ndash: "\u2013", mdash: "\u2014", hellip: "\u2026", lsquo: "\u2018", rsquo: "\u2019",
  ldquo: "\u201c", rdquo: "\u201d", laquo: "\u00ab", raquo: "\u00bb", copy: "\u00a9",
  reg: "\u00ae", trade: "\u2122", bull: "\u2022", middot: "\u00b7", times: "\u00d7",
  euro: "\u20ac", pound: "\u00a3", yen: "\u00a5", cent: "\u00a2",
};
function plain(value: string, limit: number): string {
  // HTMLRewriter returns raw entities in both attributes and text; decode exactly once.
  const decoded = value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match: string, entity: string) => {
    if (!entity.startsWith("#")) return entities[entity] ?? (entity === entity.toUpperCase() ? entities[entity.toLowerCase()] : undefined) ?? match;
    const code = /^#x/i.test(entity) ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "\ufffd";
  });
  return decoded.replace(/<[^<>]*>/g, " ").replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, limit).replace(/[\uD800-\uDBFF]$/, "").trim();
}
export function captureFallback(url: URL, reason = "unavailable"): CaptureEnrichment {
  let pathname = url.pathname;
  try { pathname = decodeURIComponent(pathname); }
  catch (error) { if (!(error instanceof URIError)) throw error; }
  return {
    title: plain(`${url.hostname}${pathname === "/" ? "" : pathname}`, 200) || url.hostname.slice(0, 200),
    fields: { summary: "", captureEnrichment: { status: "unavailable", source: "url", reason } },
  };
}
async function readHtml(html: string) {
  let title = "";
  let article = "";
  let main = "";
  let body = "";
  const metadata = new Map<string, string>();
  const cleaned = await new HTMLRewriter()
    .on("script, style, noscript, template, svg, nav, footer, header, aside, form, [hidden], [aria-hidden='true']", { element(element) { element.remove(); } })
    .on("p, div, section, h1, h2, h3, h4, li, br", { element(element) { element.before(" "); element.after(" "); } })
    .transform(new Response(html)).text();
  await new HTMLRewriter()
    .on("title", { text(chunk) { title += chunk.text; } })
    .on("meta", { element(element) {
      const key = (element.getAttribute("property") ?? element.getAttribute("name") ?? "").toLowerCase();
      const value = element.getAttribute("content");
      if (value && !metadata.has(key)) metadata.set(key, value);
    } })
    .on("article", { text(chunk) { article += chunk.text; } })
    .on("main", { text(chunk) { main += chunk.text; } })
    .on("body", { text(chunk) { body += chunk.text; } })
    .transform(new Response(cleaned)).text();
  return { title, metadata, article, main, body };
}
export async function parseCapturePage(html: string, url: URL): Promise<CaptureEnrichment> {
  if (Buffer.byteLength(html) > CAPTURE_BYTES) throw new CaptureUnavailable("too_large");
  const { title, metadata, article, main } = await readHtml(html);
  const titleCandidates = [["og:title", metadata.get("og:title") ?? ""], ["title", title]] as const;
  const summaryCandidates = [
    ["og:description", metadata.get("og:description") ?? ""], ["description", metadata.get("description") ?? ""],
    ["article", article], ["main", main],
  ] as const;
  const selectedTitle = titleCandidates.map(([source, value]) => ({ source, text: plain(value, 200) })).find(value => value.text);
  const selectedSummary = summaryCandidates.map(([source, value]) => ({ source, text: plain(value, 500) })).find(value => value.text);
  if (!selectedTitle && !selectedSummary) return captureFallback(url, "empty");
  return {
    title: selectedTitle?.text ?? captureFallback(url).title,
    fields: { summary: selectedSummary?.text ?? "", captureEnrichment: {
      status: selectedSummary && selectedTitle ? "available" : "partial", source: "page",
      titleSource: selectedTitle?.source ?? "url", summarySource: selectedSummary?.source ?? "none",
    } },
  };
}

/** Fixed argv only; stderr never enters records or logs. stdout and the entire child lifetime are bounded. */
export async function runGithub(args: readonly string[], signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  // GitHub metadata comes from an authenticated GitHub CLI when the host has one; without it the page itself is read.
  if (Bun.which("gh") === null) throw new CaptureUnavailable("github");
  const child = Bun.spawn(["gh", ...args], {
    stdin: "ignore", stdout: "pipe", stderr: "ignore",
    env: { ...process.env, GH_HOST: "github.com", GH_DEBUG: "", GH_PROMPT_DISABLED: "1", GH_PAGER: "cat" },
  });
  const reader = child.stdout.getReader();
  const stop = () => { child.kill("SIGKILL"); };
  signal.addEventListener("abort", stop, { once: true });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await abortable(reader.read(), signal);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > CAPTURE_BYTES) throw new CaptureUnavailable("too_large");
      chunks.push(value);
    }
    if (await abortable(child.exited, signal) !== 0) throw new CaptureUnavailable("github");
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    signal.removeEventListener("abort", stop);
    if (child.exitCode === null) stop();
    await reader.cancel();
    reader.releaseLock();
    await child.exited;
  }
}

const repoSchema = z.object({ full_name: z.string().min(1).max(200), description: z.string().nullable() });
const readmeSchema = z.object({ encoding: z.literal("base64"), content: z.string(), size: z.number().int().nonnegative().max(CAPTURE_BYTES) });

/** Enrich one URL without persisting it. Backfills must merge fields and use the authenticated PATCH API. */
export async function enrichCapture(url: URL, dependencies: EnrichmentDependencies = {}): Promise<CaptureEnrichment> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), dependencies.timeoutMs ?? 8000);
  const signal = dependencies.signal ? AbortSignal.any([controller.signal, dependencies.signal]) : controller.signal;
  try {
    publicUrl(url);
    signal.throwIfAborted();
    // Only original root github.com repository URLs can select the authenticated adapter.
    const repo = url.hostname === "github.com" && !url.port
      ? /^\/([a-z0-9](?:[a-z0-9-]{0,38}))\/([a-z0-9_.-]{1,100})\/?$/i.exec(url.pathname) : null;
    if (repo && repo[2] !== "." && repo[2] !== "..") {
      const owner = repo[1];
      const name = repo[2]?.replace(/\.git$/i, "");
      if (!owner || !name) throw new CaptureUnavailable("unsupported");
      const endpoint = `repos/${owner}/${name}`;
      const github = dependencies.github ?? runGithub;
      const args = ["api", "--hostname", "github.com", "--method", "GET", "-H", "Accept: application/vnd.github+json"];
      const raw = await abortable(github([...args, endpoint], signal), signal);
      if (Buffer.byteLength(raw) > CAPTURE_BYTES) throw new CaptureUnavailable("too_large");
      const data = repoSchema.parse(JSON.parse(raw));
      let summary = plain(data.description ?? "", 500);
      let summarySource = summary ? "repository-description" : "none";
      if (!summary) {
        try {
          const rawReadme = await abortable(github([...args, `${endpoint}/readme`], signal), signal);
          if (Buffer.byteLength(rawReadme) > CAPTURE_BYTES) throw new CaptureUnavailable("too_large");
          const readme = readmeSchema.parse(JSON.parse(rawReadme));
          const text = Buffer.from(readme.content, "base64").toString("utf8");
          const parsed = await parseCapturePage(`<main>${Bun.markdown.html(text)}</main>`, url);
          summary = parsed.fields.summary;
          if (summary) summarySource = "readme-excerpt";
        } catch (error) {
          // Metadata is already useful; README failure must not discard the repository name.
          if (!(error instanceof Error)) throw error;
        }
      }
      return { title: plain(data.full_name, 200) || captureFallback(url).title,
        fields: { summary, captureEnrichment: { status: summary ? "available" : "partial", source: "github",
          titleSource: "repository-full-name", summarySource } } };
    }
    const html = await abortable((dependencies.page ?? fetchPublicPage)(url, signal), signal);
    return await parseCapturePage(html, url);
  } catch (error) {
    // This optional enrichment boundary must never lose a validated URL or disclose remote errors.
    if (!(error instanceof Error)) throw error;
    return captureFallback(url, signal.aborted ? "timeout" : error instanceof CaptureUnavailable ? error.reason : "network");
  } finally { clearTimeout(timer); }
}

/** Model input: every title/description candidate plus visible body text, deduplicated and bounded. */
export async function pageText(html: string): Promise<string> {
  const page = await readHtml(html.slice(0, CAPTURE_BYTES));
  const candidates: readonly (readonly [string, string, number])[] = [
    ["title", page.title, 300],
    ...["og:title", "twitter:title", "og:description", "twitter:description", "description"]
      .map(key => [key, page.metadata.get(key) ?? "", 600] as const),
    ["body", page.article || page.main || page.body, 4000],
  ];
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const [key, raw, limit] of candidates) {
    const text = plain(raw, limit);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    lines.push(`${key}: ${text}`);
  }
  return lines.join("\n");
}

/** Re-read a saved public URL for model input; errors propagate so callers can fall back to stored values. */
export async function captureSource(url: URL, dependencies: EnrichmentDependencies = {}): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), dependencies.timeoutMs ?? 8000);
  const signal = dependencies.signal ? AbortSignal.any([controller.signal, dependencies.signal]) : controller.signal;
  try {
    publicUrl(url);
    return await pageText(await abortable((dependencies.page ?? fetchPublicPage)(url, signal), signal));
  } finally { clearTimeout(timer); }
}

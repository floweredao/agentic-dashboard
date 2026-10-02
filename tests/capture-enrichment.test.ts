import { expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { captureFallback, enrichCapture, parseCapturePage } from "../server/capture-enrichment";
import { CAPTURE_BYTES, CaptureUnavailable, fetchPublicPage, isPublicAddress, requestPage, type PageNetwork } from "../server/capture-http";
import { RecordInputSchema } from "../shared/contracts";

const original = new URL("https://example.com/article?original=1#part");
const safeAddress = { address: "93.184.216.34", family: 4 };
const htmlResponse = { status: 200, contentType: "text/html; charset=utf-8", body: "<title>Page</title><main>Article text.</main>" };

test("extracts OG title and description and decodes HTMLRewriter's raw entities", async () => {
  // Given: conflicting metadata, numeric/named entities and markup in attributes.
  const html = `<title>Wrong title</title><meta property="og:title" content="A &amp; B &#x1F331; &quot;Guide&quot;">
    <meta name="description" content="Wrong summary"><meta property="og:description" content="Read &lt;b&gt;this&lt;/b&gt; &nbsp; &#54620;&#44544; &mdash; today.">
    <article>Wrong excerpt</article>`;
  // When: metadata is parsed without executing or rendering the page.
  const result = await parseCapturePage(html, original);
  // Then: actual metadata becomes plain text, with explicit extractive provenance.
  expect(result.title).toBe('A & B 🌱 "Guide"');
  expect(result.fields.summary).toBe("Read this 한글 — today.");
  expect(result.fields.captureEnrichment).toEqual({ status: "available", source: "page", titleSource: "og:title", summarySource: "og:description" });
});

test("preserves plain comparisons before inline markup in metadata", async () => {
  // Given: source text contains a literal less-than comparison and an HTML tag.
  const html = '<title>Comparison</title><meta name="description" content="3 &lt; 5 and &lt;b&gt;valid&lt;/b&gt;">';
  // When: the description is decoded into a plain summary.
  const result = await parseCapturePage(html, original);
  // Then: removing markup does not remove the neighboring source text.
  expect(result.fields.summary).toBe("3 < 5 and valid");
});

test("falls back to page title and article text, excluding hidden and navigation content", async () => {
  // Given: no usable description and article text split across inline and block elements.
  const html = `<title>Guide &amp; reference</title><meta name="description" content=" ">
    <main>Main alternative<article><nav>Navigation</nav><p>Use <strong>Shortcuts</strong> today.</p>
    <script>secret()</script><style>.secret{}</style><p hidden>Hidden</p><aside>Ads</aside>
    <p>Second &lt;literal&gt; paragraph.</p><footer>Footer</footer></article></main>`;
  // When: the parser falls back to the article.
  const result = await parseCapturePage(html, original);
  // Then: text is readable and adjacent blocks are separated.
  expect(result.title).toBe("Guide & reference");
  expect(result.fields.summary).toBe("Use Shortcuts today. Second paragraph.");
  expect(result.fields.captureEnrichment.summarySource).toBe("article");
});

test("uses main text when no article exists and bounds title, summary and serialized fields", async () => {
  // Given: long UTF-8 text and no article/description.
  const html = `<title>${"긴".repeat(400)}</title><main>${"본문 ".repeat(600)}</main>`;
  // When: the output crosses the record schema.
  const result = await parseCapturePage(html, original);
  const record = RecordInputSchema.parse({ kind: "social", ...result });
  // Then: limits fit both strings and the 8 KiB fields budget.
  expect(record.title.length).toBe(200);
  expect(String(record.fields.summary).length).toBeLessThanOrEqual(500);
  expect(Buffer.byteLength(JSON.stringify(record.fields))).toBeLessThan(8192);
  expect(result.fields.captureEnrichment.summarySource).toBe("main");
});

test.each([
  { html: "<title>Title only</title>", title: "Title only", summary: "", status: "partial" },
  { html: "<main>Summary only</main>", title: "example.com/article", summary: "Summary only", status: "partial" },
  { html: "<body><nav>No article</nav></body>", title: "example.com/article", summary: "", status: "unavailable" },
])("reports truthful $status content", async ({ html, title, summary, status }) => {
  // Given/When: incomplete source content is extracted.
  const result = await parseCapturePage(html, original);
  // Then: missing content is not fabricated.
  expect(result).toMatchObject({ title, fields: { summary, captureEnrichment: { status } } });
});

test("preserves a readable URL fallback when public fetching fails", async () => {
  // Given: a remote page cannot be retrieved.
  const url = new URL("https://example.com/%ED%95%9C%EA%B8%80?secret=not-a-title");
  // When: enrichment encounters a transport error.
  const result = await enrichCapture(url, { page: async () => { throw new Error("Remote diagnostic must not leak"); } });
  // Then: title is URL-derived, not invented; the raw error is never persisted.
  expect(result).toEqual({ title: "example.com/한글", fields: { summary: "", captureEnrichment: { status: "unavailable", source: "url", reason: "network" } } });
  expect(captureFallback(new URL("https://example.com/")).title).toBe("example.com");
});

test("uses bounded fixed GitHub API argv for a private root repository", async () => {
  // Given: the authenticated CLI returns metadata for a private repo.
  const calls: (readonly string[])[] = [];
  const url = new URL("https://github.com/example-org/example-repo?tab=readme#intro");
  // When: the original root URL selects the dedicated adapter.
  const result = await enrichCapture(url, {
    github: async args => { calls.push(args); return JSON.stringify({ full_name: "example-org/example-repo", private: true, description: "Private local-first dashboard for projects, tasks, research, and agent-recorded work" }); },
    page: async () => { throw new Error("Private GitHub must not use public scraping"); },
  });
  // Then: metadata is useful and only the allowlisted repository endpoint is requested.
  expect(result.title).toBe("example-org/example-repo");
  expect(result.fields.summary).toBe("Private local-first dashboard for projects, tasks, research, and agent-recorded work");
  expect(result.fields.captureEnrichment).toMatchObject({ status: "available", source: "github", summarySource: "repository-description" });
  expect(calls).toEqual([["api", "--hostname", "github.com", "--method", "GET", "-H", "Accept: application/vnd.github+json", "repos/example-org/example-repo"]]);
  expect(url.href).toBe("https://github.com/example-org/example-repo?tab=readme#intro");
});

test("extracts a README only when repository description is empty", async () => {
  // Given: metadata with no description and a Markdown README with safe extractable text.
  const endpoints: string[] = [];
  const readme = "# Dashboard\n\nManage **projects** &amp; tasks.\n\n<script>not content</script>";
  // When: enrichment requests the one additional fixed README endpoint.
  const result = await enrichCapture(new URL("https://github.com/owner/project.git/"), {
    github: async args => {
      const endpoint = args.at(-1) ?? ""; endpoints.push(endpoint);
      return JSON.stringify(endpoint.endsWith("/readme")
        ? { content: Buffer.from(readme).toString("base64"), encoding: "base64", size: Buffer.byteLength(readme) }
        : { full_name: "owner/project", description: null });
    },
  });
  // Then: the summary is an excerpt, not an AI-written claim.
  expect(endpoints).toEqual(["repos/owner/project", "repos/owner/project/readme"]);
  expect(result.fields.summary).toBe("Dashboard Manage projects & tasks.");
  expect(result.fields.captureEnrichment.summarySource).toBe("readme-excerpt");
});

test("keeps repository metadata when README is unavailable", async () => {
  // Given: a usable repo name, but no README.
  // When: the optional README request fails.
  const result = await enrichCapture(new URL("https://github.com/owner/project"), {
    github: async args => {
      if (args.at(-1)?.endsWith("/readme")) throw new CaptureUnavailable("github");
      return '{"full_name":"owner/project","description":null}';
    },
  });
  // Then: the partial result truthfully identifies the missing summary.
  expect(result).toMatchObject({ title: "owner/project", fields: { summary: "", captureEnrichment: { status: "partial", source: "github", summarySource: "none" } } });
});

test.each(["https://github.com/owner/repo/issues/1", "https://github.com/owner/repo%3Bcommand",
  "https://github.com/owner/repo/contents", "https://github.com.evil.com/owner/repo", "https://github.com:8443/owner/repo"])(
  "never selects an arbitrary authenticated GitHub endpoint for %s", async value => {
    // Given: a URL outside the root-repository grammar.
    let github = 0;
    // When: enrichment chooses its transport.
    const result = await enrichCapture(new URL(value), { github: async () => { github++; return ""; }, page: async () => htmlResponse.body });
    // Then: no authenticated CLI call is made.
    expect(github).toBe(0);
    expect(result.fields.captureEnrichment.source).toBe("page");
  },
);

test.each(["0.0.0.0", "10.0.0.1", "100.64.0.1", "100.127.255.254", "127.0.0.1", "169.254.169.254",
  "172.16.0.1", "192.168.1.1", "192.0.0.9", "198.18.0.1", "224.0.0.1", "255.255.255.255",
  "::1", "::", "::ffff:127.0.0.1", "::ffff:192.168.1.1", "::ffff:7f00:1", "fc00::1", "fe80::1",
  "64:ff9b::a00:1", "2002:7f00:1::1", "2001:db8::1", "not-an-ip"])("rejects non-public address %s", address => {
  // Given/When/Then: only real globally routable addresses can become connection pins.
  expect(isPublicAddress(address)).toBe(false);
});
test.each(["93.184.216.34", "8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])("accepts public address %s", address => {
  expect(isPublicAddress(address)).toBe(true);
});

test.each(["http://127.1/a", "http://2130706433/a", "http://[::ffff:7f00:1]/a", "http://localhost/a",
  "http://service.local/a", "http://machine/a", "https://name:password@example.com/a", "ftp://example.com/a"])(
  "does no DNS or network work for unsafe original URL %s", async value => {
    // Given: resolvers and connections would be observable.
    let calls = 0;
    const io: PageNetwork = { resolve: async () => { calls++; return [safeAddress]; }, request: async () => { calls++; return htmlResponse; } };
    // When: URL policy is applied before either seam.
    await expect(fetchPublicPage(new URL(value), new AbortController().signal, io)).rejects.toMatchObject({ reason: "unsafe_url" });
    // Then: no egress took place.
    expect(calls).toBe(0);
  },
);

test.each(["127.0.0.1", "100.64.0.2", "::ffff:127.0.0.1", "fe80::1"])("rejects mixed public/private DNS answers containing %s", async address => {
  // Given: even the first DNS answer is public, another answer is not.
  let connections = 0;
  const io: PageNetwork = {
    resolve: async () => [safeAddress, { address, family: address.includes(":") ? 6 : 4 }],
    request: async () => { connections++; return htmlResponse; },
  };
  // When: DNS is validated.
  await expect(fetchPublicPage(original, new AbortController().signal, io)).rejects.toMatchObject({ reason: "unsafe_url" });
  // Then: no address from that answer set is used.
  expect(connections).toBe(0);
});

test("selects IPv4 when DNS returns IPv6 first on dual-stack pages", async () => {
  // Given: both families are public, but the host's IPv6 route may be unavailable.
  let selectedFamily = 0;
  const io: PageNetwork = {
    resolve: async () => [{ address: "2606:4700:4700::1111", family: 6 }, safeAddress],
    request: async (_url, address) => { selectedFamily = address.family; return htmlResponse; },
  };
  // When: the fetcher selects the address it will pin.
  await fetchPublicPage(original, new AbortController().signal, io);
  // Then: the available IPv4 candidate takes precedence over DNS answer order.
  expect(selectedFamily).toBe(4);
});

test("pins the validated address without resolving again, including each redirect", async () => {
  // Given: subsequent DNS queries would return loopback (a rebinding attempt).
  const resolved: string[] = [];
  const connected: { url: string; address: string }[] = [];
  const io: PageNetwork = {
    resolve: async host => { resolved.push(host); return [resolved.length <= 2 ? safeAddress : { address: "127.0.0.1", family: 4 }]; },
    request: async (url, address) => {
      connected.push({ url: url.href, address: address.address });
      return connected.length === 1 ? { ...htmlResponse, status: 302, location: "https://other.example.com/final" } : htmlResponse;
    },
  };
  // When: the redirect is followed.
  expect(await fetchPublicPage(original, new AbortController().signal, io)).toBe(htmlResponse.body);
  // Then: each hop receives exactly its validated pin and retains its original hostname.
  expect(resolved).toEqual(["example.com", "other.example.com"]);
  expect(connected).toEqual([{ url: original.href, address: safeAddress.address }, { url: "https://other.example.com/final", address: safeAddress.address }]);
});

test.each(["http://127.0.0.1/admin", "http://[::ffff:192.168.1.1]/", "http://name:secret@example.com/",
  "file:///etc/passwd", "http://service.local/"])("rejects unsafe redirect %s before following it", async location => {
  // Given: a public site redirects toward a forbidden destination.
  let connections = 0;
  const io: PageNetwork = { resolve: async () => [safeAddress], request: async () => { connections++; return { ...htmlResponse, status: 302, location }; } };
  // When: redirect validation runs.
  await expect(fetchPublicPage(original, new AbortController().signal, io)).rejects.toMatchObject({ reason: "unsafe_url" });
  // Then: only the initial safe hop occurred.
  expect(connections).toBe(1);
});

test("validates redirect DNS even when the redirect hostname looks public", async () => {
  // Given: a redirected public-looking hostname resolves to private space.
  let connections = 0;
  const io: PageNetwork = {
    resolve: async host => [host === "example.com" ? safeAddress : { address: "192.168.1.1", family: 4 }],
    request: async () => { connections++; return { ...htmlResponse, status: 302, location: "https://other.example.com" }; },
  };
  // When: the redirect resolves.
  await expect(fetchPublicPage(original, new AbortController().signal, io)).rejects.toMatchObject({ reason: "unsafe_url" });
  // Then: private resolution did not cause a connection.
  expect(connections).toBe(1);
});

test("bounds redirects and never switches redirect targets to authenticated GitHub", async () => {
  // Given: a redirect loop ending at a GitHub-looking URL.
  let connections = 0;
  let github = 0;
  const io: PageNetwork = {
    resolve: async () => [safeAddress],
    request: async () => { connections++; return { ...htmlResponse, status: 302, location: "https://github.com/owner/repo" }; },
  };
  // When: page enrichment exhausts its redirect budget.
  const result = await enrichCapture(original, { page: (url, signal) => fetchPublicPage(url, signal, io), github: async () => { github++; return ""; } });
  // Then: only four HTTP requests occur, and credentials are never introduced.
  expect(connections).toBe(4); expect(github).toBe(0);
  expect(result.fields.captureEnrichment.reason).toBe("redirects");
});

test("aborts unresolved DNS and never connects after its late completion", async () => {
  // Given: a DNS request that only resolves after cancellation.
  const controller = new AbortController();
  const pending = Promise.withResolvers<readonly { address: string; family: number }[]>();
  let connections = 0;
  const io: PageNetwork = { resolve: () => { controller.abort(); return pending.promise; }, request: async () => { connections++; return htmlResponse; } };
  // When: cancellation interrupts name resolution.
  const result = await enrichCapture(original, { signal: controller.signal, page: (url, signal) => fetchPublicPage(url, signal, io) });
  pending.resolve([safeAddress]);
  // Then: capture has a truthful timeout result rather than a late connection.
  expect(result.fields.captureEnrichment.reason).toBe("timeout");
  expect(connections).toBe(0);
});

test("bounds the whole enrichment deadline even when a GitHub adapter never resolves", async () => {
  // Given: time itself is under test; the adapter never completes.
  // When: the total deadline expires (no sleeps or polling).
  const result = await enrichCapture(new URL("https://github.com/owner/project"), { timeoutMs: 5, github: () => new Promise(() => {}) });
  // Then: optional metadata cannot indefinitely block saving a URL.
  expect(result.fields.captureEnrichment.reason).toBe("timeout");
}, 1000);

test.each([
  { status: 403, contentType: "text/html", reason: "http" },
  { status: 200, contentType: "application/pdf", reason: "unsupported" },
])("reports $reason for unavailable public content", async ({ status, contentType, reason }) => {
  // Given/When: a non-success or unsupported representation is returned.
  const result = await enrichCapture(original, { page: (url, signal) => fetchPublicPage(url, signal, {
    resolve: async () => [safeAddress], request: async () => ({ ...htmlResponse, status, contentType }),
  }) });
  // Then: no content is invented.
  expect(result.fields.summary).toBe("");
  expect(result.fields.captureEnrichment.reason).toBe(reason);
});

test("real HTTP transport uses the supplied connection pin and sends no credentials", async () => {
  // Given: a deliberately unresolvable hostname, and an isolated loopback transport fixture.
  let headers: Headers | undefined;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    headers = request.headers;
    return new Response(htmlResponse.body, { headers: { "Content-Type": "text/html" } });
  } });
  try {
    // When: the low-level transport receives the test's explicit loopback pin (policy tested separately).
    const result = await requestPage(new URL(`http://unresolvable.invalid:${server.port}/a`), { address: "127.0.0.1", family: 4 }, AbortSignal.timeout(1000));
    // Then: no second DNS lookup was needed; HTTP Host was preserved, with no cookie/auth headers.
    expect(result.body).toBe(htmlResponse.body);
    expect(headers?.get("host")).toBe(`unresolvable.invalid:${server.port}`);
    expect(headers?.get("cookie")).toBeNull();
    expect(headers?.get("authorization")).toBeNull();
  } finally { await server.stop(true); }
});

test.each(["declared", "streamed", "gzip"] as const)("keeps only the first CAPTURE_BYTES of a %s oversized page over the real transport", async kind => {
  // Given: an oversized page with its metadata in the head, including compressed content with a small wire representation.
  const body = `<title>Head title</title>${"x".repeat(CAPTURE_BYTES + 1)}`;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    if (kind === "gzip") return new Response(gzipSync(body), { headers: { "Content-Type": "text/html", "Content-Encoding": "gzip" } });
    if (kind === "declared") return new Response(body, { headers: { "Content-Type": "text/html" } });
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(Buffer.from(body)); controller.close(); } }), { headers: { "Content-Type": "text/html" } });
  } });
  try {
    // When: the real stream is read past the decoded limit.
    const result = await requestPage(new URL(`http://fixture.invalid:${server.port}/`), { address: "127.0.0.1", family: 4 }, AbortSignal.timeout(1000));
    // Then: the retained body is truncated to the bound and still parses.
    expect(result.body.length).toBe(CAPTURE_BYTES);
    expect((await parseCapturePage(result.body, original)).title).toBe("Head title");
  } finally { await server.stop(true); }
});

test("cancels a real HTTP connection that stalls before headers", async () => {
  // Given: a server accepts the connection but never sends headers.
  const controller = new AbortController();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    controller.abort();
    return new Promise<Response>(() => {});
  } });
  try {
    // When: the exact acceptance event triggers cancellation.
    await expect(requestPage(new URL(`http://fixture.invalid:${server.port}/`), { address: "127.0.0.1", family: 4 }, controller.signal)).rejects.toBeInstanceOf(Error);
  } finally { await server.stop(true); }
});

test("extracts metadata from ordinary guide pages larger than 512 KiB", async () => {
  // Given: a documentation page comparable to the live Apple guide.
  const html = `<title>Documentation guide</title><meta name="description" content="Use the sharing menu."><!--${"x".repeat(600 * 1024)}-->`;
  // When: metadata is extracted from that bounded page.
  const result = await parseCapturePage(html, original);
  // Then: an ordinary page does not silently become a bare URL.
  expect(result.title).toBe("Documentation guide");
  expect(result.fields.summary).toBe("Use the sharing menu.");
});

test("bounds parser input and GitHub metadata before retaining content", async () => {
  // Given: oversized remote representations.
  const oversized = "x".repeat(CAPTURE_BYTES + 1);
  // When: either parser or authenticated adapter receives it.
  await expect(parseCapturePage(oversized, original)).rejects.toMatchObject({ reason: "too_large" });
  const result = await enrichCapture(new URL("https://github.com/owner/repo"), { github: async () => oversized });
  // Then: no oversized source is stored.
  expect(result.fields.captureEnrichment.reason).toBe("too_large");
});

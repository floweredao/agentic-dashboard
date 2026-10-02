import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { PassThrough, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

export const CAPTURE_BYTES = 1024 * 1024;
export class CaptureUnavailable extends Error {
  constructor(readonly reason: "unsafe_url" | "dns" | "network" | "timeout" | "too_large" | "redirects" | "unsupported" | "http" | "github" | "empty") {
    super(reason);
  }
}
export interface CaptureAddress { readonly address: string; readonly family: number }
export interface PageResponse {
  readonly status: number;
  readonly location?: string;
  readonly contentType: string;
  readonly body: string;
}
export interface PageNetwork {
  readonly resolve: (hostname: string) => Promise<readonly CaptureAddress[]>;
  readonly request: (url: URL, address: CaptureAddress, signal: AbortSignal) => Promise<PageResponse>;
}

const blockedV4 = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blockedV4.addSubnet(address, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
const blockedV6 = new BlockList();
for (const [address, prefix] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]] as const) {
  blockedV6.addSubnet(address, prefix, "ipv6");
}
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blockedV4.check(address, "ipv4");
  // Only native global unicast: excludes mapped IPv4, ULA, link-local and transition prefixes.
  return family === 6 && globalV6.check(address, "ipv6") && !blockedV6.check(address, "ipv6");
}
export function publicUrl(url: URL): string {
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.href.length > 2048 ||
    /[\u0000-\u0020\u007f]/u.test(url.href) || host.endsWith(".") ||
    (!isIP(host) && (!host.includes(".") || /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid)$/.test(host))) ||
    (isIP(host) && !isPublicAddress(host))) throw new CaptureUnavailable("unsafe_url");
  return host;
}

// DNS itself is not cancellable on every platform; never let a late result initiate a connection.
export async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(new CaptureUnavailable("timeout"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([promise, cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
}

function byteLimit(limit: number) {
  let bytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.byteLength;
      callback(bytes > limit ? new CaptureUnavailable("too_large") : null, chunk);
    },
  });
}

/** Low-level transport. Only fetchPublicPage supplies validated addresses in production.
 * Decoded HTML is kept up to CAPTURE_BYTES and the connection is closed there: metadata sits in the head. */
export function requestPage(url: URL, address: CaptureAddress, signal: AbortSignal): Promise<PageResponse> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      agent: false, signal, maxHeaderSize: 16 * 1024,
      headers: { Accept: "text/html,application/xhtml+xml", "Accept-Encoding": "gzip, deflate, br", "User-Agent": "agentic-dashboard-capture/1" },
      // Keep the original Host and TLS servername, but never resolve it again at connection time.
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, [{ address: address.address, family: address.family }]);
        else callback(null, address.address, address.family);
      },
    }, response => {
      const status = response.statusCode ?? 0;
      const contentType = response.headers["content-type"] ?? "";
      const result = { status, contentType, ...(response.headers.location ? { location: response.headers.location } : {}) };
      if (status < 200 || status >= 300) {
        response.destroy();
        resolve({ ...result, body: "" });
        return;
      }
      if (!/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(contentType)) {
        response.destroy(); reject(new CaptureUnavailable("unsupported")); return;
      }
      const encoding = response.headers["content-encoding"]?.toLowerCase() ?? "identity";
      const decoder = encoding === "gzip" ? createGunzip() : encoding === "deflate" ? createInflate()
        : encoding === "br" ? createBrotliDecompress() : encoding === "identity" ? new PassThrough() : null;
      if (!decoder) { response.destroy(); reject(new CaptureUnavailable("unsupported")); return; }
      const chunks: Buffer[] = [];
      let kept = 0;
      let complete = false;
      const finish = () => {
        complete = true;
        const charset = /charset\s*=\s*["']?([^;"'\s]+)/i.exec(contentType)?.[1] ?? "utf-8";
        try { resolve({ ...result, body: new TextDecoder(charset).decode(Buffer.concat(chunks)) }); }
        catch (error) { if (error instanceof RangeError) reject(new CaptureUnavailable("unsupported")); else reject(error); }
      };
      const sink = new Writable({ write(chunk: Buffer, _encoding, callback) {
        if (complete) { callback(); return; }
        const room = CAPTURE_BYTES - kept;
        chunks.push(chunk.byteLength > room ? chunk.subarray(0, room) : chunk);
        kept += Math.min(room, chunk.byteLength);
        if (chunk.byteLength > room) { finish(); response.destroy(); }
        callback();
      } });
      // Wire bytes stay bounded too; after truncation the destroyed stream's rejection is expected and ignored.
      void pipeline(response, byteLimit(2 * CAPTURE_BYTES), decoder, sink, { signal })
        .then(() => { if (!complete) finish(); }, error => { if (!complete) reject(error); });
    });
    request.on("error", reject);
    request.end();
  });
}

const network: PageNetwork = { resolve: hostname => lookup(hostname, { all: true, verbatim: true }), request: requestPage };
export async function fetchPublicPage(url: URL, signal: AbortSignal, io: PageNetwork = network): Promise<string> {
  let current = url;
  for (let redirects = 0; redirects <= 3; redirects++) {
    signal.throwIfAborted();
    const host = publicUrl(current);
    let addresses: readonly CaptureAddress[];
    try {
      addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await abortable(io.resolve(host), signal);
    } catch (error) {
      if (error instanceof CaptureUnavailable) throw error;
      throw new CaptureUnavailable("dns");
    }
    // A validated IPv4 candidate works even when the host has no IPv6 route.
    const address = addresses.find(item => item.family === 4) ?? addresses[0];
    if (!address || addresses.some(item => !isPublicAddress(item.address) || isIP(item.address) !== item.family)) {
      throw new CaptureUnavailable("unsafe_url");
    }
    signal.throwIfAborted();
    const response = await abortable(io.request(current, address, signal), signal);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirects === 3) throw new CaptureUnavailable("redirects");
      if (!response.location || !URL.canParse(response.location, current)) throw new CaptureUnavailable("unsafe_url");
      current = new URL(response.location, current);
      continue;
    }
    if (response.status < 200 || response.status >= 300) throw new CaptureUnavailable("http");
    if (!/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(response.contentType)) throw new CaptureUnavailable("unsupported");
    return response.body;
  }
  throw new CaptureUnavailable("redirects");
}

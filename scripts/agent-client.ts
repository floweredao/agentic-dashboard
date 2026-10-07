export type AgentConnection = {
  readonly url: string;
  readonly token: string;
};

export async function sendRecord(
  connection: AgentConnection,
  submission: unknown,
): Promise<unknown> {
  return ky
    .post(new URL("/api/v1/records", connection.url), {
      headers: { authorization: `Bearer ${connection.token}` },
      json: submission,
      timeout: 15_000,
      retry: 0,
    })
    .json<unknown>();
}

export async function getRecord(connection: AgentConnection, id: string): Promise<unknown> {
  return ky
    .get(new URL(`/api/v1/records/${encodeURIComponent(id)}`, connection.url), {
      headers: { authorization: `Bearer ${connection.token}` },
      timeout: 15_000,
      retry: 0,
    })
    .json<unknown>();
}

/** GET /api/v1/records as an agent: the records it may read, newest first, one page at a time. */
export async function searchRecords(
  connection: AgentConnection,
  query: { q?: string; kind?: string; limit?: number; cursor?: string },
): Promise<unknown> {
  const searchParams: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== "") searchParams[key] = String(value);
  return ky
    .get(new URL("/api/v1/records", connection.url), {
      headers: { authorization: `Bearer ${connection.token}` },
      searchParams,
      timeout: 15_000,
      retry: 0,
    })
    .json<unknown>();
}

export async function updateRecord(
  connection: AgentConnection,
  id: string,
  patch: { expectedVersion: number; changes: unknown },
): Promise<unknown> {
  return ky
    .patch(new URL(`/api/v1/records/${encodeURIComponent(id)}`, connection.url), {
      headers: { authorization: `Bearer ${connection.token}` },
      json: patch,
      timeout: 15_000,
      retry: 0,
    })
    .json<unknown>();
}

/** DELETE /api/v1/records/:id: moves a record this agent created to the owner's trash (204), where the owner can restore it. */
export async function trashRecord(connection: AgentConnection, id: string, expectedVersion: number): Promise<void> {
  await ky.delete(new URL(`/api/v1/records/${encodeURIComponent(id)}`, connection.url), {
    headers: { authorization: `Bearer ${connection.token}` },
    json: { expectedVersion },
    timeout: 15_000,
    retry: 0,
  });
}

/** PUT /api/v1/records/:id/document: attaches or replaces the record's HTML full document (only on records this agent created). */
export async function putDocument(connection: AgentConnection, id: string, html: string): Promise<unknown> {
  return ky
    .put(new URL(`/api/v1/records/${encodeURIComponent(id)}/document`, connection.url), {
      headers: { authorization: `Bearer ${connection.token}` },
      json: { html },
      timeout: 30_000,
      retry: 0,
    })
    .json<unknown>();
}

/** GET /api/v1/records/:id/document: the record's full document, or `{ document: null }`. */
export async function getDocument(connection: AgentConnection, id: string): Promise<unknown> {
  return ky
    .get(new URL(`/api/v1/records/${encodeURIComponent(id)}/document`, connection.url), {
      headers: { authorization: `Bearer ${connection.token}` },
      timeout: 15_000,
      retry: 0,
    })
    .json<unknown>();
}

/** GET /api/v1/comments: the owner's comments in this agent's queue (state new|open|all), or one item's whole timeline. */
export async function listComments(
  connection: AgentConnection,
  query: { state?: string; recordId?: string },
): Promise<unknown> {
  const searchParams: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== "") searchParams[key] = value;
  return ky
    .get(new URL("/api/v1/comments", connection.url), {
      headers: { authorization: `Bearer ${connection.token}` },
      searchParams,
      timeout: 15_000,
      retry: 0,
    })
    .json<unknown>();
}

/** POST /api/v1/comments: a report on an item (recordId) or a reply to a comment (replyTo), optionally setting the item's status. */
export async function postComment(connection: AgentConnection, input: unknown): Promise<unknown> {
  return ky
    .post(new URL("/api/v1/comments", connection.url), {
      headers: { authorization: `Bearer ${connection.token}` },
      json: input,
      timeout: 15_000,
      retry: 0,
    })
    .json<unknown>();
}

export async function markComment(connection: AgentConnection, id: string, mark: "seen" | "done"): Promise<unknown> {
  return ky
    .post(new URL(`/api/v1/comments/${encodeURIComponent(id)}/${mark}`, connection.url), {
      headers: { authorization: `Bearer ${connection.token}` },
      timeout: 15_000,
      retry: 0,
    })
    .json<unknown>();
}

/**
 * POST /api/v1/records/:id/narration: 202 starts a narration, 200 returns the current one unchanged.
 * `style`: read (read aloud) or podcast (two hosts); without it the server uses the style last chosen for the record.
 */
export async function requestNarration(connection: AgentConnection, id: string, force: boolean, style?: "read" | "podcast"): Promise<unknown> {
  return ky
    .post(new URL(`/api/v1/records/${encodeURIComponent(id)}/narration`, connection.url), {
      headers: { authorization: `Bearer ${connection.token}` },
      json: { ...(force ? { force: true } : {}), ...(style ? { style } : {}) },
      timeout: 15_000,
      retry: 0,
    })
    .json<unknown>();
}

/** GET /api/v1/records/:id/narration: `{narration, available}`. */
export async function getNarration(connection: AgentConnection, id: string): Promise<unknown> {
  return ky
    .get(new URL(`/api/v1/records/${encodeURIComponent(id)}/narration`, connection.url), {
      headers: { authorization: `Bearer ${connection.token}` },
      timeout: 15_000,
      retry: 0,
    })
    .json<unknown>();
}

/** POST /api/v1/digests: one upload of a digest (any registered agent); identical uploads change nothing. */
export async function postDigest(connection: AgentConnection, input: unknown): Promise<unknown> {
  return ky
    .post(new URL("/api/v1/digests", connection.url), {
      headers: { authorization: `Bearer ${connection.token}` },
      json: input,
      timeout: 30_000,
      retry: 0,
    })
    .json<unknown>();
}

/** GET /api/v1/digests: summaries from..to (dates in the dashboard's time zone), newest first. */
export async function listDigests(connection: AgentConnection, query: { from?: string; to?: string }): Promise<unknown> {
  const searchParams: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) if (value) searchParams[key] = value;
  return ky
    .get(new URL("/api/v1/digests", connection.url), {
      headers: { authorization: `Bearer ${connection.token}` },
      searchParams,
      timeout: 15_000,
      retry: 0,
    })
    .json<unknown>();
}

export async function readShared(url: string): Promise<string> {
  return ky.get(url, { timeout: 15_000, retry: 0 }).text();
}
import ky from "ky";


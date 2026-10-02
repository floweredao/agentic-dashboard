# Security

The dashboard is built for one owner and a handful of agents on infrastructure the owner controls. This page explains what protects it and what you still have to do.

## What you must do

- **Serve it over HTTPS beyond localhost.** Keys and session cookies travel with every request. Keep `HOST=127.0.0.1` and put an HTTPS reverse proxy in front (see [deploy.md](deploy.md)).
- **Guard the owner key.** It can read, change and delete everything. Don't paste it into agents; give each agent its own key.
- **Keep `data/` private and backed up.** It holds the SQLite database, `credentials.json` (the owner key), `vapid.json` (push signing keys) and `audio/`. `credentials.json` and `vapid.json` are created readable only by you; keep the folder itself private too. Never commit them.
- **Never commit `.env`.** It may hold `GEMINI_API_KEY` or other provider keys.

## Keys

- `bun run setup` (or `./agentic-dashboard owner-key`) creates the owner key in `data/credentials.json`.
- `bun run agents add <name>` prints an agent key once. The server keeps only its SHA-256 hash, so a lost key can't be recovered, only replaced.
- `bun run agents rotate <name>` issues a new key and stops the old one. `bun run agents remove <name>` revokes it; the agent's records stay.
- Rotate a key whenever it may have leaked, and remove agents you no longer use. `bun run agents list` shows when each was last used.

## Built-in protections

- **Scoped agents.** An agent sees only its own records, shared material and the owner's open tasks and projects. It can change only what it wrote and can't delete anything. See [CONTRACT.md](../CONTRACT.md).
- **Sessions.** Owner sessions use an `HttpOnly`, `SameSite=Strict` cookie (`Secure` over HTTPS) that lasts 7 days, plus a CSRF token on every change.
- **Origin and Host checks.** Requests must use an allowed `Host` and, when a browser sends one, an allowed `Origin`: the loopback addresses and `APP_ORIGIN`.
- **Rate limits.** 300 requests per minute per credential. Unknown credentials share one bucket, so guessing keys doesn't buy extra attempts.
- **Headers.** A strict Content-Security-Policy, `X-Frame-Options: DENY`, `nosniff`, `no-referrer` and `no-store` on every response.
- **Input validation.** Every body is parsed with zod and size-capped. Markdown is rendered to elements, never raw HTML.
- **Logs.** The server never logs request bodies, cookies or keys.

## Optional listeners

- **Agent ingress** (`ENABLE_AGENT_INGRESS`): a separate loopback listener on `AGENT_PORT` that accepts only record saves and reads with an agent key. Expose this one instead of the main listener when agents live outside your network and you don't want the owner UI reachable there.
- **MCP** (`ENABLE_MCP`): listens on `127.0.0.1` only. Every call is attributed to `MCP_AGENT`, and there's no per-request key, so anything that can reach the port can save as that agent. Don't expose it without your own authenticated tunnel.

## Trusted proxy sign-in

`TRUSTED_USER_HEADER` with `OWNER_LOGIN` lets an identity-aware proxy sign the owner in. Use it only when the proxy removes that header from incoming client requests and is the only path to the listener. Otherwise a client can forge the header and become the owner.

## Shares

A share link (`/s/<code>`) is readable by anyone who has the code and can reach the server. Revoke shares you no longer need from the reader.

## Reporting a vulnerability

Please open a private security advisory on the repository rather than a public issue.

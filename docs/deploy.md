# Deploying

Two ways are supported. Both were verified on a real machine, and neither needs anything besides Bun (or nothing at all, for the binary).

1. **`bun start` on your own machine or a VM**, behind an HTTPS reverse proxy.
2. **A single binary** built with `bun run build:binary`, which needs no runtime on the target.

Docker isn't provided yet. A small, well-documented image would be a welcome contribution.

Whichever you pick, read [security.md](security.md) first. The dashboard listens on `127.0.0.1` by default, and you should keep it that way and put HTTPS in front.

## Option 1: Bun behind a reverse proxy

```sh
git clone https://github.com/floweredao/agentic-dashboard.git
cd agentic-dashboard
bun install
bun run setup
cp .env.example .env    # then edit
bun start
```

In `.env`, set at least:

```sh
APP_ORIGIN=https://dashboard.example.com
TIME_ZONE=Europe/Berlin
```

`APP_ORIGIN` must match the address people open exactly. The server rejects requests whose `Host` or `Origin` doesn't match it.

Keep the process running with your init system (systemd, a launch agent, a process manager), and send `SIGTERM` to stop it cleanly.

### Caddy

Caddy gets and renews the certificate itself:

```caddyfile
dashboard.example.com {
	reverse_proxy 127.0.0.1:4310
}
```

### Tailscale Serve

To reach the dashboard only from your own tailnet devices:

```sh
tailscale serve --bg 4310
```

Set `APP_ORIGIN` to the `https://` address `tailscale serve status` prints.

### Sign-in through an identity-aware proxy

If your proxy authenticates users and forwards their identity in a header, the owner can skip the key:

```sh
TRUSTED_USER_HEADER=Tailscale-User-Login
OWNER_LOGIN=you@example.com
```

Set both or neither. Only use this when the proxy strips that header from client requests and is the only way to reach the listener; otherwise anyone can claim to be you. The server also requires `APP_ORIGIN` to be HTTPS before it trusts the header. Tailscale Serve is one such proxy. A plain Caddy setup is not, so leave these unset there.

## Option 2: Single binary

```sh
bun install
bun run build:binary
```

This produces `release/agentic-dashboard` and `release/dist/` (the web app), plus a copy of `.env.example`. Copy the `release/` folder to the target and run it from there, since `STATIC_DIR` defaults to `dist`:

```sh
cd release
./agentic-dashboard owner-key        # creates data/credentials.json and prints the owner key
./agentic-dashboard                  # starts the server
./agentic-dashboard agents add codex # registers an agent
```

The binary reads the same environment variables as `bun start`. Set `BUN_TARGET` while building to cross-compile, for example `BUN_TARGET=bun-linux-x64 bun run build:binary`. Put the same HTTPS proxy in front.

## Updating

Stop the server, pull or copy the new version, run `bun install` and `bun run build` (or rebuild the binary), and start it again. Back up `data/` first.

## Backups

Everything lives in `DATA_DIR` (default `data/`): `dashboard.sqlite`, `credentials.json`, `vapid.json` and `audio/`. Back up the whole folder while the server is stopped, or use `sqlite3 data/dashboard.sqlite ".backup backup.sqlite"` while it runs.

#!/bin/sh
# Installs or updates Agentic Dashboard, then opens its first-run setup:
#
#   curl -fsSL https://raw.githubusercontent.com/floweredao/agentic-dashboard/main/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/floweredao/agentic-dashboard/main/install.sh | sh -s -- connect --url <dashboard> --code <code>
#
# Arguments after `sh -s --` are passed to `agentic-dashboard`. Nothing here needs sudo. Settings:
#   AGENTIC_DASHBOARD_HOME     where the app, settings and data live (default ~/.agentic-dashboard)
#   AGENTIC_DASHBOARD_BIN_DIR  where the agentic-dashboard command goes (default ~/.local/bin)
#   AGENTIC_DASHBOARD_REF      the branch or tag to install (default main)
#   AGENTIC_DASHBOARD_SOURCE   a tarball URL or local .tar.gz to install instead of the GitHub archive
set -eu

REF="${AGENTIC_DASHBOARD_REF:-main}"
APP_HOME="${AGENTIC_DASHBOARD_HOME:-$HOME/.agentic-dashboard}"
BIN_DIR="${AGENTIC_DASHBOARD_BIN_DIR:-$HOME/.local/bin}"
SOURCE="${AGENTIC_DASHBOARD_SOURCE:-https://codeload.github.com/floweredao/agentic-dashboard/tar.gz/$REF}"
COMMAND="$BIN_DIR/agentic-dashboard"

say() { printf '%s\n' "$*"; }
fail() { printf 'agentic-dashboard install: %s\n' "$*" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v tar >/dev/null 2>&1 || fail "tar is required"

if command -v bun >/dev/null 2>&1; then BUN="$(command -v bun)"
elif [ -x "$HOME/.bun/bin/bun" ]; then BUN="$HOME/.bun/bin/bun"
else
  command -v unzip >/dev/null 2>&1 || fail "Bun is needed and its installer needs unzip; install unzip and run this again"
  say "Installing Bun, the runtime Agentic Dashboard runs on (https://bun.sh)..."
  curl -fsSL https://bun.sh/install | bash >/dev/null || fail "installing Bun failed; see https://bun.sh/docs/installation"
  BUN="$HOME/.bun/bin/bun"
fi
case "$("$BUN" --version)" in
  0.*|1.0.*|1.1.*|1.2.*) fail "Bun $("$BUN" --version) is too old; run: $BUN upgrade" ;;
esac

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT INT TERM
say "Downloading Agentic Dashboard ($REF)..."
case "$SOURCE" in
  http://*|https://*) curl -fsSL "$SOURCE" -o "$WORK/app.tar.gz" || fail "download failed: $SOURCE" ;;
  *) cp "$SOURCE" "$WORK/app.tar.gz" || fail "no such file: $SOURCE" ;;
esac
mkdir "$WORK/app"
tar -xzf "$WORK/app.tar.gz" -C "$WORK/app" --strip-components 1 || fail "the download is not a valid archive"
[ -f "$WORK/app/cli/main.ts" ] || fail "the archive has no cli/main.ts; is AGENTIC_DASHBOARD_REF a release with the installer?"
say "Installing dependencies..."
(cd "$WORK/app" && "$BUN" install --frozen-lockfile >"$WORK/install.log" 2>&1) || { cat "$WORK/install.log" >&2; fail "bun install failed"; }

mkdir -p "$APP_HOME"
chmod 700 "$APP_HOME"
rm -rf "$APP_HOME/app.previous"
if [ -d "$APP_HOME/app" ]; then mv "$APP_HOME/app" "$APP_HOME/app.previous"; fi
mv "$WORK/app" "$APP_HOME/app"
rm -rf "$APP_HOME/app.previous"

mkdir -p "$BIN_DIR"
cat >"$COMMAND" <<EOF
#!/bin/sh
export AGENTIC_DASHBOARD_HOME="\${AGENTIC_DASHBOARD_HOME:-$APP_HOME}"
export AGENTIC_DASHBOARD_LAUNCHER="$COMMAND"
exec "$BUN" "$APP_HOME/app/cli/main.ts" "\$@"
EOF
chmod 755 "$COMMAND"
say "Installed $COMMAND"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) say "Add it to your PATH, for example in ~/.zshrc or ~/.bashrc:  export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

# An update on a host: build the new web app now and restart the running service on it.
if [ -f "$APP_HOME/server.env" ]; then
  (cd "$APP_HOME/app" && "$BUN" x vite build --logLevel error) || fail "building the web app failed"
  if "$COMMAND" service status 2>/dev/null | grep -Eq ": (running|실행 중)$"; then "$COMMAND" service restart; fi
fi

# A terminal is attached even when this script arrives through a pipe; questions go there.
if [ "$#" -eq 0 ] && { [ -f "$APP_HOME/server.env" ] || [ -f "$APP_HOME/client.json" ]; }; then
  "$COMMAND" status
elif [ -t 1 ] && (exec </dev/tty) 2>/dev/null; then
  "$COMMAND" "$@" </dev/tty
else
  "$COMMAND" "$@"
fi

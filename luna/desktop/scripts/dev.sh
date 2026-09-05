#!/usr/bin/env bash
# Rapid-dev loop for Luna for Linux (GTK):
#   - ensures Luna is up and an access token is ready
#   - prefills login (and auto-signs in by default)
#   - cargo-watch rebuild+restart on save
#   - GTK Inspector via GTK_DEBUG=interactive
set -euo pipefail

if [ -z "${DISTROBOX_ENTERED:-}" ] && ! pkg-config --exists gtk4 libadwaita-1 2>/dev/null; then
  if command -v distrobox >/dev/null 2>&1 && distrobox list 2>/dev/null | grep -q ' dev '; then
    export DISTROBOX_ENTERED=1
    exec distrobox enter dev -- "$0" "$@"
  fi
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v cargo-watch >/dev/null 2>&1; then
  echo "==> Installing cargo-watch"
  cargo install cargo-watch --locked
fi

bash "$ROOT/scripts/ensure-dev-token.sh"

export LUNA_DESKTOP_URL="$(tr -d '\n' <"$ROOT/.dev/url")"
export LUNA_DESKTOP_TOKEN="$(tr -d '\n' <"$ROOT/.dev/token")"
# Auto sign-in so you land in Backup immediately. Set to 0 to test the login UI.
export LUNA_DESKTOP_AUTO_LOGIN="${LUNA_DESKTOP_AUTO_LOGIN:-1}"
export GTK_DEBUG="${GTK_DEBUG:-interactive}"
export RUST_BACKTRACE="${RUST_BACKTRACE:-1}"

# Fresh sign-in each run so the minted token is what we exercise.
rm -f "${LUNA_DESKTOP_DATA:-$HOME/.local/share/luna-desktop}/session.json"

echo "==> Luna for Linux rapid-dev"
echo "    LUNA_DESKTOP_URL=$LUNA_DESKTOP_URL"
echo "    LUNA_DESKTOP_AUTO_LOGIN=$LUNA_DESKTOP_AUTO_LOGIN"
echo "    GTK_DEBUG=$GTK_DEBUG"
echo "    Save a file under desktop/src to rebuild and restart."
echo "    Ctrl-C stops the watcher."

exec cargo watch \
  -w src \
  -w Cargo.toml \
  -x run

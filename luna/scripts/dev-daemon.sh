#!/usr/bin/env bash
# Rapid-dev loop for lunad: cargo-watch rebuild+restart on Rust changes.
# Pair with: make desktop-dev / make mobile-dev / make dev-web
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PORT="${PORT:-8090}"
DATA_DIR="${DATA_DIR:-$ROOT/dev}"

if ! command -v cargo-watch >/dev/null 2>&1; then
  echo "==> Installing cargo-watch"
  cargo install cargo-watch --locked
fi

idx="$ROOT/crates/lunad/web/dist/index.html"
if [ ! -f "$idx" ] || grep -Fq 'build the web app first' "$idx"; then
  echo "==> Luna web dist missing or stub — building once"
  echo "    (API watch only; use make dev-web in another terminal for UI HMR)"
  make web
fi

echo "==> lunad rapid-dev"
echo "    http://127.0.0.1:$PORT"
echo "    LUNA_DATA_DIR=$DATA_DIR"
echo "    Save under crates/ to rebuild and restart."
echo "    Ctrl-C stops the watcher."

export LUNA_DATA_DIR="$DATA_DIR"
# No --clear: cargo-watch's clearscreen fails in headless/CI terminals (no terminfo).
exec cargo watch \
  -w crates \
  -w Cargo.toml \
  -w Cargo.lock \
  -x "run -p lunad --bin lunad -- --port $PORT --data-dir $DATA_DIR"

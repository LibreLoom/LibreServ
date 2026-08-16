#!/bin/sh
# Luna CI — runs everything a Luna commit must pass. Read-only except build artifacts.
set -eu

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

# The container/host maps ~/.cargo and ~/.npm read-only in this environment;
# point caches at /tmp when the defaults are unwritable.
if [ ! -w "${CARGO_HOME:-$HOME/.cargo}" ]; then
  export CARGO_HOME="${CARGO_HOME:-/tmp/luna-cargo-home}"
fi
mkdir -p "$CARGO_HOME"

echo "==> cargo fmt"
cargo fmt --all --check

echo "==> cargo clippy"
cargo clippy --workspace --all-targets -- -D warnings

echo "==> cargo test"
cargo test --workspace

echo "==> web build"
(
  cd web
  npm install --no-audit --no-fund --cache /tmp/luna-npm-cache
  npm run build
  npm test -- --run
  npm run lint
  npm run typecheck
)

echo "==> ci ok"

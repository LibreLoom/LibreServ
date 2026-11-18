#!/bin/sh
# Luna fast tier — the unit tests a code change can break, and nothing else.
# For the edit/test loop (./ci run -p luna-fast). The release gate is still
# ./ci run -p luna, which adds clippy, the musl and desktop builds, Android,
# the browser E2E and the OS script checks. Static checks (format, lint,
# typecheck) belong to ./ci check, so they are not repeated here.
#
# Two steps, each timed: the web unit tests (shared/ui + luna/web), then the
# Rust workspace tests. Read-only except build artifacts; unlike the gate it
# does not record the lunad response contract.
set -eu

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

# Same cache fallbacks as ci.sh: ~/.cargo and ~/.npm can be read-only here.
if [ ! -w "${CARGO_HOME:-$HOME/.cargo}" ]; then
  export CARGO_HOME="${CARGO_HOME:-/tmp/luna-cargo-home}"
else
  export CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"
fi
mkdir -p "$CARGO_HOME"

lane_rust() {
	cargo test --workspace
}

lane_web() {
	(
	  cd "$ROOT/../shared/ui"
	  npm install --no-audit --no-fund --cache /tmp/luna-npm-cache
	  npm test
	)
	(
	  cd "$ROOT/web"
	  npm install --no-audit --no-fund --cache /tmp/luna-npm-cache
	  npx vitest run
	)
}

timed() {
	_name="$1"
	shift
	_t0=$(date +%s)
	_rc=0
	"$@" || _rc=$?
	echo "==> lane $_name: $(($(date +%s) - _t0))s (exit $_rc)"
	return "$_rc"
}

# One after the other, not in parallel: this box (and most dev machines) cannot
# hold a lunad test compile and a pool of jsdom workers in memory at once, and
# the starved web tests then time out. Web first: it is the shorter run, so a
# UI break fails in about two minutes.
timed web lane_web
timed rust lane_rust
echo "==> luna fast ok"

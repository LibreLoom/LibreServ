#!/usr/bin/env bash
# Luna Desktop engine journeys (K3, K4, K5) against a running lunad, no GTK.
# See luna/perf/README.md → "Desktop and Connect". Prints JSON lines; the
# engine's own per-pass timings (LUNA_DESKTOP_PERF=1) go to stderr.
#
#   LUNA_URL=http://localhost:8098 LUNA_PASSWORD=… LUNA_DRIVE=<drive id> \
#     perf/clients/desktop.sh sync   <remote folder> <local parent> [idle cycles] [edits]
#   … perf/clients/desktop.sh backup <remote folder> <local folder>
#   … perf/clients/desktop.sh walk   <remote folder> <unused>
#
# BENCH=<path> picks a prebuilt clients_bench (for A/B), else it is built.
# K_DATA=<dir> holds the engine's ledgers and job files (wiped first).
# K_CPU=<core> pins the engine to one core (default 5).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
desk=$here/../../desktop
: "${LUNA_URL:=http://localhost:8098}" "${LUNA_USER:=admin}" "${LUNA_PASSWORD:?set LUNA_PASSWORD}"
: "${LUNA_DRIVE:?set LUNA_DRIVE to the drive id}" "${K_CPU:=5}"
if [ -z "${BENCH:-}" ]; then
  (cd "$desk" && nice -n 19 cargo build -q --release --example clients_bench)
  BENCH=$desk/target/release/examples/clients_bench
fi
K_DATA=${K_DATA:-$(mktemp -d)}
rm -rf "$K_DATA"; mkdir -p "$K_DATA"
tok=$(curl -fsS -X POST "$LUNA_URL/api/v1/auth/login" -H 'content-type: application/json' \
  -d "{\"username\":\"$LUNA_USER\",\"password\":\"$LUNA_PASSWORD\"}" -D - -o /dev/null |
  sed -n 's/^set-cookie: luna_session=\([^;]*\).*/\1/Ip' | tr -d '\r')
[ -n "$tok" ] || { echo "sign-in failed (rate limit? see README)" >&2; exit 1; }
mode=$1; shift
LUNA_DESKTOP_DATA=$K_DATA LUNA_DESKTOP_PERF=1 exec taskset -c "$K_CPU" \
  "$BENCH" "$mode" "$LUNA_URL" "$tok" "$LUNA_DRIVE" "$@"

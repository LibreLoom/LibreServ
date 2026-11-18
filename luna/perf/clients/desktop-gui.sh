#!/usr/bin/env bash
# Luna Desktop K1 (start to tray ready) and K2 (idle RSS) with the real GTK app
# on a virtual display (Xvfb) and a private D-Bus session, signed in to a
# running lunad. See luna/perf/README.md → "Desktop and Connect".
#
#   LUNA_URL=http://localhost:8098 LUNA_PASSWORD=… [LUNA_DRIVE=<id> K_PAIR=<remote folder>:<local parent>] \
#     perf/clients/desktop-gui.sh <scratch dir> [runs] [idle seconds]
#
# Each run starts the app in a fresh HOME (no real autostart or keychain is
# touched), reads the K1 marks it prints with LUNA_DESKTOP_PERF=1, waits the
# idle time, then samples RSS (VmRSS, and Pss from smaps_rollup) and stops it.
# With K_PAIR the app also runs that sync pair, so K2 includes a synced folder.
# APP=<path> picks a prebuilt luna-desktop (for A/B), else it is built.
# K_ARGS=--background starts it as start-on-boot does (no window shown).
# GSK_RENDERER defaults to cairo; Xvfb only has software GL (llvmpipe), which
# alone maps ~75 MB, so also compare GDK_DEBUG=gl-disable.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
desk=$here/../../desktop
: "${LUNA_URL:=http://localhost:8098}" "${LUNA_USER:=admin}" "${LUNA_PASSWORD:?set LUNA_PASSWORD}"
dir=$(mkdir -p "$1" && cd "$1" && pwd); runs=${2:-5}; idle=${3:-60}
if [ -z "${APP:-}" ]; then
  (cd "$desk" && nice -n 19 cargo build -q --release --bin luna-desktop)
  APP=$desk/target/release/luna-desktop
fi
tok=$(curl -fsS -X POST "$LUNA_URL/api/v1/auth/login" -H 'content-type: application/json' \
  -d "{\"username\":\"$LUNA_USER\",\"password\":\"$LUNA_PASSWORD\"}" -D - -o /dev/null |
  sed -n 's/^set-cookie: luna_session=\([^;]*\).*/\1/Ip' | tr -d '\r')
[ -n "$tok" ] || { echo "sign-in failed (rate limit? see README)" >&2; exit 1; }

# A bus with no activatable services: nothing (portal, keyring, a11y) is
# started behind the app's back, and a call to a missing service fails at once
# instead of waiting out D-Bus's 25 s timeout. The token stays in session.json.
cat > "$dir/bus.conf" <<'XML'
<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:tmpdir=/tmp</listen>
  <auth>EXTERNAL</auth>
  <policy context="default"><allow send_destination="*"/><allow receive_sender="*"/><allow own="*"/></policy>
</busconfig>
XML

for i in $(seq 1 "$runs"); do
  home=$dir/home; data=$dir/data
  rm -rf "$home"; mkdir -p "$home" "$data"
  rm -f "$data/session.json" "$data/luna-desktop.lock"
  printf '{"base_url":"%s","username":"%s","token":"%s"}' "$LUNA_URL" "$LUNA_USER" "$tok" > "$data/session.json"
  if [ -n "${K_PAIR:-}" ]; then
    remote=${K_PAIR%%:*}; parent=${K_PAIR#*:}; name=${remote##*/}
    printf '[{"id":"perf","drive_id":"%s","remote_path":"%s","local_parent":"%s","local_path":"%s/%s","running":true}]' \
      "$LUNA_DRIVE" "$remote" "$parent" "$parent" "$name" > "$data/sync-pairs.json"
  fi
  log=$dir/run-$i.log
  HOME=$home XDG_CONFIG_HOME=$home/.config XDG_DATA_HOME=$home/.local/share XDG_CACHE_HOME=$home/.cache \
    LUNA_DESKTOP_DATA=$data LUNA_DESKTOP_PERF=1 GSK_RENDERER=${GSK_RENDERER:-cairo} NO_AT_BRIDGE=1 \
    xvfb-run -a -s '-screen 0 1280x800x24' dbus-run-session --config-file="$dir/bus.conf" -- "$APP" ${K_ARGS:-} > "$log" 2>&1 &
  wrapper=$!
  pid=""
  for _ in $(seq 1 600); do
    pid=$(pgrep -n -f "^$APP" || true); [ -n "$pid" ] && grep -q 'K1 session' "$log" && break; sleep 0.05
  done
  sleep "$idle"
  rss=$(awk '/^VmRSS/{print $2}' "/proc/$pid/status" 2>/dev/null || echo 0)
  pss=$(awk '/^Pss:/{print $2}' "/proc/$pid/smaps_rollup" 2>/dev/null || echo 0)
  kill "$pid" 2>/dev/null || true; wait "$wrapper" 2>/dev/null || true
  python3 - "$log" "$rss" "$pss" "$i" <<'PY'
import re, sys, json
log, rss, pss, i = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
marks = {}
for line in open(log, errors="replace"):
    m = re.search(r"K1 (\S+) since_exec_ms=(\d+)", line)
    if m and m.group(1) not in marks:
        marks[m.group(1)] = int(m.group(2))
print(json.dumps({"run": int(i), "K1_ms": marks, "K2_rss_mb": round(rss / 1024, 1), "K2_pss_mb": round(pss / 1024, 1)}))
PY
done

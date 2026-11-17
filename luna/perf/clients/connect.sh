#!/usr/bin/env bash
# Luna Connect journeys that run on one machine: C2 (device status pull) and
# C5 (cloud backup pack upload). C3/C4 (pages) run from luna/connect/web with
# perf/clients/connect-pages.mjs; this script's `start` prints its env.
# See luna/perf/README.md → "Desktop and Connect".
#
#   perf/clients/connect.sh start  <dir>    # build or use $CONNECT_BIN, run on $C_PORT, seed
#   perf/clients/connect.sh c2     <dir>    # GET /api/v1/status p50/p95
#   perf/clients/connect.sh c5     <dir>    # PUT 32 MiB packs, MB/s and Server-Timing split
#   perf/clients/connect.sh stop   <dir>
#
# Everything (config, SQLite DB, packs, logs) stays in <dir>. Dev mode: no
# Stripe, mock Cloudflare, local pack store. C_DEVICES unbound tokens are
# minted first so lookups run against a table that is not tiny (default 5000).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
conn=$here/../../connect
: "${C_PORT:=8099}" "${C_DEVICES:=5000}" "${C_RUNS:=200}" "${C_PACKS:=8}"
cmd=$1; dir=$(mkdir -p "$2" && cd "$2" && pwd)
base=http://127.0.0.1:$C_PORT
admin=perf-admin-token
pass=perf-connect-pass-1
email=perf@example.test

csrf_post() { # path json
  curl -fsS -b "$dir/jar" -c "$dir/jar" "$base/api/v1/config" -o /dev/null
  local csrf; csrf=$(awk '/luna_connect_csrf/{print $7}' "$dir/jar")
  curl -fsS -b "$dir/jar" -c "$dir/jar" -H 'content-type: application/json' -H "X-CSRF-Token: $csrf" \
    -X POST "$base$1" -d "$2"
}
sql() { python3 -c "import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);c.execute(sys.argv[2]);c.commit()" "$dir/connect.db" "$1"; }

case $cmd in
start)
  bin=${CONNECT_BIN:-}
  if [ -z "$bin" ]; then
    (cd "$conn" && nice -n 19 go build -o "$dir/luna-connect" ./cmd/server); bin=$dir/luna-connect
  fi
  web=${CONNECT_WEB:-$conn/web/dist}
  cat > "$dir/config.yaml" <<YAML
server: { address: 127.0.0.1, port: $C_PORT, admin_token: $admin, web_dir: "$web", base_url: "$base" }
database: { path: "$dir/connect.db" }
data_dir: "$dir/data"
backup: { driver: local }
stripe: { enabled: false }
YAML
  (cd "$dir" && LUNACONNECT_CONFIG=$dir/config.yaml LUNACONNECT_DEV=1 nohup "$bin" > "$dir/connect.log" 2>&1 & echo $! > "$dir/pid")
  for _ in $(seq 1 50); do curl -fs "$base/healthz" >/dev/null && break; sleep 0.2; done
  [ -s "$dir/device" ] && { echo "already seeded"; exit 0; }
  left=$C_DEVICES
  while [ "$left" -gt 0 ]; do n=$((left > 500 ? 500 : left))
    curl -fsS -X POST "$base/admin/device-codes/bulk" -H "Authorization: Bearer $admin" \
      -H 'content-type: application/json' -d "{\"count\":$n}" -o /dev/null; left=$((left - n)); done
  code=$(curl -fsS -X POST "$base/admin/device-codes" -H "Authorization: Bearer $admin" |
    python3 -c 'import sys,json;print(json.load(sys.stdin)["code"])')
  csrf_post /api/v1/account/register "{\"email\":\"$email\",\"password\":\"$pass\"}" >/dev/null
  sql "UPDATE accounts SET email_verified=1, has_card=1, billing_status='active'"
  devid=$(csrf_post /api/v1/devices/bind "{\"code\":\"$code\"}" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("device_id") or d.get("id") or "")')
  [ -n "$devid" ] || devid=$(curl -fsS -b "$dir/jar" "$base/api/v1/account/devices" | python3 -c 'import sys,json;print(json.load(sys.stdin)["devices"][0]["id"])')
  # A public name, so the status pull opens a sealed tunnel token as in production.
  csrf_post "/api/v1/devices/$devid/domain" '{"subdomain":"perfluna"}' >/dev/null
  echo "$code" > "$dir/device"
  echo "seeded: $C_DEVICES unbound tokens, account $email, one bound Luna"
  echo "pages: LUNA_CONNECT_URL=$base LUNA_CONNECT_EMAIL=$email LUNA_CONNECT_PASSWORD=$pass"
  ;;
c2)
  dev=$(cat "$dir/device")
  for _ in $(seq 1 20); do curl -fsS -o /dev/null -H "Authorization: Bearer $dev" "$base/api/v1/status"; done
  for _ in $(seq 1 "$C_RUNS"); do
    curl -fsS -o /dev/null -w '%{time_total}\n' -H "Authorization: Bearer $dev" "$base/api/v1/status"
  done | python3 -c '
import sys
v=sorted(float(x)*1000 for x in sys.stdin)
p=lambda q:v[min(len(v)-1,int(q*len(v)))]
print({"journey":"C2","n":len(v),"p50_ms":round(p(.5),2),"p95_ms":round(p(.95),2),"max_ms":round(v[-1],2),"budget_ms":50})'
  ;;
c5)
  dev=$(cat "$dir/device")
  f=$dir/pack.bin
  for _ in $(seq 1 "$C_PACKS"); do
    # A pack's ID is the SHA-256 of its bytes (Connect checks); lunad's packs are 32 MiB.
    head -c $((32 * 1024 * 1024)) /dev/urandom > "$f"
    id=$(sha256sum "$f" | cut -c1-64)
    curl -fsS -o /dev/null -D "$dir/h" -w '%{time_total} %{size_upload}\n' -X PUT -T "$f" \
      -H "Authorization: Bearer $dev" -H 'X-Luna-Id: perf-luna' -H 'X-Luna-Scope: perf' \
      -H 'content-type: application/octet-stream' "$base/api/v1/storage/packs/$id" |
      tr '\n' ' '; grep -i '^server-timing' "$dir/h" | tr -d '\r'
  done | python3 -c '
import sys,re
rows=[]
for l in sys.stdin:
    t,n=l.split()[:2]; st=dict((k,int(v)) for k,v in re.findall(r"(\w+);dur=(\d+)",l))
    rows.append((float(t),int(n),st))
mb=[n/t/1e6 for t,n,_ in rows]
avg=lambda k:round(sum(r[2].get(k,0) for r in rows)/len(rows))
print({"journey":"C5","packs":len(rows),"pack_mb":round(rows[0][1]/1e6,1),
  "mb_s_min":round(min(mb),1),"mb_s_median":round(sorted(mb)[len(mb)//2],1),
  "spool_ms":avg("spool"),"put_ms":avg("put"),"commit_ms":avg("commit")})'
  ;;
stop)
  [ -f "$dir/pid" ] && kill "$(cat "$dir/pid")" 2>/dev/null || true
  ;;
*) echo "usage: $0 start|c2|c5|stop <dir>" >&2; exit 2 ;;
esac

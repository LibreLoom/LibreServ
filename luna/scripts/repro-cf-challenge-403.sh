#!/usr/bin/env bash
# Verify Luna keeps connect.json on CF-challenge 403, clears on JSON unbound, applies on bound.
# Prerequisites: lunad built; mock on :18765.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="${LUNA_DATA_DIR:-$ROOT/dev}"
MOCK_URL="${LUNA_CONNECT_URL:-http://127.0.0.1:18765}"
TOKEN="${REPRO_DEVICE_TOKEN:-ABCD-EFGH-JKMN-PQRS-TVWX}"

mkdir -p "$DATA_DIR"
printf '%s\n' "$TOKEN" >"$DATA_DIR/device-token"
chmod 600 "$DATA_DIR/device-token" 2>/dev/null || true

# Seed a prior claim (tunnel token on disk) so we can prove challenge keeps claim.
DATA_DIR="$DATA_DIR" python3 - <<'PY'
import json, os, pathlib
p = pathlib.Path(os.environ["DATA_DIR"]) / "connect.json"
# Plain JSON is fine for repro; lunad will re-encrypt on successful poll.
p.write_text(json.dumps({
    "hostname": "repro.luna.servers.libreloom.org",
    "subdomain": "repro",
    "tunnel_token": "mock-preexisting-tunnel-token",
    "paired": True,
    "bound": True,
}))
print(f"seeded {p}")
PY

echo "==> device-token and connect.json ready under $DATA_DIR"
echo "==> Ensure mock is running: python3 $ROOT/scripts/mock-connect-cf-challenge.py"
echo "==> Challenge (claim must survive):"
echo "    curl -s -X POST $MOCK_URL/_debug/mode -H 'Content-Type: application/json' -d '{\"mode\":\"challenge\"}'"
echo "==> Unbound (claim must clear):"
echo "    curl -s -X POST $MOCK_URL/_debug/mode -H 'Content-Type: application/json' -d '{\"mode\":\"unbound\"}'"
echo "==> Bound (tunnel_token applied):"
echo "    curl -s -X POST $MOCK_URL/_debug/mode -H 'Content-Type: application/json' -d '{\"mode\":\"bound\"}'"
echo "==> Restart lunad with:"
echo "    cd $ROOT && LUNA_CONNECT_URL=$MOCK_URL LUNA_DATA_DIR=$DATA_DIR ./target/debug/lunad --port 8090"
echo "==> Or trigger poll via Connect status API after lunad is up."
echo "==> Expect: challenge → connect.json remains + connect_unreachable sticky; unbound → deleted; bound → token stored."

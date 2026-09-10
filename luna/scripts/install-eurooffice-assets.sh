#!/usr/bin/env bash
# Extract EuroOffice static web assets into Luna's data dir.
# Requires podman (or docker) and LUNA_DATA_DIR (defaults to luna/dev).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="${LUNA_DATA_DIR:-$ROOT/dev}"
IMAGE="${EUROOFFICE_IMAGE:-ghcr.io/euro-office/documentserver:latest}"
DEST="$DATA_DIR/eurooffice"

echo "Pulling $IMAGE …"
podman pull "$IMAGE"
cid="$(podman create "$IMAGE")"
cleanup() { podman rm -f "$cid" >/dev/null 2>&1 || true; }
trap cleanup EXIT

rm -rf "$DEST"
mkdir -p "$DEST"
echo "Copying web-apps + sdkjs into $DEST …"
podman cp "$cid:/var/www/euro-office/documentserver/web-apps" "$DEST/web-apps"
podman cp "$cid:/var/www/euro-office/documentserver/sdkjs" "$DEST/sdkjs"
podman cp "$cid:/var/www/euro-office/documentserver/fonts" "$DEST/fonts" 2>/dev/null || true
podman cp "$cid:/var/www/euro-office/documentserver/dictionaries" "$DEST/dictionaries" 2>/dev/null || true

API="$DEST/web-apps/apps/api/documents/api.js"
if [[ ! -f "$API" ]]; then
  echo "ERROR: expected $API after extract" >&2
  exit 1
fi
echo "OK: $API"
echo "Restart lunad so it serves /eurooffice (ServeDir is wired at boot)."

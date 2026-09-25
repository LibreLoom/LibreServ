#!/usr/bin/env bash
# Fetch the self-hosted draw.io (diagrams.net) webapp into Luna's data dir.
#
# Source: the draw.war attached to a pinned jgraph/drawio GitHub release —
# the war IS the built webapp (index.html + js/app.min.js + mxgraph +
# stencils + templates), no build step needed. WEB-INF/ and META-INF/ are
# skipped: they're the Java server bits Luna never serves.
#
# Requires curl + unzip. LUNA_DATA_DIR defaults to luna/dev.
# DRAWIO_VERSION pins the release; DRAWIO_SHA256 optionally verifies the war.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="${LUNA_DATA_DIR:-$ROOT/dev}"
DRAWIO_VERSION="${DRAWIO_VERSION:-v31.5.2}"
DRAWIO_URL="${DRAWIO_URL:-https://github.com/jgraph/drawio/releases/download/${DRAWIO_VERSION}/draw.war}"
DEST="$DATA_DIR/drawio"

echo "Fetching draw.io webapp $DRAWIO_VERSION …"
tmp_war="$(mktemp)"
trap 'rm -f "$tmp_war"' EXIT
curl -fsSL --proto '=https' --tlsv1.2 "$DRAWIO_URL" -o "$tmp_war"

# The release doesn't publish checksums; pass DRAWIO_SHA256 to pin one.
if [ -n "${DRAWIO_SHA256:-}" ]; then
	actual="$(sha256sum "$tmp_war" | awk '{print $1}')"
	if [ "$actual" != "$DRAWIO_SHA256" ]; then
		echo "ERROR: draw.war sha256 mismatch (expected $DRAWIO_SHA256, got $actual)" >&2
		exit 1
	fi
	echo "sha256 verified."
fi

rm -rf "$DEST"
mkdir -p "$DEST"
echo "Unpacking webapp into $DEST …"
unzip -q "$tmp_war" -d "$DEST" -x "WEB-INF/*" "META-INF/*"

for f in "$DEST/index.html" "$DEST/js/app.min.js" "$DEST/js/PreConfig.js"; do
	if [ ! -f "$f" ]; then
		echo "ERROR: expected $f after extract — war layout changed?" >&2
		exit 1
	fi
done

# Pack marker: the web UI probes /drawio/pack.json to tell an installed pack
# apart from the SPA fallback (which also answers 200, but as text/html).
cat > "$DEST/pack.json" <<EOF
{
  "pack": "luna-drawio",
  "version": "$DRAWIO_VERSION",
  "source": "$DRAWIO_URL"
}
EOF

# Attribution stays with the assets — this pack can ship in the install ISO.
cat > "$DEST/NOTICE.luna.txt" <<EOF
draw.io / diagrams.net webapp — Apache-2.0
(C) JGraph Holdings Ltd / draw.io AG. Source: https://github.com/jgraph/drawio
Fetched as draw.war from the pinned GitHub release ($DRAWIO_VERSION); the
WEB-INF server-side Java classes are excluded — Luna serves only the static
webapp at /drawio.
EOF

echo "OK: $DEST/index.html ($DRAWIO_VERSION)"
echo "Restart lunad so it serves /drawio (the route is wired at boot)."
echo "Reminder: this pack is Apache-2.0. Do not commit it (the default"
echo "luna/dev data dir is gitignored)."

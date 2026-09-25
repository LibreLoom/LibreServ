#!/bin/sh
# Build os/dist/drawio-pack.tar.zst — the draw.io webapp pack baked into the
# install ISO. rapidinstall.sh verifies its sha256 and extracts it onto
# LUNA_DATA so diagram editing works on first boot with no download.
#
# Source pack: $DRAWIO_DIR (default $LUNA_DATA_DIR/drawio → luna/dev).
# When no pack exists, runs install-drawio-assets.sh into os/work first —
# that path needs curl + network, same as the rootfs build.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/os/dist"
WORK="$ROOT/os/work/drawio-pack"
PACK_SRC="${DRAWIO_DIR:-${LUNA_DATA_DIR:-$ROOT/dev}/drawio}"
TARBALL="$OUT/drawio-pack.tar.zst"
STAMP="$TARBALL.sha256"

if [ ! -f "$PACK_SRC/index.html" ]; then
	echo "No draw.io pack at $PACK_SRC — fetching into $WORK …"
	LUNA_DATA_DIR="$WORK/data" bash "$ROOT/scripts/install-drawio-assets.sh"
	PACK_SRC="$WORK/data/drawio"
fi

for f in \
	"$PACK_SRC/index.html" \
	"$PACK_SRC/js/app.min.js" \
	"$PACK_SRC/pack.json"; do
	[ -f "$f" ] || { echo "ERROR: pack at $PACK_SRC is incomplete (missing $f)" >&2; exit 1; }
done

# The tarball must contain a dir literally named drawio so it extracts
# self-describing onto LUNA_DATA — a custom DRAWIO_DIR ending otherwise
# would silently pack the wrong root name.
if [ "$(basename "$PACK_SRC")" != "drawio" ]; then
	echo "ERROR: pack dir must be named 'drawio' (got $PACK_SRC)" >&2
	exit 1
fi

mkdir -p "$OUT"
echo "Packing $PACK_SRC → $TARBALL …"
tmp="$TARBALL.tmp"
tar -C "$(dirname "$PACK_SRC")" -cf - drawio |
	zstd -19 -T0 -o "$tmp"
mv "$tmp" "$TARBALL"

( cd "$OUT" && sha256sum "$(basename "$TARBALL")" >"$(basename "$STAMP")" )

_size="$(du -h "$TARBALL" | awk '{print $1}')"
echo "built $TARBALL ($_size)"
echo "checksum: $(cat "$STAMP")"

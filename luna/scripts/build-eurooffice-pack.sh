#!/bin/sh
# Build os/dist/eurooffice-pack.tar.zst — the trimmed EuroOffice pack baked
# into the install ISO. rapidinstall.sh extracts it onto LUNA_DATA so office
# editing works on first boot with no runtime download.
#
# Source pack: $EUROOFFICE_DIR (default $LUNA_DATA_DIR/eurooffice → luna/dev).
# When no pack exists, runs install-eurooffice-assets.sh into os/work first —
# that path needs podman + network, same as the rootfs build.
#
# Excludes web-apps/*/resources/help: ~500MB of offline-help PNGs that barely
# compress, and the Help menu is disabled anyway (customization.help=false
# in EuroOfficeHost). Keeps every font and all dictionaries.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/os/dist"
WORK="$ROOT/os/work/eurooffice-pack"
PACK_SRC="${EUROOFFICE_DIR:-${LUNA_DATA_DIR:-$ROOT/dev}/eurooffice}"
TARBALL="$OUT/eurooffice-pack.tar.zst"
STAMP="$TARBALL.sha256"

if [ ! -f "$PACK_SRC/web-apps/apps/api/documents/api.js" ]; then
	echo "No EuroOffice pack at $PACK_SRC — fetching into $WORK …"
	LUNA_DATA_DIR="$WORK/data" bash "$ROOT/scripts/install-eurooffice-assets.sh"
	PACK_SRC="$WORK/data/eurooffice"
fi

for f in \
	"$PACK_SRC/web-apps/apps/api/documents/api.js" \
	"$PACK_SRC/sdkjs/word/sdk-all-min.js" \
	"$PACK_SRC/x2t/x2t.wasm" \
	"$PACK_SRC/fonts-manifest.json"; do
	[ -f "$f" ] || { echo "ERROR: pack at $PACK_SRC is incomplete (missing $f)" >&2; exit 1; }
done

mkdir -p "$OUT"
echo "Packing $PACK_SRC → $TARBALL (help dirs excluded)…"
tmp="$TARBALL.tmp"
# Pack the eurooffice/ dir itself so the tarball is self-describing and
# extracts straight onto LUNA_DATA.
tar -C "$(dirname "$PACK_SRC")" --exclude='*/resources/help' -cf - eurooffice |
	zstd -19 -T0 -o "$tmp"
mv "$tmp" "$TARBALL"

( cd "$OUT" && sha256sum "$(basename "$TARBALL")" >"$(basename "$STAMP")" )

_size="$(du -h "$TARBALL" | awk '{print $1}')"
echo "built $TARBALL ($_size)"
echo "checksum: $(cat "$STAMP")"

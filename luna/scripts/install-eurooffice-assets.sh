#!/usr/bin/env bash
# Extract EuroOffice static web assets into Luna's data dir, generate the font
# metrics sdkjs needs (the image only produces them at first boot), and fetch
# the x2t.wasm converter the browser uses instead of a Document Server.
# Requires podman (or docker). LUNA_DATA_DIR defaults to luna/dev.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="${LUNA_DATA_DIR:-$ROOT/dev}"
IMAGE="${EUROOFFICE_IMAGE:-ghcr.io/euro-office/documentserver:latest}"
DEST="$DATA_DIR/eurooffice"
X2T_VERSION="${X2T_VERSION:-v9.3.0+0}"
X2T_URL="https://github.com/cryptpad/onlyoffice-x2t-wasm/releases/download/${X2T_VERSION}/x2t.zip"
RUNTIME="${OCI_RUNTIME:-podman}"

echo "Pulling $IMAGE …"
$RUNTIME pull "$IMAGE"
cid="$($RUNTIME create "$IMAGE")"
cleanup() { $RUNTIME rm -f "$cid" >/dev/null 2>&1 || true; }
trap cleanup EXIT

rm -rf "$DEST"
mkdir -p "$DEST"
echo "Copying web-apps + sdkjs + fonts inputs into $DEST …"
$RUNTIME cp "$cid:/var/www/euro-office/documentserver/web-apps" "$DEST/web-apps"
$RUNTIME cp "$cid:/var/www/euro-office/documentserver/sdkjs" "$DEST/sdkjs"
$RUNTIME cp "$cid:/var/www/euro-office/documentserver/dictionaries" "$DEST/dictionaries" 2>/dev/null || true
# core-fonts are the TTFs the browser-side wasm converter needs — not optional.
$RUNTIME cp "$cid:/var/www/euro-office/documentserver/core-fonts" "$DEST/core-fonts"

# Keep AGPL notices with the assets: copy any license/notice files the image
# ships at the documentserver root (best effort — names vary by release).
for f in LICENSE LICENSE.txt license.txt license.html AGPL-3.0.txt COPYING NOTICE 3rdPartyLicenses.txt ThirdPartyNotices.txt; do
  $RUNTIME cp "$cid:/var/www/euro-office/documentserver/$f" "$DEST/$f" 2>/dev/null || true
done
# The image ships no top-level license file, and we ship this pack in the
# install ISO — always drop the AGPL text + attribution at the pack root.
cp "$ROOT/web/public/licenses/agpl-3.0.txt" "$DEST/AGPL-3.0.txt"
cat > "$DEST/NOTICE" <<'EOF'
EuroOffice office suite — AGPL-3.0
Derived from ONLYOFFICE DocumentServer (C) Ascensio System SIA.
Editor assets (web-apps, sdkjs, fonts, dictionaries) extracted from
ghcr.io/euro-office/documentserver. x2t.wasm OOXML converter from
github.com/cryptpad/onlyoffice-x2t-wasm (AGPL-3.0). Corresponding source:
github.com/ONLYOFFICE/DocumentServer and the linked repos — see
luna/THIRD_PARTY_EUROOFFICE.md.
EOF

API="$DEST/web-apps/apps/api/documents/api.js"
if [[ ! -f "$API" ]]; then
  echo "ERROR: expected $API after extract" >&2
  exit 1
fi

echo "Generating font metrics + thumbnails (one-shot in the image, no daemon)…"
# Mirrors the image's own documentserver-generate-allfonts.sh. allfontsgen
# silently emits zero font files (still exit 0) when pointed at the bind
# mount or a missing --input dir, so it runs against the image's own paths
# exactly like the stock script and the results are copied out.
# allthemesgen failures (mobile thumbnail sizes) are tolerated — the desktop
# editor doesn't need them.
$RUNTIME run --rm --user 0 --entrypoint /bin/sh \
  -v "$DEST:/out" \
  "$IMAGE" -c '
set -e
DIR=/var/www/euro-office/documentserver
export LD_LIBRARY_PATH=$DIR/server/FileConverter/bin:$LD_LIBRARY_PATH
INPUTS="--input=$DIR/core-fonts"
# custom-fonts exists in upstream DS images; a missing --input dir makes
# allfontsgen skip the web-font output entirely (still exit 0).
[ -d "$DIR/../Data/custom-fonts" ] && INPUTS="$INPUTS --input=$DIR/../Data/custom-fonts"
# shellcheck disable=SC2086
"$DIR/server/tools/allfontsgen" \
  $INPUTS \
  --allfonts-web="$DIR/sdkjs/common/AllFonts.js" \
  --allfonts="$DIR/server/FileConverter/bin/AllFonts.js" \
  --images="$DIR/sdkjs/common/Images" \
  --selection="$DIR/server/FileConverter/bin/font_selection.bin" \
  --output-web="$DIR/fonts" \
  --use-system="true" \
  --use-system-user-fonts="false"
cp "$DIR/sdkjs/common/AllFonts.js" /out/sdkjs/common/AllFonts.js
cp "$DIR/server/FileConverter/bin/AllFonts.js" /out/AllFonts.bin.js
cp "$DIR/server/FileConverter/bin/font_selection.bin" /out/font_selection.bin
mkdir -p /out/fonts
cp -r "$DIR"/fonts/. /out/fonts/
# allfontsgen also writes the font-list sprite (fonts_thumbnail*.png +
# .png.bin) into --images; the font dropdown fetches it and crashes hard on
# a 404, so it must ship. Merge (not replace) — the stock sdkjs Images dir
# holds cursors/icons the editor also needs.
mkdir -p /out/sdkjs/common/Images
cp -r "$DIR"/sdkjs/common/Images/. /out/sdkjs/common/Images/
"$DIR/server/tools/allthemesgen" \
  --converter-dir="$DIR/server/FileConverter/bin" \
  --src="/out/sdkjs/slide/themes" \
  --output="/out/sdkjs/common/Images" || true
'
rm -f "$DEST"/fonts/*.gz "$DEST"/sdkjs/common/AllFonts.js.gz 2>/dev/null || true

if [[ ! -f "$DEST/sdkjs/common/AllFonts.js" ]]; then
  echo "ERROR: font generation did not produce sdkjs/common/AllFonts.js" >&2
  exit 1
fi
if [[ ! -d "$DEST/fonts" || -z "$(ls -A "$DEST/fonts" 2>/dev/null)" ]]; then
  echo "ERROR: font generation did not produce $DEST/fonts" >&2
  exit 1
fi
if [[ ! -f "$DEST/sdkjs/common/Images/fonts_thumbnail.png.bin" ]]; then
  echo "ERROR: font-list sprite (fonts_thumbnail.png.bin) missing — the font" >&2
  echo "dropdown will crash the editor. Check the allfontsgen step above." >&2
  exit 1
fi

echo "Fetching x2t.wasm $X2T_VERSION …"
tmp_zip="$(mktemp)"; tmp_sum="$(mktemp)"
trap 'rm -f "$tmp_zip" "$tmp_sum"; cleanup' EXIT
curl -fsSL --proto '=https' --tlsv1.2 "$X2T_URL" -o "$tmp_zip"
curl -fsSL --proto '=https' --tlsv1.2 "$X2T_URL.sha512" -o "$tmp_sum"
expected="$(awk "{print \$1}" "$tmp_sum")"
actual="$(sha512sum "$tmp_zip" | awk "{print \$1}")"
if [[ "$expected" != "$actual" ]]; then
  echo "ERROR: x2t.zip sha512 mismatch (expected $expected, got $actual)" >&2
  exit 1
fi
mkdir -p "$DEST/x2t"
unzip -o "$tmp_zip" -d "$DEST/x2t" >/dev/null
# The zip ships x2t.js + x2t.wasm (+ .br variants). Flatten if nested.
if [[ -d "$DEST/x2t/x2t" ]]; then mv "$DEST/x2t/x2t"/* "$DEST/x2t/"; rmdir "$DEST/x2t/x2t"; fi
if [[ ! -f "$DEST/x2t/x2t.js" || ! -f "$DEST/x2t/x2t.wasm" ]]; then
  echo "ERROR: x2t.js/x2t.wasm missing after unzip" >&2
  exit 1
fi
# The conversion worker ships with the repo, not the pack release — it must
# sit next to x2t.js/wasm because the build resolves the wasm relative to the
# worker script's directory.
cp "$ROOT/web/public/office-x2t-worker.js" "$DEST/x2t/office-x2t-worker.js"

# Manifest of TTFs the wasm worker loads into its filesystem.
echo "Writing fonts-manifest.json …"
( cd "$DEST" && find core-fonts -name '*.ttf' | sort | \
  python3 -c 'import json,sys; print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))' \
  > fonts-manifest.json ) 2>/dev/null || \
( cd "$DEST" && find core-fonts -name '*.ttf' | sort | \
  awk 'BEGIN{printf "["} {printf "%s\"%s\"", NR>1?",":"", $0} END{print "]"}' \
  > fonts-manifest.json )

echo "OK: $API"
echo "OK: $DEST/x2t/x2t.wasm (browser-side converter)"
echo "Restart lunad so it serves /eurooffice (ServeDir is wired at boot)."
echo "Reminder: this pack is AGPL-3.0. Do not commit it (the default luna/dev"
echo "data dir is gitignored). If you redistribute it, see"
echo "luna/THIRD_PARTY_EUROOFFICE.md."

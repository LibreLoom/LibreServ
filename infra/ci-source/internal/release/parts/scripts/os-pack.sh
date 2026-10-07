# Builds one installer pack (EuroOffice or draw.io) with the repo's own pack
# scripts. Needs: PACK (eurooffice|drawio), PACK_FILE, PACK_KEY. /luna is the
# source (read-only), /work a scratch volume, /packs the cache dir the ISO job
# reads. Nothing is written anywhere else. The key file goes in last, so a
# half-finished run is never taken for a finished pack.
set -eu
build=/packs/.build-$PACK
rm -rf "$build"
mkdir -p "$build"
trap 'rm -rf "$build"' EXIT
PACK_OUT_DIR="$build" PACK_WORK_DIR=/work sh "/luna/scripts/build-$PACK-pack.sh"
[ -s "$build/$PACK_FILE" ] && [ -s "$build/$PACK_FILE.sha256" ] || { echo "$PACK_FILE was not produced" >&2; exit 1; }
rm -f "/packs/$PACK_FILE.key"
mv -f "$build/$PACK_FILE" "/packs/$PACK_FILE"
mv -f "$build/$PACK_FILE.sha256" "/packs/$PACK_FILE.sha256"
printf '%s\n' "$PACK_KEY" > "/packs/$PACK_FILE.key"

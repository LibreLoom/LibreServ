# The editor packs are part of the OS image, not the data partition.
#
# EuroOffice (~900 MiB extracted) and draw.io (~150 MiB) are program files:
# they change with a release, they are identical on every Luna, and nothing
# about them belongs to the person using the box. Keeping them on LUNA_DATA
# meant the "data" partition was mostly software, and it made the packs a
# second update path that could drift from the image.
#
# They land in /usr/share/luna/<pack>, read-only with the rest of the root
# slot. lunad serves them from there (see crates/lunad/src/main.rs).
PACKS_IN="${LUNA_PACKS_IN:-/in/packs}"
PACK_DEST="$ROOTFS/usr/share/luna"
# A release build (the release tool sets LUNA_PACKS_REQUIRED=1) must never ship
# an image without its editors; a dev build only warns, because the packs are
# large downloads.
REQUIRED="${LUNA_PACKS_REQUIRED:-0}"

if [ -d "$PACKS_IN" ]; then
    mkdir -p "$PACK_DEST"
    for _pack in eurooffice drawio; do
        _blob="$PACKS_IN/$_pack-pack.tar.zst"
        if [ ! -f "$_blob" ]; then
            if [ "$REQUIRED" = 1 ]; then
                echo "error: no $_pack pack in $PACKS_IN: the image must carry its editors" >&2
                exit 1
            fi
            echo "WARNING: no $_pack pack in $PACKS_IN: this image will lack that editor" >&2
            continue
        fi
        if [ -f "$_blob.sha256" ]; then
            (cd "$PACKS_IN" && sha256sum -c "$(basename "$_blob").sha256" >/dev/null) \
                || { echo "error: $_pack pack does not match its checksum" >&2; exit 1; }
        fi
        echo "==> $_pack pack into the image"
        rm -rf "$PACK_DEST/$_pack"
        mkdir -p "$PACK_DEST/$_pack"
        zstd -dc "$_blob" | tar -x -C "$PACK_DEST/$_pack"
    done
    # A pack that did not extract cleanly is a broken image, not a warning.
    [ -f "$PACK_DEST/eurooffice/web-apps/apps/api/documents/api.js" ] \
        || { echo "error: the EuroOffice pack did not extract" >&2; exit 1; }
    [ -f "$PACK_DEST/drawio/index.html" ] \
        || { echo "error: the draw.io pack did not extract" >&2; exit 1; }
elif [ "$REQUIRED" = 1 ]; then
    echo "error: $PACKS_IN is not mounted: the image must carry its editors" >&2
    exit 1
else
    echo "WARNING: $PACKS_IN is not mounted: this image has no editor packs" >&2
fi

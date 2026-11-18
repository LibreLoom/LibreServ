# The editor packs and the search models are part of the OS image, not the
# data partition.
#
# EuroOffice (~900 MiB extracted) and draw.io (~150 MiB) are program files:
# they change with a release, they are identical on every Luna, and nothing
# about them belongs to the person using the box. Keeping them on LUNA_DATA
# meant the "data" partition was mostly software, and it made the packs a
# second update path that could drift from the image.
#
# They land in /usr/share/luna/<pack>, read-only with the rest of the root
# slot. lunad serves them from there (see crates/lunad/src/packs.rs).
PACKS_IN="${LUNA_PACKS_IN:-/in/packs}"
PACK_DEST="$ROOTFS/usr/share/luna"
# This fragment must be at top level, after all console-account conditionals.
[ -d "$PACKS_IN" ] || { echo "error: packs are not mounted at $PACKS_IN" >&2; exit 1; }
mkdir -p "$PACK_DEST"
for _pack in eurooffice drawio models; do
    _blob="$PACKS_IN/$_pack-pack.tar.zst"
    [ -s "$_blob" ] && [ -s "$_blob.sha256" ] \
        || { echo "error: missing $_pack pack or checksum" >&2; exit 1; }
    (cd "$PACKS_IN" && sha256sum -c "$(basename "$_blob").sha256" >/dev/null) \
        || { echo "error: $_pack pack does not match its checksum" >&2; exit 1; }
    echo "==> $_pack pack into the image"
    rm -rf "$PACK_DEST/$_pack"
    # Decompress separately: POSIX pipelines can hide a failed decompressor.
    _tar="$(mktemp)"
    zstd -dc "$_blob" > "$_tar" || { rm -f "$_tar"; exit 1; }
    tar -xf "$_tar" -C "$PACK_DEST"
    rm -f "$_tar"
done
chmod -R a+rX "$PACK_DEST"

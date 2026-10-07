#!/bin/sh
# Luna OS slot image, IN-CONTAINER step (runs inside build/Containerfile.os).
# Never calls podman or sudo.
#
#   in:  the rootfs tree at ROOTFS (default /rootfs, read-only is fine)
#   out: OUT/luna-os-x86_64.img.xz            the release asset, compressed once
#        OUT/luna-os-x86_64.img.xz.sha256     "<hash>  luna-os-x86_64.img.xz"
#        OUT/luna-os-x86_64.img.xz.inputs     OS_INPUT_HASH, when set
#   env: SIZE_MB (default: the A/B slot size from lib/disk.sh), XZ_THREADS,
#        XZ_MEM (compressor memory cap), OS_INPUT_HASH
#
# The ext4 filesystem is written straight into a plain file with mkfs.ext4 -d
# (no loop device, no mount). The .img.xz is compressed exactly once: the ISO
# embeds these very bytes, and `os-image.sha256` on a box is the sha256 of the
# .img.xz, so nothing may ever recompress it.
set -eu

ROOTFS="${ROOTFS:-/rootfs}"
OUT="${OUT:-/out}"
OSDIR="${OSDIR:-/luna/os}"
ARCH="${ARCH:-x86_64}"
NAME="luna-os-$ARCH.img.xz"
# shellcheck source=../lib/disk.sh
. "$OSDIR/lib/disk.sh"
SIZE_MB="${SIZE_MB:-$LUNA_SLOT_SIZE_MIB}"
XZ_THREADS="${XZ_THREADS:-$(nproc)}"
XZ_MEM="${XZ_MEM:-1536MiB}"

[ -d "$ROOTFS/boot" ] || { echo "missing rootfs at $ROOTFS: run the rootfs step first" >&2; exit 2; }
mkdir -p "$OUT"
# Scratch space for the raw image: next to the output so it never fills the
# container's small writable layer.
RAW="$OUT/.luna-os-$ARCH.img.tmp"
XZTMP="$OUT/.$NAME.tmp"
trap 'rm -f "$RAW" "$XZTMP"' EXIT
rm -f "$RAW" "$XZTMP"

truncate -s "${SIZE_MB}M" "$RAW"
# e2fsprogs >= 1.47.4 requires a UUID for hash_seed (bare integers are rejected).
mkfs.ext4 -q -F -L LUNA_A -E hash_seed=00000000-0000-4000-8000-000000000042 -d "$ROOTFS" "$RAW"
# e2fsck must match the e2fsprogs that created the image; host tools may be
# older and reject newer ext4 features.
e2fsck -fn "$RAW" >/dev/null

# -3 keeps the decoder dictionary at 4 MiB: the box streams this file through
# a small decoder. It packs twice as fast as -6 (19 s vs 37 s on 8 cores) for a
# 2.8% bigger file (277 vs 270 MB). -T and the memory cap are explicit because xz sizes its
# defaults from the HOST's RAM, not this container's limit.
xz -3 -T"$XZ_THREADS" --memlimit-compress="$XZ_MEM" -c "$RAW" > "$XZTMP"
xz -t "$XZTMP"
rm -f "$RAW"

SHA="$(sha256sum "$XZTMP" | awk '{print $1}')"
mv -f "$XZTMP" "$OUT/$NAME"
printf '%s  %s\n' "$SHA" "$NAME" > "$OUT/$NAME.sha256"
if [ -n "${OS_INPUT_HASH:-}" ]; then
	printf '%s\n' "$OS_INPUT_HASH" > "$OUT/$NAME.inputs"
else
	rm -f "$OUT/$NAME.inputs"
fi
printf 'built %s (%s MiB slot, %s bytes xz, sha256 %s)\n' "$OUT/$NAME" "$SIZE_MB" "$(wc -c < "$OUT/$NAME" | tr -d ' ')" "$SHA"

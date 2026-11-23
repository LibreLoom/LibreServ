#!/bin/sh
# Luna OS slot image, IN-CONTAINER step (runs inside build/Containerfile.os).
# Never calls podman or sudo.
#
#   in:  the rootfs tree at ROOTFS (default /rootfs, read-only is fine)
#   out: OUT/luna-os-x86_64.img.zst            the release asset, compressed once
#        OUT/luna-os-x86_64.img.zst.sha256     "<hash>  luna-os-x86_64.img.zst"
#        OUT/luna-os-x86_64.img.zst.inputs     OS_INPUT_HASH, when set (dev skip)
#   env: SIZE_MB (default: the A/B slot size from lib/disk.sh), ZSTD_THREADS,
#        ZSTD_LEVEL, ZSTD_LONG (window log, optional), OS_INPUT_HASH
#
# The ext4 filesystem is written straight into a plain file with mkfs.ext4 -d
# (no loop device, no mount). The .img.zst is compressed exactly once: the ISO
# embeds these very bytes, and `os-image.sha256` on a box is the sha256 of the
# .img.zst, so nothing may ever recompress it.
set -eu

ROOTFS="${ROOTFS:-/rootfs}"
OUT="${OUT:-/out}"
OSDIR="${OSDIR:-/luna/os}"
ARCH="${ARCH:-x86_64}"
NAME="luna-os-$ARCH.img.zst"
# shellcheck source=../lib/disk.sh
. "$OSDIR/lib/disk.sh"
SIZE_MB="${SIZE_MB:-$LUNA_SLOT_SIZE_MIB}"
# The dev wrapper caps the container at 3 GiB (LUNA_BUILD_MEMORY). zstd has no
# --memlimit-compress, so default to three threads instead of host nproc: on a
# many-core build box level 19 x nproc can allocate past the container cap.
ZSTD_THREADS="${ZSTD_THREADS:-3}"
ZSTD_LEVEL="${ZSTD_LEVEL:-19}"
# Long windows find duplicates far apart in the pack tree, at the cost of
# decoder window memory on the box. Off by default; opt in with e.g. ZSTD_LONG=27.
ZSTD_LONG="${ZSTD_LONG:-}"

[ -d "$ROOTFS/boot" ] || { echo "missing rootfs at $ROOTFS: run the rootfs step first" >&2; exit 2; }
if [ -n "${OS_INPUT_HASH:-}" ]; then
    [ "$(cat "$ROOTFS/etc/luna-image-inputs" 2>/dev/null)" = "$OS_INPUT_HASH" ] \
        || { echo "rootfs inputs changed: rebuild the rootfs before making the image" >&2; exit 1; }
fi
sh "$OSDIR/build/validate-rootfs.sh" "$ROOTFS"
mkdir -p "$OUT"
# Scratch space for the raw image: next to the output so it never fills the
# container's small writable layer.
RAW="$OUT/.luna-os-$ARCH.img.tmp"
IMGTMP="$OUT/.$NAME.tmp"
trap 'rm -f "$RAW" "$IMGTMP"' EXIT
rm -f "$RAW" "$IMGTMP"

truncate -s "${SIZE_MB}M" "$RAW"
# e2fsprogs >= 1.47.4 requires a UUID for hash_seed (bare integers are rejected).
mkfs.ext4 -q -F -L LUNA_A -E hash_seed=00000000-0000-4000-8000-000000000042 -d "$ROOTFS" "$RAW"
# e2fsck must match the e2fsprogs that created the image; host tools may be
# older and reject newer ext4 features.
e2fsck -fn "$RAW" >/dev/null

# zstd replaces xz here. Measured on Fedora, 3 cores, real editor packs in a
# 2 GiB ext4 slot (2026-11-22): shipped xz -3 = 382,112,828 bytes, new zstd -19
# = 267,191,512 bytes (0.70x) and streams to disk in 1.8s vs 14.1s for xz.
# zstd -22 --long=27 reaches 239,051,726 bytes (0.63x) but needs a 128 MiB
# decoder window on the box, so level 19 is the default. ZSTD_THREADS is capped
# at three for the same reason the old xz call had --memlimit-compress: the
# build container only gets 3 GiB.
if [ -n "$ZSTD_LONG" ]; then
	zstd -"$ZSTD_LEVEL" --long="$ZSTD_LONG" -T"$ZSTD_THREADS" -q -c "$RAW" > "$IMGTMP"
else
	zstd -"$ZSTD_LEVEL" -T"$ZSTD_THREADS" -q -c "$RAW" > "$IMGTMP"
fi
zstd -t "$IMGTMP"
rm -f "$RAW"

SHA="$(sha256sum "$IMGTMP" | awk '{print $1}')"
mv -f "$IMGTMP" "$OUT/$NAME"
printf '%s  %s\n' "$SHA" "$NAME" > "$OUT/$NAME.sha256"
# The dev wrappers pass OS_INPUT_HASH so they can skip an unchanged rebuild.
# The release tool does not: it always builds the image.
if [ -n "${OS_INPUT_HASH:-}" ]; then
	printf '%s\n' "$OS_INPUT_HASH" > "$OUT/$NAME.inputs"
else
	rm -f "$OUT/$NAME.inputs"
fi
printf 'built %s (%s MiB slot, %s bytes zstd, sha256 %s)\n' "$OUT/$NAME" "$SIZE_MB" "$(wc -c < "$OUT/$NAME" | tr -d ' ')" "$SHA"

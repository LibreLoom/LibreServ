#!/bin/sh
# Build the OTA / factory OS slot image: raw ext4 filesystem matching LUNA_A/B.
# This is the release asset `luna-os-x86_64.img` — OS only (empty /var/lib/luna
# mountpoint). It does not contain Luna state, media, or the rapidinstall ISO.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ROOTFS="$ROOT/os/work/rootfs"
OUT="$ROOT/os/dist"
IMAGE="$OUT/luna-os-x86_64.img"
# shellcheck source=lib/alpine-image.sh
. "$ROOT/os/lib/alpine-image.sh"
# shellcheck source=lib/disk.sh
. "$ROOT/os/lib/disk.sh"
SIZE_MB="${SIZE_MB:-$LUNA_SLOT_SIZE_MIB}"

[ -d "$ROOTFS" ] || { echo "missing $ROOTFS — run os/build-rootfs.sh first" >&2; exit 2; }
mkdir -p "$OUT"
rm -f "$IMAGE"

# Ensure data mountpoint exists and is empty of state in the image.
mkdir -p "$ROOTFS/var/lib/luna"
# Drop any accidental state files from a dirty work tree.
find "$ROOTFS/var/lib/luna" -mindepth 1 -maxdepth 1 ! -name chrony -exec rm -rf {} + 2>/dev/null || true
mkdir -p "$ROOTFS/var/lib/luna/chrony"

podman run --rm --privileged -v "$ROOTFS:/rootfs:z" -v "$OUT:/out:z" "$ALPINE_IMAGE" sh -euc "apk add --no-cache e2fsprogs >/dev/null &&
    truncate -s ${SIZE_MB}M /out/luna-os-x86_64.img
    mkfs.ext4 -F -L LUNA_A -E hash_seed=00000000-0000-0000-0042-000000000042 -d /rootfs /out/luna-os-x86_64.img
"
e2fsck -fy "$IMAGE" >/dev/null
SHA="$(sha256sum "$IMAGE" | awk '{print $1}')"
printf '%s\n' "$SHA" >"$OUT/luna-os-x86_64.img.sha256"
printf 'built %s (%s MiB, ext4 slot image, sha256 %s)\n' "$IMAGE" "$SIZE_MB" "$SHA"

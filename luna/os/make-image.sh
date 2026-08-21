#!/bin/sh
# Turn the built rootfs into a raw ext4 filesystem image.
# The image is bootable after `flash.sh` installs extlinux on the target disk.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ROOTFS="$ROOT/os/work/rootfs"
OUT="$ROOT/os/dist"
IMAGE="$OUT/luna-os-x86_64.img"
# shellcheck source=lib/alpine-image.sh
. "$ROOT/os/lib/alpine-image.sh"
SIZE_MB="${SIZE_MB:-1200}"

[ -d "$ROOTFS" ] || { echo "missing $ROOTFS — run os/build-rootfs.sh first" >&2; exit 2; }
mkdir -p "$OUT"
rm -f "$IMAGE"

podman run --rm --privileged -v "$ROOTFS:/rootfs:z" -v "$OUT:/out:z" "$ALPINE_IMAGE" sh -euc "apk add --no-cache e2fsprogs >/dev/null &&
    truncate -s ${SIZE_MB}M /out/luna-os-x86_64.img
    mkfs.ext4 -F -L LUNA -E hash_seed=42 -d /rootfs /out/luna-os-x86_64.img
"
e2fsck -fy "$IMAGE" >/dev/null
printf 'built %s (%s MiB, ext4, label LUNA)\n' "$IMAGE" "$SIZE_MB"

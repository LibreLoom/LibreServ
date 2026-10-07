#!/bin/sh
# Dev wrapper: Luna OS slot image from the rootfs volume (see build-rootfs.sh).
# Output in os/dist/: luna-os-x86_64.img.xz (compressed once; the OTA part and
# the ISO payload are these exact bytes), its .sha256 and .inputs.
# Skips the work when the inputs did not change; LUNA_OS_FORCE=1 rebuilds.
# The work is build/image.sh, which runs inside build/Containerfile.os.
set -eu

OSDIR="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
OUT="${OUT:-$OSDIR/dist}"
# shellcheck source=lib/host-podman.sh
. "$OSDIR/lib/host-podman.sh"
# shellcheck source=lib/alpine-image.sh
. "$OSDIR/lib/alpine-image.sh"
ARCH="${ARCH:-x86_64}"

luna_need_podman
if luna_os_image_current "$OUT"; then
	echo "OS image is up to date for these inputs: $OUT/luna-os-$ARCH.img.xz"
	exit 0
fi
podman volume exists "$LUNA_ROOTFS_VOLUME" || luna_die "no rootfs yet: run os/build-rootfs.sh first"

IMAGE="$(luna_build_image os "$OSDIR/build/Containerfile.os" "ALPINE_IMAGE=$ALPINE_IMAGE")"
mkdir -p "$OUT"
echo "==> OS slot image (ext4 + xz)"
podman run --rm --security-opt label=disable --memory "$LUNA_BUILD_MEMORY" \
	-v "$OSDIR:/luna/os:ro" \
	-v "$LUNA_ROOTFS_VOLUME:/rootfs:ro" \
	-v "$OUT:/out" \
	-e ARCH="$ARCH" -e OS_INPUT_HASH="$(luna_os_input_hash)" \
	${SIZE_MB:+-e SIZE_MB="$SIZE_MB"} \
	"$IMAGE" sh /luna/os/build/image.sh
# The old flow's raw image and rootfs tarball no longer exist.
rm -f "$OUT/luna-os-$ARCH.img" "$OUT/luna-os-$ARCH.img.sha256" "$OUT/luna-rootfs-$ARCH.tar.gz"

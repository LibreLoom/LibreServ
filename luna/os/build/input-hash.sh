#!/bin/sh
# Input hash of the Luna OS image: sha256 over everything that goes into the
# rootfs and the slot image, and NOT over lunad or luna-console (lunad updates
# itself over the air, so a new lunad alone never needs a new OS image).
# Plain POSIX sh + sha256sum: runs on the host, in CI, or in any container.
#
#   usage: input-hash.sh            prints the hex hash
#   env:   ARCH ALPINE_VERSION CLOUDFLARED_VERSION ALPINE_IMAGE SIZE_MB
#
# Not covered, on purpose: package updates inside Alpine's repository for the
# pinned release (apk resolves them at build time). Set LUNA_OS_REFRESH=<any
# text> (for example a date) to force a rebuild when you want those.
set -eu
OSDIR="$(cd "$(dirname "$0")/.." && pwd)"
export LC_ALL=C

# shellcheck source=../lib/alpine-image.sh
. "$OSDIR/lib/alpine-image.sh"
# shellcheck source=../lib/cloudflared-bake.sh
. "$OSDIR/lib/cloudflared-bake.sh"
# shellcheck source=../lib/disk.sh
. "$OSDIR/lib/disk.sh"

{
	printf 'arch=%s\n' "${ARCH:-x86_64}"
	printf 'alpine_image=%s\n' "$ALPINE_IMAGE"
	printf 'alpine_version=%s\n' "${ALPINE_VERSION:-v3.24}"
	printf 'cloudflared=%s\n' "$CLOUDFLARED_VERSION"
	printf 'slot_mib=%s\n' "${SIZE_MB:-$LUNA_SLOT_SIZE_MIB}"
	printf 'refresh=%s\n' "${LUNA_OS_REFRESH:-}"
	cd "$OSDIR"
	for f in build/Containerfile.os build/rootfs.sh build/image.sh lib/alpine-image.sh \
		lib/cloudflared-bake.sh lib/disk.sh lib/build-rootfs.d/*.frag; do
		printf 'file=%s %s\n' "$f" "$(sha256sum < "$f" | awk '{print $1}')"
	done
} | sha256sum | awk '{print $1}'

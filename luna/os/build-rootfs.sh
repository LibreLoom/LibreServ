#!/bin/sh
# Dev wrapper: build the Luna OS rootfs into the `luna-os-rootfs` podman volume
# (rootless; file ownership stays right inside the user namespace).
# The work is build/rootfs.sh, which runs inside build/Containerfile.os.
#
#   LUNAD_BIN=/path/to/lunad [LUNA_CONSOLE_BIN=/path/to/luna-console] ./os/build-rootfs.sh
set -eu

OSDIR="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$OSDIR")"
# shellcheck source=lib/host-podman.sh
. "$OSDIR/lib/host-podman.sh"
# shellcheck source=lib/alpine-image.sh
. "$OSDIR/lib/alpine-image.sh"
ARCH="${ARCH:-x86_64}"

luna_need_podman
BIN="${LUNAD_BIN:-}"
if [ -z "$BIN" ]; then
	for candidate in "$ROOT/target/${ARCH}-unknown-linux-musl/release/lunad" "$ROOT/target/release/lunad"; do
		if [ -x "$candidate" ]; then
			BIN="$candidate"
			break
		fi
	done
fi
[ -n "$BIN" ] && [ -x "$BIN" ] || luna_die "missing lunad binary: cargo build --release -p lunad (musl) or set LUNAD_BIN"
CONSOLE_BIN="${LUNA_CONSOLE_BIN:-$(dirname "$BIN")/luna-console}"
[ -x "$CONSOLE_BIN" ] || luna_die "missing luna-console next to lunad ($CONSOLE_BIN): set LUNA_CONSOLE_BIN"

IMAGE="$(luna_build_image os "$OSDIR/build/Containerfile.os" "ALPINE_IMAGE=$ALPINE_IMAGE")"
podman volume exists "$LUNA_ROOTFS_VOLUME" || podman volume create "$LUNA_ROOTFS_VOLUME" >/dev/null
podman volume exists "$LUNA_CACHE_VOLUME" || podman volume create "$LUNA_CACHE_VOLUME" >/dev/null

echo "==> rootfs (volume $LUNA_ROOTFS_VOLUME)"
podman run --rm --security-opt label=disable --memory "$LUNA_BUILD_MEMORY" \
	-v "$OSDIR:/luna/os:ro" \
	-v "$(dirname "$BIN"):/in/lunad:ro" \
	-v "$(dirname "$CONSOLE_BIN"):/in/console:ro" \
	-v "$LUNA_ROOTFS_VOLUME:/rootfs" \
	-v "$LUNA_CACHE_VOLUME:/cache" \
	-e ARCH="$ARCH" -e LUNA_CACHE_DIR=/cache \
	-e LUNAD_BIN="/in/lunad/$(basename "$BIN")" \
	-e LUNA_CONSOLE_BIN="/in/console/$(basename "$CONSOLE_BIN")" \
	${ALPINE_VERSION:+-e ALPINE_VERSION="$ALPINE_VERSION"} \
	${CLOUDFLARED_VERSION:+-e CLOUDFLARED_VERSION="$CLOUDFLARED_VERSION"} \
	"$IMAGE" sh /luna/os/build/rootfs.sh

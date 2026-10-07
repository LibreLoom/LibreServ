#!/bin/sh
# Luna OS rootfs, IN-CONTAINER step (runs inside build/Containerfile.os).
# Never calls podman or sudo. The body lives in lib/build-rootfs.d/*.frag
# (MCP-sized parts); this joins and runs them.
#
#   in:  /luna/os (read-only, this directory's parent), LUNAD_BIN and
#        LUNA_CONSOLE_BIN (paths inside the container)
#   out: the rootfs tree at ROOTFS (default /rootfs, a podman volume)
#   env: ARCH ALPINE_VERSION CLOUDFLARED_VERSION LUNA_CACHE_DIR (optional cache)
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="${ROOT:-$(cd "$HERE/../.." && pwd)}"
export ROOT
PARTS="$HERE/../lib/build-rootfs.d"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
# shellcheck disable=SC2012
cat $(ls "$PARTS"/*.frag | sort) > "$TMP"
/bin/sh "$TMP" "$@"

#!/bin/sh
# Luna OS rootfs builder — body lives in lib/build-rootfs.d/*.frag (MCP-sized parts).
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
export ROOT
PARTS="$HERE/lib/build-rootfs.d"
TMP="$(mktemp)"
# shellcheck disable=SC2012
cat $(ls "$PARTS"/*.frag | sort) > "$TMP"
chmod +x "$TMP"
exec /bin/sh "$TMP" "$@"

#!/bin/sh
# Dev: put a new lunad binary into both OS slots of a virtual Luna disk, leaving
# everything else (OS files, data partition) as it is. Needs root (loop device).
# The disk's recorded OS image checksum no longer matches the slots afterwards,
# which only matters for OS updates; wyse-vm.sh refresh restores a clean disk.
#
#   sudo iso/swap-lunad.sh DISK.raw LUNAD_BINARY
set -eu
[ "$#" -eq 2 ] || { echo "usage: $0 DISK.raw LUNAD_BINARY" >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || { echo "run as root (it sets up a loop device)" >&2; exit 2; }
DISK="$1"
BIN="$2"
[ -f "$DISK" ] && [ -s "$BIN" ] || { echo "missing disk or binary" >&2; exit 2; }

LOOP="$(losetup --find --show --partscan "$DISK")"
MNT="$(mktemp -d /tmp/luna-swap.XXXXXX)"
cleanup() {
	umount "$MNT" 2>/dev/null || true
	rmdir "$MNT" 2>/dev/null || true
	losetup -d "$LOOP" 2>/dev/null || true
}
trap cleanup EXIT
for p in 3 4; do
	mount "${LOOP}p$p" "$MNT"
	install -m 0755 "$BIN" "$MNT/usr/local/bin/lunad"
	sync
	umount "$MNT"
done
echo "lunad swapped in both slots"

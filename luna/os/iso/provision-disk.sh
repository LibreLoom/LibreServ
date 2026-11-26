#!/bin/sh
# Dev: build a ready-to-boot Luna disk image from os/dist/luna-os-x86_64.img.zst,
# using the same flash code the installer runs (partitions, both OS slots,
# GRUB for BIOS and UEFI, checksum, optional Device ID + Verification code).
# It skips only the installer's screens. Needs root (loop device); wyse-vm.sh
# calls it through sudo.
#
#   sudo iso/provision-disk.sh DISK.raw [DEVICE_ID VERIFICATION_CODE]
#
# KEEP_DATA_FROM=OLD.raw copies the old disk's data partition (accounts, files
# index, settings) onto the new one, so only the operating system is replaced.
set -eu

[ "$#" -ge 1 ] || { echo "usage: $0 DISK.raw [DEVICE_ID VERIFICATION_CODE]" >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || { echo "run as root (it sets up a loop device)" >&2; exit 2; }
DISK="$1"
UID_="${2:-}"
CODE="${3:-}"

ROOT="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
IMG="${LUNA_OS_IMAGE:-$ROOT/os/dist/luna-os-x86_64.img.zst}"
[ -f "$IMG" ] || { echo "missing $IMG: run os/build-iso.sh first" >&2; exit 2; }

# shellcheck disable=SC1091
. "$ROOT/os/lib/disk.sh"
# shellcheck disable=SC1091
. "$ROOT/os/lib/flash-disk.sh"
# shellcheck disable=SC1091
. "$ROOT/os/lib/factory-assets.sh"

truncate -s 8G "$DISK"
LOOP="$(losetup --find --show --partscan "$DISK")"
MNT=""
OLD_LOOP=""
OLD_MNT=""
cleanup() {
	[ -z "$OLD_MNT" ] || { umount "$OLD_MNT" 2>/dev/null || true; rmdir "$OLD_MNT" 2>/dev/null || true; }
	[ -z "$OLD_LOOP" ] || losetup -d "$OLD_LOOP" 2>/dev/null || true
	[ -z "$MNT" ] || { umount "$MNT" 2>/dev/null || true; rmdir "$MNT" 2>/dev/null || true; }
	losetup -d "$LOOP" 2>/dev/null || true
}
trap cleanup EXIT

# The flash code only accepts real disks. Allow exactly the loop device made
# above, so nothing else can be erased through this script.
is_whole_disk() { [ "$1" = "$LOOP" ]; }
partition_node() { printf '%sp%s\n' "$1" "${2:-1}"; }

flash_luna_disk "$LOOP" "$IMG"
# The flash code sets its own EXIT trap; take it back so we always unmount and detach.
trap cleanup EXIT

MNT="$(mktemp -d /tmp/luna-prov.XXXXXX)"
mount -o rw "$(partition_data "$LOOP")" "$MNT"
if [ -n "${KEEP_DATA_FROM:-}" ]; then
	[ -f "$KEEP_DATA_FROM" ] || { echo "no old disk at $KEEP_DATA_FROM" >&2; exit 2; }
	OLD_LOOP="$(losetup --find --show --partscan --read-only "$KEEP_DATA_FROM")"
	OLD_MNT="$(mktemp -d /tmp/luna-old.XXXXXX)"
	# noload: the old disk may not have been shut down cleanly; never replay its journal.
	mount -o ro,noload "$(partition_node "$OLD_LOOP" 5)" "$OLD_MNT"
	echo "==> keeping the old data partition"
	(cd "$OLD_MNT" && tar --numeric-owner --xattrs --acls -cf - --exclude=./os-image.sha256 --exclude=./lost+found .) |
		(cd "$MNT" && tar --numeric-owner --xattrs --acls -xpf -)
fi
_record_os_image_hash "$MNT" "$_os_hash"
if [ -n "$UID_" ]; then
	factory_write_pairing_material "$MNT" "$UID_" "$CODE" || {
		echo "That Device ID or Verification code is not valid." >&2
		exit 1
	}
fi
sync
cleanup
trap - EXIT
echo "disk ready: $DISK"

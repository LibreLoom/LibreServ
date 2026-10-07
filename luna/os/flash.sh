#!/bin/sh
# Flash Luna OS onto a target disk.
#
# Workstation: pull a SATA/NVMe drive and pass /dev/sdX.
# Thin client: boot the rapidinstall ISO instead — eMMC is /dev/mmcblk0
# (UEFI GPT: ESP + LUNA_A + LUNA_B + LUNA_DATA) and is not meant to be removed.
set -eu

if [ "$#" -ne 1 ]; then
	echo "usage: $0 /dev/sdX   (or /dev/mmcblk0 /dev/nvme0n1)" >&2
	echo "thin clients: boot os/dist/luna-rapidinstall-x86_64.iso instead" >&2
	exit 2
fi
DEV="$1"

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
# shellcheck disable=SC1091
. "$ROOT/os/lib/disk.sh"
# shellcheck disable=SC1091
. "$ROOT/os/lib/flash-disk.sh"

if ! is_whole_disk "$DEV"; then
	echo "refusing: expected a whole disk like /dev/sda or /dev/mmcblk0, got $DEV" >&2
	exit 2
fi

ARCH="${ARCH:-x86_64}"
SLOT_IMG="$ROOT/os/dist/luna-os-$ARCH.img.xz"
[ -f "$SLOT_IMG" ] || {
	echo "missing $SLOT_IMG — run os/build-rootfs.sh and os/make-image.sh first" >&2
	exit 2
}

echo "This will ERASE everything on $DEV."
printf 'Type the device name again to continue: '
read -r CONFIRM
if [ "$CONFIRM" != "$DEV" ]; then
	echo "cancelled" >&2
	exit 1
fi

flash_luna_disk "$DEV" "$SLOT_IMG"
echo "If this was a removable drive: power off, install it in the Luna, and boot."

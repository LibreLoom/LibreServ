#!/bin/sh
# Flash Luna OS onto a target disk (the internal SSD of a Wyse 5020).
#
# SAFETY: requires the full device path as an argument, refuses anything that
# looks like a partition, and requires a second confirmation typed in full.
set -eu

if [ "$#" -ne 1 ]; then
    echo "usage: $0 /dev/sdX" >&2
    exit 2
fi
DEV="$1"
case "$DEV" in
    /dev/sd[a-z]|/dev/nvme[0-9]n[0-9]) ;;
    *) echo "refusing: expected a whole disk like /dev/sda, got $DEV" >&2; exit 2 ;;
esac

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARBALL="$ROOT/os/dist/luna-rootfs-x86_64.tar.gz"
[ -f "$TARBALL" ] || { echo "missing $TARBALL — run os/build-rootfs.sh first" >&2; exit 2; }

echo "This will ERASE everything on $DEV."
printf 'Type the device name again to continue: '
read -r CONFIRM
if [ "$CONFIRM" != "$DEV" ]; then
    echo "cancelled" >&2
    exit 1
fi

echo "==> partitioning $DEV"
sfdisk --wipe always "$DEV" <<PART
label: dos
1: type=83, bootable
PART
sleep 1
PART="${DEV}1"
[ -b "$PART" ] || partprobe "$DEV" || true

echo "==> formatting $PART"
mkfs.ext4 -F -L LUNA "$PART"

MNT="$(mktemp -d)"
mount "$PART" "$MNT"
trap 'umount "$MNT" 2>/dev/null || true; rmdir "$MNT" 2>/dev/null || true' EXIT

echo "==> extracting Luna OS"
tar -xzf "$TARBALL" -C "$MNT"

echo "==> installing bootloader"
extlinux --install "$MNT"
dd if=/usr/share/syslinux/mbr.bin of="$DEV" bs=440 count=1 conv=fsync 2>/dev/null || true
printf 'DEFAULT luna\nLABEL luna\n  KERNEL /boot/vmlinuz-lts\n  APPEND root=LABEL=LUNA modules=ext4 quiet\n' > "$MNT/extlinux.conf"
# Alpine kernel names vary; point at whichever LTS kernel is present.
if [ ! -e "$MNT/boot/vmlinuz-lts" ]; then
    KERNEL="$(find "$MNT/boot" -maxdepth 1 -name 'vmlinuz-*' | head -1)"
    sed -i "s#/boot/vmlinuz-lts#${KERNEL#$MNT}#" "$MNT/extlinux.conf" 2>/dev/null || true
fi

echo "==> syncing"
sync
echo "done. Power off, install $DEV in the Luna, and boot."

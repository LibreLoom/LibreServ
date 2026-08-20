#!/bin/sh
# Rapidinstall: run from the live ISO. Picks the thin client's built-in
# storage (usually eMMC at /dev/mmcblk0), never the USB this image booted from.

set -eu

HERE="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
. "$HERE/lib/disk.sh"
# shellcheck disable=SC1091
. "$HERE/lib/flash-disk.sh"

ARCH="${ARCH:-x86_64}"
TARBALL="${LUNA_ROOTFS:-$HERE/luna-rootfs-$ARCH.tar.gz}"
MBR="${LUNA_MBR_BIN:-$HERE/mbr.bin}"
[ -f "$MBR" ] || MBR=/usr/share/syslinux/mbr.bin

discover_install_disk() {
	_src="${LUNA_INSTALL_MEDIA:-}"
	if [ -z "$_src" ] && [ -f /proc/mounts ]; then
		_src="$(awk '$2=="/src" { print $1; exit }' /proc/mounts || true)"
	fi
	[ -n "$_src" ] || return 0
	LUNA_INSTALL_DISK="$(whole_disk_of "$_src")"
	export LUNA_INSTALL_DISK
}

list_block_disks() {
	[ -d /sys/block ] || return 0
	for _n in /sys/block/*; do
		[ -e "$_n" ] || continue
		printf '/dev/%s\n' "$(basename "$_n")"
	done
}

skip_disk() {
	case "$1" in
	/dev/loop* | /dev/ram* | /dev/zram* | /dev/sr* | /dev/dm-* | /dev/md*)
		return 0
		;;
	esac
	is_emmc_aux "$1" && return 0
	is_install_media "$1" && return 0
	is_usb_disk "$1" && return 0
	return 1
}

pick_builtin() {
	_mmc=""
	_mmc_count=0
	_other=""
	_other_count=0
	for _d in $(list_block_disks); do
		is_whole_disk "$_d" || continue
		skip_disk "$_d" && continue
		[ -b "$_d" ] || continue
		case "$_d" in
		/dev/mmcblk*)
			_mmc_count=$((_mmc_count + 1))
			[ -z "$_mmc" ] && _mmc="$_d"
			;;
		*)
			_other_count=$((_other_count + 1))
			[ -z "$_other" ] && _other="$_d"
			;;
		esac
	done
	if [ "$_mmc_count" -eq 1 ]; then
		printf '%s\n' "$_mmc"
		return 0
	fi
	if [ "$_mmc_count" -gt 1 ]; then
		printf '%s\n' "$_mmc"
		return 0
	fi
	if [ "$_other_count" -eq 1 ]; then
		printf '%s\n' "$_other"
		return 0
	fi
	return 1
}

print_disks() {
	echo
	echo "Disks Luna can see:"
	if command -v lsblk >/dev/null 2>&1; then
		lsblk -d -o NAME,SIZE,MODEL,TRAN,RM,TYPE 2>/dev/null || lsblk
	else
		list_block_disks
	fi
	echo
}

size_hint() {
	_sz="/sys/block/$(block_name "$1")/size"
	if [ -f "$_sz" ]; then
		_sectors="$(cat "$_sz")"
		_mb=$((_sectors / 2048))
		printf '%s MB' "$_mb"
		return
	fi
	printf 'size unknown'
}

discover_install_disk

if [ ! -f "$TARBALL" ]; then
	echo "This USB is missing the Luna OS archive. Rebuild the ISO with make-iso.sh." >&2
	exit 1
fi

echo
echo "Luna rapidinstall"
echo "This computer's built-in storage will be erased and Luna will be installed."
echo "The USB stick you booted from is left alone. Extra USB drives are left alone."
echo

TARGET="${LUNA_TARGET:-}"
if [ -z "$TARGET" ]; then
	TARGET="$(pick_builtin || true)"
fi

if [ -n "$TARGET" ]; then
	echo "Built-in storage: $TARGET ($(size_hint "$TARGET"))."
else
	echo "Luna could not pick built-in storage automatically."
	print_disks
	printf "Type the whole disk to install to (for example /dev/mmcblk0): "
	read -r TARGET
fi

if ! is_whole_disk "$TARGET"; then
	echo "That is not a whole disk Luna can flash." >&2
	print_disks
	exit 2
fi
if skip_disk "$TARGET"; then
	echo "Luna will not install there (USB stick, installer media, or a special eMMC boot chip)." >&2
	exit 2
fi

print_disks
echo "Type  install luna  to erase $TARGET and continue."
printf "> "
read -r CONFIRM
if [ "$CONFIRM" != "install luna" ]; then
	echo "cancelled"
	exit 1
fi

flash_luna_disk "$TARGET" "$TARBALL" "$MBR"

#!/bin/sh
# Find the Luna rapidinstall ISO after the kernel has started.
# A dd'd isohybrid USB often looks like GPT (EFI partition labeled LUNAUEFI)
# while the installer files live on ISO9660 on the whole disk (label LUNAINST).
# GRUB may have booted that volume as (cd0); Linux then sees /dev/sdX, not a CD.

luna_dir_has_installer() {
	[ -f "$1/rapidinstall.sh" ] || [ -f "$1/RAPIDINSTALL.SH" ] || [ -f "$1/rapidins.sh" ]
}

# Print block devices to try, optical first, then whole disks, then partitions.
# Override sysfs with LUNA_SYS_CLASS_BLOCK for tests.
luna_block_candidates() {
	_root="${LUNA_SYS_CLASS_BLOCK:-/sys/class/block}"
	_sr=""
	_whole=""
	_part=""
	for _p in "$_root"/*; do
		[ -e "$_p" ] || continue
		_n="${_p##*/}"
		case "$_n" in
		loop* | ram* | zram* | dm-* | md* | fd*)
			continue
			;;
		esac
		case "$_n" in
		sr*)
			_sr="$_sr /dev/$_n"
			;;
		sd[a-z] | vd[a-z] | hd[a-z] | nvme[0-9]n[0-9] | nvme[0-9]n[0-9][0-9] | mmcblk[0-9] | mmcblk[0-9][0-9])
			_whole="$_whole /dev/$_n"
			;;
		*)
			_part="$_part /dev/$_n"
			;;
		esac
	done
	# shellcheck disable=SC2086
	{
		printf '%s\n' $_sr | awk 'NF' | sort
		printf '%s\n' $_whole | awk 'NF' | sort
		printf '%s\n' $_part | awk 'NF' | sort
	}
}

luna_mount_installer() {
	_dev="$1"
	_mnt="$2"
	umount "$_mnt" 2>/dev/null || true
	mkdir -p "$_mnt"
	if ! mount -t iso9660 -o ro "$_dev" "$_mnt" 2>/dev/null; then
		if ! mount -o ro "$_dev" "$_mnt" 2>/dev/null; then
			return 1
		fi
	fi
	if luna_dir_has_installer "$_mnt"; then
		return 0
	fi
	umount "$_mnt" 2>/dev/null || true
	return 1
}

luna_find_install_media() {
	_mnt="$1"
	mkdir -p "$_mnt"
	if command -v blkid >/dev/null 2>&1; then
		_lab="$(blkid -L LUNAINST 2>/dev/null || true)"
		if [ -n "$_lab" ] && luna_mount_installer "$_lab" "$_mnt"; then
			printf '%s\n' "$_lab"
			return 0
		fi
	fi
	for _dev in $(luna_block_candidates); do
		[ -b "$_dev" ] || continue
		if luna_mount_installer "$_dev" "$_mnt"; then
			printf '%s\n' "$_dev"
			return 0
		fi
	done
	return 1
}

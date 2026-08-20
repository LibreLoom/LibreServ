#!/bin/sh
# Whole-disk helpers for Luna's flash tools.
# Thin clients boot from eMMC (/dev/mmcblk0, partitions mmcblk0p1) — not a
# pullable SATA SSD. USB install media must never be the flash target.

# True for a whole disk we are willing to consider flashing.
is_whole_disk() {
	case "$1" in
	/dev/sd[a-z] | /dev/vd[a-z] | /dev/hd[a-z]) return 0 ;;
	/dev/nvme[0-9]n[0-9] | /dev/nvme[0-9]n[0-9][0-9]) return 0 ;;
	/dev/mmcblk[0-9] | /dev/mmcblk[0-9][0-9]) return 0 ;;
	*) return 1 ;;
	esac
}

# First partition node for a whole disk (p-suffix for nvme/mmc).
partition_node() {
	case "$1" in
	/dev/nvme* | /dev/mmcblk*) printf '%sp1\n' "$1" ;;
	*) printf '%s1\n' "$1" ;;
	esac
}

block_name() {
	printf '%s\n' "${1#/dev/}"
}

# Parent whole-disk of a partition or the disk itself.
whole_disk_of() {
	case "$1" in
	/dev/nvme*p[0-9]*)
		printf '%s\n' "${1%p*}"
		return
		;;
	/dev/mmcblk*p[0-9]*)
		printf '%s\n' "${1%p*}"
		return
		;;
	/dev/sd[a-z][0-9]* | /dev/vd[a-z][0-9]* | /dev/hd[a-z][0-9]*)
		printf '/dev/%s\n' "$(printf '%s' "${1#/dev/}" | sed 's/[0-9][0-9]*$//')"
		return
		;;
	esac
	printf '%s\n' "$1"
}

# eMMC hardware boot/rpmb nodes — never flash these.
is_emmc_aux() {
	case "$1" in
	/dev/mmcblk*boot* | /dev/mmcblk*rpmb*) return 0 ;;
	*) return 1 ;;
	esac
}

is_usb_disk() {
	_sys="/sys/block/$(block_name "$1")"
	[ -e "$_sys" ] || return 1
	_link="$(readlink -f "$_sys" 2>/dev/null || true)"
	case "$_link" in
	*/usb[0-9]* | */usb) return 0 ;;
	esac
	return 1
}

is_removable() {
	_f="/sys/block/$(block_name "$1")/removable"
	[ -f "$_f" ] && [ "$(cat "$_f" 2>/dev/null || echo 1)" = "1" ]
}

# ISO/USB install media: never a flash target.
is_install_media() {
	_want="$(whole_disk_of "$1")"
	[ -n "${LUNA_INSTALL_DISK:-}" ] || return 1
	[ "$_want" = "$LUNA_INSTALL_DISK" ]
}

#!/bin/sh
# Whole-disk helpers for Luna's flash tools.
# GPT layout (x86_64 BIOS + UEFI):
#   1 BIOSGRUB + 2 ESP + 3 LUNA_A + 4 LUNA_B + 5 LUNA_DATA
# USB install media must never be the flash target.

# Fixed OS slot size (MiB). Both A and B match luna-os-*.img from make-image.sh.
LUNA_SLOT_SIZE_MIB="${LUNA_SLOT_SIZE_MIB:-1280}"

# True for a whole disk we are willing to consider flashing. Two-letter SCSI
# suffixes (sdaa) and double-digit controllers/namespaces (nvme10n1,
# mmcblk10) are covered; partition suffixes never match.
is_whole_disk() {
	case "$1" in
	/dev/sd[a-z] | /dev/sd[a-z][a-z] | /dev/vd[a-z] | /dev/vd[a-z][a-z] | /dev/hd[a-z] | /dev/hd[a-z][a-z]) return 0 ;;
	/dev/nvme[0-9]n[0-9] | /dev/nvme[0-9]n[0-9][0-9] | /dev/nvme[0-9]n[0-9][0-9][0-9]) return 0 ;;
	/dev/nvme[0-9][0-9]n[0-9] | /dev/nvme[0-9][0-9]n[0-9][0-9] | /dev/nvme[0-9][0-9]n[0-9][0-9][0-9]) return 0 ;;
	/dev/mmcblk[0-9] | /dev/mmcblk[0-9][0-9]) return 0 ;;
	*) return 1 ;;
	esac
}

# Partition node: $2 is the GPT index.
partition_node() {
	_idx="${2:-1}"
	case "$1" in
	/dev/nvme* | /dev/mmcblk*) printf '%sp%s\n' "$1" "$_idx" ;;
	*) printf '%s%s\n' "$1" "$_idx" ;;
	esac
}

partition_bios_grub() {
	partition_node "$1" 1
}

partition_esp() {
	partition_node "$1" 2
}

# Active OS slot A (factory default). Kept as partition_root for older callers.
partition_root_a() {
	partition_node "$1" 3
}

partition_root_b() {
	partition_node "$1" 4
}

partition_root() {
	partition_root_a "$1"
}

partition_data() {
	partition_node "$1" 5
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
	/dev/sd[a-z][0-9]* | /dev/sd[a-z][a-z][0-9]* | /dev/vd[a-z][0-9]* | /dev/vd[a-z][a-z][0-9]* | /dev/hd[a-z][0-9]* | /dev/hd[a-z][a-z][0-9]*)
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

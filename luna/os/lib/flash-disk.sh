#!/bin/sh
# Write Luna OS onto a whole disk: MBR + one ext4 + extlinux.
# Used by flash.sh (workstation) and rapidinstall.sh (live ISO).

flash_luna_disk() {
	_dev="$1"
	_tarball="$2"
	_mbr="${3:-${LUNA_MBR_BIN:-/usr/share/syslinux/mbr.bin}}"

	if ! is_whole_disk "$_dev"; then
		echo "Luna only flashes a whole disk (for example /dev/mmcblk0 or /dev/sda), not a partition." >&2
		return 2
	fi
	if is_emmc_aux "$_dev"; then
		echo "That device is a special eMMC boot area, not the computer's storage. Refusing." >&2
		return 2
	fi
	if is_install_media "$_dev"; then
		echo "That disk is the USB stick this installer booted from. Luna will not erase it." >&2
		return 2
	fi
	if [ ! -b "$_dev" ]; then
		echo "No disk at $_dev." >&2
		return 2
	fi
	if [ ! -f "$_tarball" ]; then
		echo "missing Luna OS archive: $_tarball" >&2
		return 2
	fi

	_part="$(partition_node "$_dev")"

	echo "==> partitioning $_dev"
	sfdisk --wipe always "$_dev" <<PART
label: dos
1: type=83, bootable
PART
	sleep 1
	if command -v partprobe >/dev/null 2>&1; then
		partprobe "$_dev" 2>/dev/null || true
	fi
	_i=0
	while [ ! -b "$_part" ] && [ "$_i" -lt 20 ]; do
		sleep 1
		_i=$((_i + 1))
	done
	if [ ! -b "$_part" ]; then
		echo "The new partition $_part never appeared. Stopped before erasing further." >&2
		return 1
	fi

	echo "==> formatting $_part"
	mkfs.ext4 -F -L LUNA "$_part"

	_mnt="$(mktemp -d)"
	mount "$_part" "$_mnt"
	# shellcheck disable=SC2064
	trap 'umount "$_mnt" 2>/dev/null || true; rmdir "$_mnt" 2>/dev/null || true; trap - EXIT INT' EXIT INT

	echo "==> extracting Luna OS"
	tar -xzf "$_tarball" -C "$_mnt"

	echo "==> installing bootloader"
	extlinux --install "$_mnt"
	if [ -f "$_mbr" ]; then
		dd if="$_mbr" of="$_dev" bs=440 count=1 conv=fsync 2>/dev/null || true
	fi
	printf 'DEFAULT luna\nLABEL luna\n  KERNEL /boot/vmlinuz-lts\n  APPEND root=LABEL=LUNA modules=ext4 quiet\n' >"$_mnt/extlinux.conf"
	if [ ! -e "$_mnt/boot/vmlinuz-lts" ]; then
		_kernel="$(find "$_mnt/boot" -maxdepth 1 -name 'vmlinuz-*' | head -1)"
		if [ -n "$_kernel" ]; then
			_rel="${_kernel#"$_mnt"}"
			sed -i "s#/boot/vmlinuz-lts#${_rel}#" "$_mnt/extlinux.conf" 2>/dev/null || true
		fi
	fi

	echo "==> syncing"
	sync
	umount "$_mnt"
	rmdir "$_mnt" 2>/dev/null || true
	trap - EXIT INT
	echo "done. Remove the USB stick and reboot this computer to start Luna."
}

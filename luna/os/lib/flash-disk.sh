#!/bin/sh
# Write Luna OS onto a whole disk so it can start on ordinary x86_64 machines:
# BIOS (mini PCs, older boxes) and UEFI (Wyse 3040, modern mini PCs).
# GPT: 1 MiB bios_grub + ESP + ext4 root. GRUB is installed for i386-pc and
# x86_64-efi (--removable, no NVRAM). At least one of those must succeed.

_wait_block() {
	_path="$1"
	_n=0
	while [ ! -b "$_path" ] && [ "$_n" -lt 20 ]; do
		sleep 1
		_n=$((_n + 1))
	done
	[ -b "$_path" ]
}

_write_grub_cfg() {
	_rootmnt="$1"
	mkdir -p "$_rootmnt/boot/grub"
	_k=vmlinuz-lts
	_i=initramfs-lts
	if [ ! -e "$_rootmnt/boot/$_k" ]; then
		_k="$(basename "$(find "$_rootmnt/boot" -maxdepth 1 -name 'vmlinuz-*' | head -1)")"
	fi
	if [ ! -e "$_rootmnt/boot/$_i" ]; then
		_i="$(basename "$(find "$_rootmnt/boot" -maxdepth 1 -name 'initramfs-*' | head -1)")"
	fi
	{
		echo 'set default=0'
		echo 'set timeout=2'
		echo 'insmod part_gpt'
		echo 'insmod ext2'
		echo 'search --no-floppy --set=root --label LUNA'
		if [ -n "$_k" ] && [ "$_k" != "." ]; then
			echo "linux /boot/${_k} root=LABEL=LUNA modules=ext4 quiet"
		fi
		if [ -n "$_i" ] && [ "$_i" != "." ]; then
			echo "initrd /boot/${_i}"
		fi
	} >"$_rootmnt/boot/grub/grub.cfg"
}

flash_luna_disk() {
	_dev="$1"
	_tarball="$2"

	if ! is_whole_disk "$_dev"; then
		echo "Luna only flashes a whole disk (for example /dev/sda, /dev/nvme0n1, or /dev/mmcblk0), not a partition." >&2
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
	if ! command -v grub-install >/dev/null 2>&1; then
		echo "This environment is missing GRUB. Boot the rapidinstall ISO instead." >&2
		return 1
	fi

	_bios="$(partition_bios_grub "$_dev")"
	_esp="$(partition_esp "$_dev")"
	_root="$(partition_root "$_dev")"

	echo "==> partitioning $_dev (GPT, BIOS + UEFI)"
	# bios_grub: GRUB's core.img on BIOS machines. ESP: UEFI. Root: Luna.
	sfdisk --wipe always "$_dev" <<PART
label: gpt
unit: sectors
first-lba: 2048

start=2048, size=2048, type=21686148-6449-6E6F-744E-656564454649, name=BIOSGRUB
size=262144, type=C12A7328-F81F-11D2-BA4B-00A0C93EC93B, name=ESP, bootable
type=0FC63DAF-8483-4772-8E79-3D69D8477DE4, name=LUNA
PART
	sleep 1
	if command -v partprobe >/dev/null 2>&1; then
		partprobe "$_dev" 2>/dev/null || true
	fi
	if ! _wait_block "$_bios" || ! _wait_block "$_esp" || ! _wait_block "$_root"; then
		echo "The new partitions never appeared. Stopped before erasing further." >&2
		return 1
	fi

	echo "==> formatting EFI and Luna partitions"
	mkfs.vfat -F 32 -n LUNAESP "$_esp"
	mkfs.ext4 -F -L LUNA "$_root"

	_mnt="$(mktemp -d)"
	_espmnt="$(mktemp -d)"
	mount "$_root" "$_mnt"
	mount "$_esp" "$_espmnt"
	# shellcheck disable=SC2064
	trap 'umount "$_espmnt" 2>/dev/null || true; umount "$_mnt" 2>/dev/null || true; rmdir "$_espmnt" "$_mnt" 2>/dev/null || true; trap - EXIT INT' EXIT INT

	echo "==> extracting Luna OS"
	tar -xzf "$_tarball" -C "$_mnt"

	echo "==> installing bootloader (BIOS and UEFI)"
	mkdir -p "$_mnt/boot" "$_espmnt/EFI/BOOT"
	_write_grub_cfg "$_mnt"
	_bios_ok=0
	_efi_ok=0
	if grub-install --target=i386-pc --boot-directory="$_mnt/boot" "$_dev"; then
		_bios_ok=1
	fi
	if grub-install --target=x86_64-efi --efi-directory="$_espmnt" \
		--boot-directory="$_mnt/boot" --removable --no-nvram "$_dev"; then
		_efi_ok=1
	fi
	grub-install --target=i386-efi --efi-directory="$_espmnt" \
		--boot-directory="$_mnt/boot" --removable --no-nvram "$_dev" 2>/dev/null || true
	if [ -f "$_espmnt/EFI/BOOT/BOOTX64.EFI" ] || [ -f "$_espmnt/EFI/BOOT/BOOTIA32.EFI" ]; then
		_efi_ok=1
	fi
	if [ "$_bios_ok" -eq 0 ] && [ "$_efi_ok" -eq 0 ]; then
		echo "GRUB could not install a BIOS or UEFI bootloader. This computer would not start after reboot." >&2
		return 1
	fi
	cp "$_mnt/boot/grub/grub.cfg" "$_espmnt/EFI/BOOT/grub.cfg" 2>/dev/null || true

	echo "==> syncing"
	sync
	umount "$_espmnt"
	umount "$_mnt"
	rmdir "$_espmnt" "$_mnt" 2>/dev/null || true
	trap - EXIT INT
	echo "done. Remove the USB stick (if you used one) and reboot to start Luna."
	echo "If the computer talks about 'secure boot', turn that off in the firmware menu."
}

#!/bin/sh
# Rapidinstall: run from the live ISO. Picks the smallest non-USB disk
# (built-in eMMC, SATA, or NVMe). USB sticks, including the one this
# image booted from, are never chosen automatically.

set -eu

HERE="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
. "$HERE/lib/disk.sh"
# shellcheck disable=SC1091
. "$HERE/lib/flash-disk.sh"
# shellcheck disable=SC1091
. "$HERE/lib/console.sh"
# shellcheck disable=SC1091
. "$HERE/lib/factory-assets.sh"

ARCH="${ARCH:-x86_64}"
TARBALL="${LUNA_ROOTFS:-$HERE/luna-rootfs-$ARCH.tar.gz}"

# QEMU / automation: allow overrides from the kernel command line.
if [ -z "${LUNA_TARGET:-}" ] && [ -r /proc/cmdline ]; then
	for _tok in $(cat /proc/cmdline); do
		case "$_tok" in
		LUNA_TARGET=*) LUNA_TARGET="${_tok#LUNA_TARGET=}" ;;
		LUNA_INSTALL_MEDIA=*) LUNA_INSTALL_MEDIA="${_tok#LUNA_INSTALL_MEDIA=}" ;;
		LUNA_OVERRIDE_WAIT=*) LUNA_OVERRIDE_WAIT="${_tok#LUNA_OVERRIDE_WAIT=}" ;;
		LUNA_ROOTFS=*) LUNA_ROOTFS="${_tok#LUNA_ROOTFS=}"; TARBALL="$LUNA_ROOTFS" ;;
		esac
	done
	export LUNA_TARGET LUNA_INSTALL_MEDIA LUNA_OVERRIDE_WAIT LUNA_ROOTFS
fi

discover_install_disk() {
	_src="${LUNA_INSTALL_MEDIA:-}"
	if [ -z "$_src" ] && [ -f /proc/mounts ]; then
		_src="$(awk '$2=="/src" { print $1; exit }' /proc/mounts || true)"
	fi
	if [ -z "$_src" ]; then
		echo "WARNING: could not identify the boot media; installer-stick protection may be inactive." >&2
		return 0
	fi
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

disk_sectors() {
	_szf="/sys/block/$(block_name "$1")/size"
	if [ -f "$_szf" ]; then
		cat "$_szf"
		return
	fi
	printf '0'
}

# Smallest whole disk that is not USB, not the installer media, and not
# a special eMMC boot chip. One non-USB → that disk. Several → smallest.
pick_builtin() {
	_best=""
	_best_sz=""
	for _d in $(list_block_disks); do
		is_whole_disk "$_d" || continue
		skip_disk "$_d" && continue
		[ -b "$_d" ] || continue
		_sz="$(disk_sectors "$_d")"
		[ "$_sz" -gt 0 ] 2>/dev/null || continue
		if [ -z "$_best" ] || [ "$_sz" -lt "$_best_sz" ]; then
			_best="$_d"
			_best_sz="$_sz"
		fi
	done
	[ -n "$_best" ] || return 1
	printf '%s\n' "$_best"
}

list_candidates() {
	for _d in $(list_block_disks); do
		is_whole_disk "$_d" || continue
		skip_disk "$_d" && continue
		[ -b "$_d" ] || continue
		printf '%s\n' "$_d"
	done
}

# Numbered list; one keypress (1–9). Sets TARGET.
prompt_target() {
	_list="$(list_candidates)"
	if [ -z "$_list" ]; then
		echo "Luna cannot see a built-in disk to install to." >&2
		print_disks
		exit 2
	fi
	echo
	echo "Press a number to choose the disk Luna will erase:"
	_n=0
	while IFS= read -r _d; do
		[ -n "$_d" ] || continue
		_n=$((_n + 1))
		echo "  $_n) $_d ($(size_hint "$_d"))"
	done <<EOF
$_list
EOF
	print_disks
	printf "Number: "
	console_cbreak
	while :; do
		_k="$(read_console_byte)" || {
			console_sane
			echo >&2
			exit 1
		}
		echo
		drain_stdin
		case "$_k" in
		[1-9])
			TARGET="$(printf '%s\n' "$_list" | awk -v n="$_k" 'NR == n { print; exit }')"
			if [ -n "$TARGET" ]; then
				console_sane
				return 0
			fi
			;;
		esac
		printf "Not a listed number. Try again: "
	done
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
attach_installer_console || true

if [ ! -f "$TARBALL" ]; then
	echo "This USB is missing the Luna OS archive. Rebuild the ISO with make-iso.sh." >&2
	exit 1
fi

echo
echo "Luna rapidinstall"
echo "Works on ordinary 64-bit PCs: BIOS or UEFI, SATA, NVMe, or eMMC."
echo "This computer's built-in storage will be erased and Luna will be installed."
echo "The USB stick you booted from is left alone. Extra USB drives are left alone."
echo "If several built-in disks are present, Luna picks the smallest."
echo "If the firmware has Secure Boot, turn it off before rebooting into Luna."
echo

TARGET="${LUNA_TARGET:-}"
_forced_target=0
if [ -n "$TARGET" ]; then
	_forced_target=1
else
	TARGET="$(pick_builtin || true)"
fi

if [ -n "$TARGET" ] && [ "$_forced_target" -eq 0 ]; then
	echo "Installing to $TARGET ($(size_hint "$TARGET"))."
	# Always wait ~5s (countdown on the console). A missing tty or timeout
	# binary must not skip straight to erase.
	if wait_override_key "${LUNA_OVERRIDE_WAIT:-5}"; then
		drain_stdin
		TARGET=""
		prompt_target
	fi
elif [ -z "$TARGET" ]; then
	echo "Luna could not pick built-in storage automatically."
	prompt_target
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

echo "Erasing $TARGET and installing Luna."
# Prefer a slot image next to the tarball when the ISO staged one (OS cuts).
_slot_img=""
for _cand in "$HERE/luna-os-x86_64.img" "$HERE/../luna-os-x86_64.img"; do
	if [ -f "$_cand" ]; then
		_slot_img="$_cand"
		break
	fi
done
if ! flash_luna_disk "$TARGET" "$TARBALL" "${_slot_img:-}"; then
	echo
	echo "Install failed. The disk may be half-written — do not reboot into it yet."
	echo "Fix the error above, or re-run from the USB stick."
	exit 1
fi
echo
echo "Installation complete."

# Official setup code + OS hash live on LUNA_DATA, not on an OS slot.
# Mount at /mnt/luna-data (not mktemp under /tmp). Missing hash = failed install.
_datap="$(partition_data "$TARGET")"
# Distinct name: sourced factory-assets used to assign _mnt and clobber this
# path, so cp wrote os-image.sha256 into a deleted /tmp/tmp.* (LUNAASSETS).
_data_mnt=/mnt/luna-data
mkdir -p "$_data_mnt"
if ! mount -o rw "$_datap" "$_data_mnt"; then
	echo
	echo "Install wrote the slots, but the data partition could not be mounted."
	echo "The OS image checksum is missing. This install did not finish."
	exit 1
fi
if ! factory_apply_device_token "$_data_mnt" "$HERE"; then
	umount "$_data_mnt" 2>/dev/null || true
	echo
	echo "Install wrote the disk, but the official setup code step failed."
	echo "Fix the TOKENS magazine on LUNAASSETS (or use device-token), then re-run."
	exit 1
fi
if [ ! -f "$_data_mnt/os-image.sha256" ]; then
	_hash="${_os_hash:-}"
	if [ -z "$_hash" ]; then
		_hash="$(_resolve_os_image_hash "" "${_slot_img:-}")" || _hash=""
	fi
	if [ -z "$_hash" ] || ! _record_os_image_hash "$_data_mnt" "$_hash"; then
		umount "$_data_mnt" 2>/dev/null || true
		echo
		echo "Could not write the OS image checksum (os-image.sha256)."
		echo "Without it, Luna cannot apply OS updates. This install did not finish."
		exit 1
	fi
fi
umount "$_data_mnt" 2>/dev/null || true

echo "Remove the USB stick if you used one."
echo "Luna will reboot and show its address on the screen. Stay on home internet on your phone."
echo

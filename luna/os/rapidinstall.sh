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

ARCH="${ARCH:-x86_64}"
TARBALL="${LUNA_ROOTFS:-$HERE/luna-rootfs-$ARCH.tar.gz}"

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

# One byte from stdin (the console). Dash-safe — no bash read -n/-t.
# The live ISO attaches /dev/tty1 as stdin; PID 1 often has no /dev/tty.
# Caller must put the console in cbreak (-icanon) first, or Enter is required.
read_console_byte() {
	dd bs=1 count=1 2>/dev/null
}

console_cbreak() {
	# Deliver each key immediately — default cooked mode waits for Enter.
	stty -icanon min 1 time 0 -echo 2>/dev/null || true
}

console_sane() {
	stty sane 2>/dev/null || true
}

drain_stdin() {
	# Discard buffered keys without blocking long (dash-safe; needs cbreak).
	while :; do
		_k="$(timeout 0.05 dd bs=1 count=1 2>/dev/null)" || break
		[ -n "$_k" ] || break
	done
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
	echo "Do nothing for 5 seconds to continue. Press any key to pick another disk."
	_picked_other=0
	# Dash has no read -n/-t. timeout+dd reads one byte from the console
	# (stdin is /dev/tty1 on the live ISO). Exit 0 = key pressed; 124 = timed out.
	# stty -icanon is required so a key is delivered without waiting for Enter.
	if [ -t 0 ] && command -v timeout >/dev/null 2>&1; then
		console_cbreak
		if timeout 5 dd bs=1 count=1 of=/dev/null 2>/dev/null; then
			_picked_other=1
		fi
		console_sane
	fi
	if [ "$_picked_other" -eq 1 ]; then
		echo
		drain_stdin
		TARGET=""
		prompt_target
	else
		echo
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
if ! flash_luna_disk "$TARGET" "$TARBALL"; then
	echo
	echo "Install failed. The disk may be half-written — do not reboot into it yet."
	echo "Fix the error above, or re-run from the USB stick."
	exit 1
fi
echo
echo "Installation complete. Remove the USB stick if you used one."
echo "Luna will reboot and show how to connect on the screen and in your browser."
echo

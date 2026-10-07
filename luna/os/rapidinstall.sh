#!/bin/sh
# Rapidinstall: run from the live ISO. Picks the smallest non-USB disk
# (built-in eMMC, SATA, or NVMe). USB sticks, including the one this
# image booted from, are never chosen automatically — and when the
# install media can't be identified at all, it refuses to pick.

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
# The slot image the ISO carries: the exact bytes the update feed lists.
OS_IMAGE="${LUNA_OS_IMAGE:-$HERE/luna-os-$ARCH.img.xz}"

# QEMU / automation: allow overrides from the kernel command line.
if [ -z "${LUNA_TARGET:-}" ] && [ -r /proc/cmdline ]; then
	for _tok in $(cat /proc/cmdline); do
		case "$_tok" in
		LUNA_TARGET=*) LUNA_TARGET="${_tok#LUNA_TARGET=}" ;;
		LUNA_INSTALL_MEDIA=*) LUNA_INSTALL_MEDIA="${_tok#LUNA_INSTALL_MEDIA=}" ;;
		LUNA_OVERRIDE_WAIT=*) LUNA_OVERRIDE_WAIT="${_tok#LUNA_OVERRIDE_WAIT=}" ;;
		LUNA_CONFIRM=*) LUNA_CONFIRM="${_tok#LUNA_CONFIRM=}" ;;
		LUNA_OS_IMAGE=*) LUNA_OS_IMAGE="${_tok#LUNA_OS_IMAGE=}"; OS_IMAGE="$LUNA_OS_IMAGE" ;;
		esac
	done
	export LUNA_TARGET LUNA_INSTALL_MEDIA LUNA_OVERRIDE_WAIT LUNA_CONFIRM LUNA_OS_IMAGE
fi

_media_known=0

discover_install_disk() {
	_src="${LUNA_INSTALL_MEDIA:-}"
	_mounts="${LUNA_PROC_MOUNTS:-/proc/mounts}"
	if [ -z "$_src" ] && [ -f "$_mounts" ]; then
		# The device holding the live medium — /run/live/medium on newer
		# live-boot, /lib/live/mount/medium on older; /src is the QEMU
		# staging convention. Field 1 is the device node.
		_src="$(awk '$2=="/src" || $2=="/run/live/medium" || $2=="/lib/live/mount/medium" { print $1; exit }' "$_mounts" || true)"
	fi
	if [ -z "$_src" ]; then
		echo "Luna could not identify the install media." >&2
		return 0
	fi
	_media_known=1
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

if [ ! -f "$OS_IMAGE" ]; then
	echo "Luna's system file is missing from this USB stick. Write a fresh Luna installer to the stick." >&2
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
elif [ "$_media_known" -eq 0 ]; then
	# When the install media is unidentified the smallest-disk guess could
	# pick the installer itself. Never auto-pick in that state: require an
	# explicit LUNA_TARGET (or LUNA_INSTALL_MEDIA so it can be ruled out),
	# otherwise stop.
	echo "Because Luna can't tell which disk is the installer, it will not" >&2
	echo "choose a disk on its own — choosing wrong would erase it." >&2
	print_disks
	echo "To install anyway, reboot with LUNA_TARGET=/dev/<disk> on the kernel" >&2
	echo "command line, or name the installer media with LUNA_INSTALL_MEDIA=/dev/<disk>." >&2
	exit 2
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

confirm_install "$TARGET"

echo "Erasing $TARGET and installing Luna."
if ! flash_luna_disk "$TARGET" "$OS_IMAGE"; then
	echo
	echo "Install failed. The disk may be half-written — do not reboot into it yet."
	echo "Fix the error above, or re-run from the USB stick."
	exit 1
fi
echo
echo "Installation complete."

# Official device token + OS hash live on LUNA_DATA, not on an OS slot.
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
	echo "Install wrote the disk, but the official device token step failed."
	echo "Fix the TOKENS magazine on LUNAASSETS (or use device-token), then re-run."
	exit 1
fi
# os-image.sha256 = sha256 of the exact luna-os-*.img.xz written to both slots
# (flash_luna_disk sets _os_hash). Missing hash = failed install.
if [ -z "${_os_hash:-}" ] || ! _record_os_image_hash "$_data_mnt" "$_os_hash"; then
	umount "$_data_mnt" 2>/dev/null || true
	echo
	echo "Could not write the OS image checksum (os-image.sha256)."
	echo "Without it, Luna cannot apply OS updates. This install did not finish."
	exit 1
fi

# EuroOffice pack: browser-side office editor assets on LUNA_DATA (~1 GB
# extracted). Missing/corrupt pack is a loud warning, not a failed install —
# everything else works and the pack can be added later.
_eopack=""
for _cand in "$HERE/eurooffice-pack.tar.zst" "$HERE/../eurooffice-pack.tar.zst"; do
	if [ -f "$_cand" ]; then
		_eopack="$_cand"
		break
	fi
done
if [ -z "$_eopack" ]; then
	echo
	echo "NOTE: no office editor pack on this media — office editing will be"
	echo "unavailable until the pack is installed into /var/lib/luna/eurooffice."
elif ! command -v zstd >/dev/null 2>&1; then
	echo
	echo "WARNING: zstd is missing in the installer — office pack skipped." >&2
elif [ ! -f "$_eopack.sha256" ] || \
	! (cd "$(dirname "$_eopack")" && sha256sum -c "$(basename "$_eopack").sha256" >/dev/null 2>&1); then
	echo
	echo "WARNING: office pack checksum missing or failed — skipping it." >&2
else
	echo
	echo "Installing the office editor pack (about a gigabyte, one-time)…"
	if zstd -dc "$_eopack" | tar -x -C "$_data_mnt" && [ -f "$_data_mnt/eurooffice/web-apps/apps/api/documents/api.js" ]; then
		echo "Office pack installed."
	else
		rm -rf "$_data_mnt/eurooffice"
		echo "WARNING: office pack did not extract cleanly — removed the partial copy." >&2
	fi
fi

# draw.io pack: the self-hosted diagram editor webapp (~150 MB extracted).
# Same deal — a missing/corrupt pack warns but doesn't fail the install.
_diopack=""
for _cand in "$HERE/drawio-pack.tar.zst" "$HERE/../drawio-pack.tar.zst"; do
	if [ -f "$_cand" ]; then
		_diopack="$_cand"
		break
	fi
done
if [ -z "$_diopack" ]; then
	echo
	echo "NOTE: no diagram editor pack on this media — diagram editing will be"
	echo "unavailable until the pack is installed into /var/lib/luna/drawio."
elif ! command -v zstd >/dev/null 2>&1; then
	echo
	echo "WARNING: zstd is missing in the installer — diagram pack skipped." >&2
elif [ ! -f "$_diopack.sha256" ] || \
	! (cd "$(dirname "$_diopack")" && sha256sum -c "$(basename "$_diopack").sha256" >/dev/null 2>&1); then
	echo
	echo "WARNING: diagram pack checksum missing or failed — skipping it." >&2
else
	echo
	echo "Installing the diagram editor pack…"
	if zstd -dc "$_diopack" | tar -x -C "$_data_mnt" && [ -f "$_data_mnt/drawio/index.html" ]; then
		echo "Diagram pack installed."
	else
		rm -rf "$_data_mnt/drawio"
		echo "WARNING: diagram pack did not extract cleanly — removed the partial copy." >&2
	fi
fi
umount "$_data_mnt" 2>/dev/null || true

echo "Remove the USB stick if you used one."
echo "Luna will reboot and show its address on the screen. Open it from a phone or computer on the same network."
echo

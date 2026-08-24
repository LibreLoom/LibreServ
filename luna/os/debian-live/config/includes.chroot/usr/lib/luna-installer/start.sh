#!/bin/sh
# Attach rapidinstall to the live ISO medium and run it on the physical console.
set -eu

_wait_medium() {
	_i=0
	while [ "$_i" -lt 120 ]; do
		if [ -f /run/live/medium/luna/rapidinstall.sh ]; then
			return 0
		fi
		if [ -f /lib/live/mount/medium/luna/rapidinstall.sh ]; then
			return 0
		fi
		_i=$((_i + 1))
		sleep 1
	done
	return 1
}

_install_dir() {
	if [ -f /run/live/medium/luna/rapidinstall.sh ]; then
		printf '/run/live/medium/luna\n'
		return 0
	fi
	if [ -f /lib/live/mount/medium/luna/rapidinstall.sh ]; then
		printf '/lib/live/mount/medium/luna\n'
		return 0
	fi
	return 1
}

_install_media_dev() {
	if command -v live-resolve >/dev/null 2>&1; then
		_dev="$(live-resolve --device 2>/dev/null || true)"
		if [ -n "$_dev" ] && [ -b "$_dev" ]; then
			printf '%s\n' "$_dev"
			return 0
		fi
	fi
	if [ -f /usr/lib/luna-installer/find-media.sh ]; then
		# shellcheck disable=SC1091
		. /usr/lib/luna-installer/find-media.sh
		_mnt="$(mktemp -d)"
		if _dev="$(luna_find_install_media "$_mnt")"; then
			umount "$_mnt" 2>/dev/null || true
			rmdir "$_mnt" 2>/dev/null || true
			printf '%s\n' "$_dev"
			return 0
		fi
		umount "$_mnt" 2>/dev/null || true
		rmdir "$_mnt" 2>/dev/null || true
	fi
	return 1
}

# Kernel console (console=tty0 → /dev/console), not tty1. Switching VTs hid
# the 5s disk-override prompt when chvt lagged or failed.
_attach_console() {
	_dev=""
	if [ -c /dev/console ]; then
		_dev=/dev/console
	elif [ -c /dev/tty0 ]; then
		_dev=/dev/tty0
	elif [ -c /dev/tty1 ]; then
		_dev=/dev/tty1
	fi
	[ -n "$_dev" ] || return 1
	exec <"$_dev" >"$_dev" 2>&1 || return 1
	if command -v stty >/dev/null 2>&1; then
		stty sane 2>/dev/null || true
	fi
	return 0
}

_attach_console || true

if ! _wait_medium; then
	echo "Could not find Luna installer files on the USB stick." >&2
	echo "Devices Luna can see:" >&2
	ls /sys/class/block 2>/dev/null || true
	exec /bin/sh
fi

DIR="$(_install_dir)"
export LUNA_ROOTFS="${LUNA_ROOTFS:-$DIR/luna-rootfs-x86_64.tar.gz}"
if DEV="$(_install_media_dev)"; then
	export LUNA_INSTALL_MEDIA="$DEV"
fi

mkdir -p /var/lib/live/config
touch /var/lib/live/config/luna-installer

cd "$DIR"
./rapidinstall.sh
exit $?

#!/bin/sh
# PID 1 for the rapidinstall live ISO: bring up devices, then run the installer.
set -eu

export PATH="/usr/sbin:/usr/bin:/sbin:/bin${PATH:+:$PATH}"

mount -o remount,rw / 2>/dev/null || true

for _fs in proc sys dev; do
	case "$_fs" in
		proc) _type=proc; _dir=/proc ;;
		sys) _type=sysfs; _dir=/sys ;;
		dev) _type=devtmpfs; _dir=/dev ;;
	esac
	if [ ! -d "$_dir" ] || ! mountpoint -q "$_dir" 2>/dev/null; then
		mkdir -p "$_dir"
		mount -t "$_type" "$_fs" "$_dir" 2>/dev/null || true
	fi
done

if command -v systemd-udevd >/dev/null 2>&1; then
	systemd-udevd --daemon 2>/dev/null || true
	udevadm trigger --type=devices 2>/dev/null || true
	udevadm settle 2>/dev/null || true
fi

# Optional keyboard layout for the installer's text screen: luna.keymap=colemak
# (Debian ships no Colemak console map, so it is written out here: only the
# keys that differ from QWERTY, with Ctrl combinations kept working.)
_colemak() {
	for _m in 18:f 19:p 20:g 21:j 22:l 23:u 24:y 25:semicolon 31:r 32:s 33:t 34:d 36:n 37:e 38:i 39:o 49:k; do
		_k="${_m%%:*}"
		_c="${_m#*:}"
		printf 'keycode %s = %s\n' "$_k" "$_c"
		case "$_c" in
			[a-z]) printf 'control keycode %s = Control_%s\n' "$_k" "$_c" ;;
		esac
	done
	printf 'keycode 58 = BackSpace\n'
}
for _w in $(cat /proc/cmdline 2>/dev/null); do
	case "$_w" in
		luna.keymap=colemak) _colemak | loadkeys - 2>/dev/null || echo "keyboard layout colemak could not be loaded" ;;
		luna.keymap=*) loadkeys "${_w#luna.keymap=}" 2>/dev/null || echo "keyboard layout ${_w#luna.keymap=} not found" ;;
	esac
done

if [ -x /usr/lib/luna-installer/network-up.sh ]; then
	/usr/lib/luna-installer/network-up.sh &
fi

if [ -c /dev/console ]; then
	exec </dev/console >/dev/console 2>&1 || true
elif [ -c /dev/tty0 ]; then
	exec </dev/tty0 >/dev/tty0 2>&1 || true
fi

if /usr/lib/luna-installer/start.sh; then
	sync
	echo "Rebooting into Luna…"
	exec /sbin/reboot -f
fi

echo
echo "Luna rapidinstall did not finish. Dropping to a shell so you can see the error."
echo "When ready: remove the USB stick is NOT required yet; type 'reboot -f' to try again."
exec /bin/sh

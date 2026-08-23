#!/bin/sh
# PID 1 for the rapidinstall live ISO: bring up devices, then run the installer.
set -eu

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

if [ -x /usr/lib/luna-installer/network-up.sh ]; then
	/usr/lib/luna-installer/network-up.sh &
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

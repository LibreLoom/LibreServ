#!/bin/sh
# Guardrails for live-ISO keyboard bring-up (no hardware required).
set -eu
HERE="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
fail=0

assert_file_has() {
	_file="$1"
	_pat="$2"
	_msg="$3"
	if ! grep -q "$_pat" "$_file"; then
		echo "FAIL $_msg" >&2
		fail=$((fail + 1))
	fi
}

assert_file_lacks() {
	_file="$1"
	_pat="$2"
	_msg="$3"
	if grep -q "$_pat" "$_file"; then
		echo "FAIL $_msg" >&2
		fail=$((fail + 1))
	fi
}

assert_file_has "$HERE/init" 'setsid -c' "init must take the console with setsid -c (Alpine busybox has no cttyhack)"
assert_file_has "$HERE/init" '/bin/kmod' "init must load modules with kmod, not BusyBox modprobe"
assert_file_has "$HERE/init" 'usbhid' "init must load usbhid"
assert_file_has "$HERE/init" 'hid-logitech-dj' "init must load Logitech unifying HID (common mini-PC wireless keyboards)"
assert_file_lacks "$HERE/init" 'busybox --install' "init must not run busybox --install (it overwrites kmod)"
assert_file_has "$HERE/build-live.sh" 'kernel/drivers/hid' "initramfs must copy HID drivers"
assert_file_has "$HERE/build-live.sh" 'kernel/drivers/pwm' "initramfs must copy pwm-lpss (Cherry Trail / mini-PC USB)"
assert_file_has "$HERE/build-live.sh" 'modprobe | insmod | rmmod | depmod | lsmod | modinfo' "build-live must not symlink BusyBox over kmod"

if [ "$fail" -ne 0 ]; then
	echo "$fail failed" >&2
	exit 1
fi
echo "os/iso/init_test.sh ok"

#!/bin/sh
# Static checks for Luna OS rootfs wiring (no podman build required).
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="$ROOT/os/build-rootfs.sh"

assert_file_has() {
	file="$1"
	needle="$2"
	msg="$3"
	grep -q "$needle" "$file" || {
		echo "FAIL: $msg (missing '$needle' in $file)" >&2
		exit 1
	}
}

assert_file_has "$BUILD" 'luna-network-up' "rootfs must ship wired bring-up script"
assert_file_has "$BUILD" 'etc/init.d/luna-network' "rootfs must ship luna-network OpenRC service"
assert_file_has "$BUILD" '/etc/network/interfaces' "rootfs must ship a minimal interfaces file"
# Ethernet-only: rootfs must not ship wpa_supplicant / setup-AP leftovers.
if grep -E 'wpa_supplicant|dnsmasq' "$BUILD" >/dev/null 2>&1; then
	echo "FAIL: Luna OS is Ethernet-only; do not package wpa_supplicant or dnsmasq" >&2
	exit 1
fi
assert_file_has "$BUILD" 'for svc in hwclock modules sysctl hostname bootmisc syslog luna-input luna-network;' \
	"boot runlevel must start luna-input before luna-network"
assert_file_has "$BUILD" 'for svc in devfs dmesg mdev hwdrivers;' \
	"sysinit must enable Alpine hwdrivers coldplug (USB HID at boot)"
assert_file_has "$BUILD" 'modules-load.d/luna-input.conf' "rootfs must ship keyboard module list"
assert_file_has "$BUILD" 'luna-input-up' "rootfs must ship keyboard / HID bring-up script"
assert_file_has "$BUILD" 'usbhid' "rootfs must load usbhid for USB keyboards"
assert_file_has "$BUILD" 'hid-generic' "rootfs must load hid-generic"
assert_file_has "$BUILD" 'evdev' "rootfs must load evdev for /dev/input/event*"
assert_file_has "$BUILD" 'atkbd' "rootfs must load atkbd for PS/2 keyboards"
assert_file_has "$BUILD" ' alpine-base openrc linux-lts kmod ' \
	"rootfs must install kmod so gzipped .ko.gz modules load"
assert_file_has "$BUILD" 'linux-firmware-none' \
	"rootfs must use linux-firmware-none instead of the full firmware meta package"
assert_file_has "$BUILD" 'virtio_net' \
	"rootfs network bring-up must load virtio_net for QEMU / virt guests"

# Only flag an apk install of the meta package, not comments mentioning it.
if grep -E 'apk add' "$BUILD" | grep -qE '(^|[[:space:]])linux-firmware([[:space:]]|$)'; then
	echo "FAIL: do not install the linux-firmware meta package (hundreds of MB of unused blobs)" >&2
	exit 1
fi

if grep 'for svc in .*networking;' "$BUILD" >/dev/null 2>&1; then
	echo "FAIL: stock Alpine networking must not stay in boot runlevel" >&2
	exit 1
fi

if ! grep -q 'hwdrivers' "$BUILD"; then
	echo "FAIL: hwdrivers must be enabled so cold-plugged keyboards bind at boot" >&2
	exit 1
fi

echo "rootfs_test ok"

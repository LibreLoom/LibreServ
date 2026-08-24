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
assert_file_has "$BUILD" 'wpa_supplicant_dbus=no' "wpa_supplicant must not depend on dbus on Luna OS"
assert_file_has "$BUILD" 'for svc in hwclock modules sysctl hostname bootmisc syslog luna-network;' \
	"boot runlevel must use luna-network instead of stock networking"

if grep 'for svc in .*networking;' "$BUILD" >/dev/null 2>&1; then
	echo "FAIL: stock Alpine networking must not stay in boot runlevel" >&2
	exit 1
fi

echo "rootfs_test ok"

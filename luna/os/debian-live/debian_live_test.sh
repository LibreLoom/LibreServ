#!/bin/sh
# Guardrails for Debian live rapidinstall ISO (no hardware required).
set -eu
HERE="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
OSROOT="$(CDPATH= cd -- "$HERE/.." && pwd)"
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

assert_file_has "$OSROOT/make-iso.sh" 'sudo rm -rf' "make-iso must clean live-build workspace with sudo"
assert_file_has "$OSROOT/iso/build-debian-live.sh" 'set -euo pipefail' "build-debian-live must fail fast"
assert_file_has "$OSROOT/iso/wait-iso-build.sh" 'exit 1' "wait-iso-build must exit on failure"
assert_file_has "$OSROOT/debian-live/auto/config" 'bookworm' "Debian live must pin bookworm"
assert_file_has "$OSROOT/debian-live/auto/config" 'iso-hybrid' "Debian live must build hybrid ISO"
assert_file_has "$OSROOT/debian-live/auto/config" 'LUNAINST' "Debian live ISO volume must stay LUNAINST"
assert_file_has "$OSROOT/debian-live/auto/config" 'systemd.mask=getty@tty1.service' "kernel cmdline must mask tty1 getty"
assert_file_has "$OSROOT/debian-live/config/package-lists/luna.list.chroot" 'firmware-linux-nonfree' "Debian live must ship non-free firmware"
assert_file_has "$OSROOT/debian-live/config/package-lists/luna.list.chroot" 'grub-efi-amd64-bin' "Debian live must ship UEFI GRUB"
assert_file_has "$OSROOT/debian-live/config/includes.chroot/usr/lib/luna-installer/start.sh" 'rapidinstall.sh' "start.sh must exec rapidinstall"
assert_file_has "$OSROOT/debian-live/config/includes.chroot/usr/lib/luna-installer/start.sh" '/run/live/medium/luna' "start.sh must read installer from live medium"
assert_file_has "$OSROOT/debian-live/auto/config" 'net.ifnames=0' "kernel cmdline must expose eth0 for live-config"
assert_file_has "$OSROOT/debian-live/config/includes.chroot/etc/systemd/system/luna-installer.service" 'After=live-boot.service' "installer must run after live medium is mounted"
assert_file_lacks "$OSROOT/debian-live/config/includes.chroot/etc/systemd/system/luna-installer.service" 'live-config.service' "installer must not wait on live-config"
assert_file_has "$OSROOT/debian-live/config/hooks/0100-luna-installer.hook.chroot" 'mask getty.target' "hook must disable getty login target"
assert_file_has "$OSROOT/debian-live/config/includes.chroot/etc/systemd/system/luna-installer.service" 'start.sh' "installer unit must run start.sh"
assert_file_has "$OSROOT/debian-live/config/includes.chroot/usr/lib/live/config/9999-luna-installer" 'getty@tty1' "live-config fallback must keep getty off tty1"
assert_file_has "$OSROOT/debian-live/config/hooks/0100-luna-installer.hook.chroot" 'enable luna-installer.service' "hook must enable installer unit"
assert_file_has "$OSROOT/rapidinstall.sh" 'timeout 5' "rapidinstall must not use bash-only read -t"
assert_file_has "$OSROOT/iso/stage-debian-live.sh" 'includes.binary/luna' "stage script must place payload on ISO"

if [ "$fail" -ne 0 ]; then
	echo "$fail failed" >&2
	exit 1
fi
echo "os/debian-live/debian_live_test.sh ok"

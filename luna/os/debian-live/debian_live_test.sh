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
assert_file_has "$OSROOT/iso/add-uefi-boot.sh" 'isohybrid-gpt-basdat' "ISO build must remaster with UEFI GPT basdat"
assert_file_has "$OSROOT/iso/add-uefi-boot.sh" 'BOOTX64.EFI' "UEFI remaster must ship BOOTX64.EFI"
assert_file_has "$OSROOT/iso/add-uefi-boot.sh" 'search --no-floppy --set=root --file /live/vmlinuz' \
	"UEFI grub.cfg must search for /live/vmlinuz (ESP root has no live kernel)"
assert_file_has "$OSROOT/iso/add-uefi-boot.sh" 'LUNAASSETS' "UEFI remaster must append LUNAASSETS factory FAT"
assert_file_has "$OSROOT/iso/add-uefi-boot.sh" 'append_partition' "UEFI remaster must append factory partition via xorriso"
assert_file_has "$OSROOT/iso/build-debian-live.sh" 'add-uefi-boot.sh' "build-debian-live must run UEFI remaster"
assert_file_has "$OSROOT/iso/build-debian-live.sh" 'grub-efi-amd64-bin' "host build must install grub-efi for remaster"
assert_file_has "$OSROOT/debian-live/auto/config" 'LUNAINST' "Debian live ISO volume must stay LUNAINST"
assert_file_has "$OSROOT/debian-live/auto/config" 'init=/usr/lib/luna-installer/init.sh' "kernel cmdline must use custom init"
assert_file_has "$OSROOT/debian-live/config/package-lists/luna.list.chroot" 'firmware-linux-nonfree' "Debian live must ship non-free firmware"
assert_file_has "$OSROOT/debian-live/config/package-lists/luna.list.chroot" 'grub-efi-amd64-bin' "Debian live must ship UEFI GRUB"
assert_file_has "$OSROOT/debian-live/config/includes.chroot/usr/lib/luna-installer/init.sh" 'start.sh' "custom init must exec installer"
assert_file_has "$OSROOT/debian-live/config/includes.chroot/usr/lib/luna-installer/init.sh" 'Dropping to a shell' "failed install must not force reboot into half-written disk"
assert_file_has "$OSROOT/lib/flash-disk.sh" '[ -f "$_d/ext2.mod" ]' "GRUB module probe must require ext2.mod"
assert_file_lacks "$OSROOT/lib/flash-disk.sh" "echo '    insmod ext4'" "installed grub.cfg must not insmod missing ext4"
assert_file_has "$OSROOT/debian-live/config/includes.chroot/usr/lib/luna-installer/start.sh" 'rapidinstall.sh' "start.sh must exec rapidinstall"
assert_file_has "$OSROOT/debian-live/config/includes.chroot/usr/lib/luna-installer/start.sh" '/run/live/medium/luna' "start.sh must read installer from live medium"
assert_file_has "$OSROOT/debian-live/config/includes.chroot/usr/lib/luna-installer/start.sh" '/dev/console' "start.sh must attach the kernel console"
assert_file_lacks "$OSROOT/debian-live/config/includes.chroot/usr/lib/luna-installer/start.sh" 'chvt 1' "start.sh must not chvt away from the kernel console"
assert_file_has "$OSROOT/debian-live/config/hooks/0100-luna-installer.hook.chroot" 'mask getty.target' "hook must disable getty login target"
assert_file_lacks "$OSROOT/debian-live/config/includes.chroot/etc/systemd/system/luna-installer.service" 'rapidinstall' "systemd installer unit must not ship with init= path"
assert_file_has "$OSROOT/debian-live/config/includes.chroot/usr/lib/luna-installer/init.sh" 'network-up.sh' "custom init must start DHCP"
assert_file_has "$OSROOT/debian-live/config/includes.chroot/usr/lib/luna-installer/init.sh" '/dev/console' "custom init must attach the kernel console"
assert_file_has "$OSROOT/debian-live/config/includes.chroot/usr/lib/luna-installer/network-up.sh" 'dhclient' "network-up must try DHCP"
assert_file_has "$OSROOT/debian-live/config/package-lists/luna.list.chroot" 'isc-dhcp-client' "live ISO must ship DHCP client"
assert_file_has "$OSROOT/debian-live/config/package-lists/luna.list.chroot" 'coreutils' "live ISO must ship GNU timeout (coreutils)"
assert_file_lacks "$OSROOT/rapidinstall.sh" 'show_access_instructions' "rapidinstall must not print connection help"
assert_file_has "$OSROOT/rapidinstall.sh" 'wait_override_key' "rapidinstall must wait for a disk override key"
assert_file_has "$OSROOT/lib/console.sh" 'Press any key to pick another disk' "console wait must offer a 5s disk override"
assert_file_has "$OSROOT/lib/console.sh" 'timeout --foreground' "disk override must use GNU timeout --foreground"
assert_file_has "$OSROOT/rapidinstall.sh" 'lib/console.sh' "rapidinstall must source console helpers"
assert_file_has "$OSROOT/rapidinstall.sh" 'lib/factory-assets.sh' "rapidinstall must source factory assets helpers"
assert_file_has "$OSROOT/rapidinstall.sh" 'factory_apply_setup_token' "rapidinstall must peel TOKENS / apply setup token"
assert_file_has "$OSROOT/lib/factory-assets.sh" 'LUNAASSETS' "factory assets helper must look for LUNAASSETS"
assert_file_has "$OSROOT/lib/factory-assets.sh" 'TOKENS' "factory assets helper must peel TOKENS magazine"
assert_file_has "$OSROOT/iso/stage-debian-live.sh" 'lib/console.sh' "stage script must copy console helpers onto the ISO"
assert_file_has "$OSROOT/iso/stage-debian-live.sh" 'lib/factory-assets.sh' "stage script must copy factory assets helpers onto the ISO"
assert_file_has "$OSROOT/lib/console.sh" 'stty -icanon' "rapidinstall must enable cbreak for single-key override"
assert_file_lacks "$OSROOT/rapidinstall.sh" 'read -r -n' "rapidinstall must not use bash-only read -n"
assert_file_lacks "$OSROOT/rapidinstall.sh" 'read -r -t' "rapidinstall must not use bash-only read -t"
assert_file_lacks "$OSROOT/lib/console.sh" 'chvt 1' "console helper must not chvt away from the kernel console"
assert_file_has "$OSROOT/../crates/lunad/src/console.rs" 'help_text' "installed Luna must print connection help on console every boot"
assert_file_has "$OSROOT/lib/flash-disk.sh" 'search_fs_uuid' "installed GRUB must search root by UUID"
assert_file_has "$OSROOT/lib/flash-disk.sh" 'EFI/BOOT/grub/grub.cfg' "UEFI GRUB must chain from ESP"
assert_file_has "$OSROOT/iso/stage-debian-live.sh" 'includes.binary/luna' "stage script must place payload on ISO"

if [ "$fail" -ne 0 ]; then
	echo "$fail failed" >&2
	exit 1
fi
echo "os/debian-live/debian_live_test.sh ok"

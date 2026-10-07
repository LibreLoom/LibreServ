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
assert_file_has "$OSROOT/debian-live/config/includes.chroot/usr/lib/luna-installer/init.sh" 'network-up.sh' "custom init must start DHCP"
assert_file_has "$OSROOT/debian-live/config/includes.chroot/usr/lib/luna-installer/init.sh" '/dev/console' "custom init must attach the kernel console"
assert_file_has "$OSROOT/debian-live/config/includes.chroot/usr/lib/luna-installer/network-up.sh" 'dhclient' "network-up must try DHCP"
assert_file_has "$OSROOT/debian-live/config/includes.chroot/usr/lib/luna-installer/network-up.sh" 'ip link set lo up' "network-up must bring up loopback interface"
assert_file_has "$OSROOT/debian-live/config/package-lists/luna.list.chroot" 'isc-dhcp-client' "live ISO must ship DHCP client"
assert_file_has "$OSROOT/debian-live/config/package-lists/luna.list.chroot" 'coreutils' "live ISO must ship GNU timeout (coreutils)"
assert_file_lacks "$OSROOT/rapidinstall.sh" 'show_access_instructions' "rapidinstall must not print connection help"
assert_file_has "$OSROOT/rapidinstall.sh" 'wait_override_key' "rapidinstall must wait for a disk override key"
assert_file_has "$OSROOT/rapidinstall.sh" 'confirm_install' "rapidinstall must require typing INSTALL before erase"
assert_file_has "$OSROOT/lib/console.sh" 'Type INSTALL' "console helper must ask for INSTALL confirmation"
assert_file_has "$OSROOT/lib/console.sh" 'poweroff' "wrong confirm must shut down"
assert_file_has "$OSROOT/lib/console.sh" 'LUNA_CONFIRM' "confirm helper must honor LUNA_CONFIRM=INSTALL for automation"
assert_file_has "$OSROOT/debian-live/config/includes.chroot/usr/lib/luna-installer/start.sh" 'LUNA_CONFIRM' "start.sh must pass LUNA_CONFIRM from cmdline"
assert_file_has "$OSROOT/lib/console.sh" 'Press any key to pick another disk' "console wait must offer a 5s disk override"
assert_file_has "$OSROOT/lib/console.sh" 'timeout --foreground' "disk override must use GNU timeout --foreground"
assert_file_has "$OSROOT/rapidinstall.sh" 'lib/console.sh' "rapidinstall must source console helpers"
assert_file_has "$OSROOT/rapidinstall.sh" 'lib/factory-assets.sh' "rapidinstall must source factory assets helpers"
assert_file_has "$OSROOT/rapidinstall.sh" 'factory_apply_device_token' "rapidinstall must peel TOKENS / apply device token"
assert_file_has "$OSROOT/rapidinstall.sh" '_record_os_image_hash' "rapidinstall must stamp os-image.sha256 without cp"
assert_file_has "$OSROOT/rapidinstall.sh" '_data_mnt' "data mount var must not be _mnt (factory-assets clobber)"
assert_file_has "$OSROOT/lib/factory-assets.sh" '_fa_mnt' "factory-assets must use _fa_mnt not _mnt"
assert_file_has "$OSROOT/rapidinstall.sh" 'This install did not finish' "missing os-image.sha256 must fail the install"
assert_file_lacks "$OSROOT/rapidinstall.sh" 'cp "${_slot_img}.sha256"' "os-image.sha256 must not be a raw cp (set -e abort)"
assert_file_has "$OSROOT/lib/flash-disk.sh" '_record_os_image_hash' "flash helper must write hex-only os-image.sha256"
assert_file_has "$OSROOT/lib/flash-disk.sh" 'search --no-floppy --file --set=root /grub/grub.cfg' "installed UEFI stub must search for /grub/grub.cfg"
assert_file_has "$OSROOT/lib/flash-disk.sh" 'grub-mkimage' "flash must embed BOOTX64.EFI with prefix /grub"
assert_file_has "$OSROOT/lib/flash-disk.sh" '_write_efi_grub_cfg "$_espmnt"' "EFI grub.cfg must be rewritten after grub-install"
assert_file_has "$OSROOT/lib/factory-assets.sh" 'LUNAASSETS' "factory assets helper must look for LUNAASSETS"
assert_file_has "$OSROOT/lib/factory-assets.sh" 'TOKENS' "factory assets helper must peel TOKENS magazine"
assert_file_has "$OSROOT/lib/console.sh" 'stty -icanon' "rapidinstall must enable cbreak for single-key override"
assert_file_lacks "$OSROOT/rapidinstall.sh" 'read -r -n' "rapidinstall must not use bash-only read -n"
assert_file_lacks "$OSROOT/rapidinstall.sh" 'read -r -t' "rapidinstall must not use bash-only read -t"
assert_file_lacks "$OSROOT/lib/console.sh" 'chvt 1' "console helper must not chvt away from the kernel console"
grep -rq 'help_text' "$OSROOT/../crates/lunad/src/" \
	|| { echo "FAIL installed Luna must print connection help on console every boot" >&2; fail=$((fail + 1)); }
assert_file_has "$OSROOT/lib/flash-disk.sh" 'search_fs_uuid' "installed GRUB must search root by UUID"
assert_file_has "$OSROOT/lib/flash-disk.sh" 'EFI/BOOT/grub/grub.cfg' "UEFI GRUB must chain from ESP"

ISO_SH="$OSROOT/build/iso.sh"
LIVE_SH="$OSROOT/build/live.sh"
assert_file_has "$LIVE_SH" 'mmdebstrap' "ISO build must use mmdebstrap (rootless, no live-build)"
assert_file_has "$LIVE_SH" 'SUITE="${SUITE:-bookworm}"' "Debian live must pin bookworm"
assert_file_has "$LIVE_SH" 'main contrib non-free non-free-firmware' "Debian live must enable non-free firmware"
assert_file_has "$LIVE_SH" 'mksquashfs' "live system must be packed with mksquashfs"
assert_file_has "$LIVE_SH" 'filesystem.squashfs' "live-boot looks for live/filesystem.squashfs"
assert_file_has "$ISO_SH" 'grub-mkrescue' "ISO must be a BIOS+UEFI hybrid made by grub-mkrescue"
assert_file_has "$ISO_SH" 'VOLID=LUNAINST' "ISO volume must stay LUNAINST"
assert_file_has "$ISO_SH" 'init=/usr/lib/luna-installer/init.sh' "kernel cmdline must use custom init"
assert_file_has "$ISO_SH" "boot=live text nomodeset console=tty0 net.ifnames=0 biosdevname=0" "kernel cmdline contract changed"
assert_file_has "$ISO_SH" 'search --no-floppy --set=root --file /live/vmlinuz' \
	"grub.cfg must search for /live/vmlinuz (the UEFI ESP root has no live kernel)"
assert_file_has "$ISO_SH" 'LUNAASSETS' "ISO must carry the writable LUNAASSETS factory FAT"
assert_file_has "$ISO_SH" 'append_partition 3' "LUNAASSETS must be appended as partition 3"
assert_file_has "$ISO_SH" 'console.sh' "ISO build must copy console helpers onto the ISO"
assert_file_has "$ISO_SH" 'factory-assets.sh' "ISO build must copy factory assets helpers onto the ISO"
assert_file_has "$ISO_SH" 'eurooffice-pack.tar.zst' "ISO must carry the EuroOffice pack"
assert_file_has "$ISO_SH" 'drawio-pack.tar.zst' "ISO must carry the draw.io pack"
assert_file_has "$ISO_SH" 'map %s /luna/%s' "ISO build must map the payload to /luna"
assert_file_has "$ISO_SH" 'img.xz' "ISO must carry the released .img.xz"
assert_file_lacks "$LIVE_SH" '^[^#]*(podman|sudo|--privileged)' "live build must stay rootless"
assert_file_has "$LIVE_SH" 'scripts/live' "live build must check live-boot is in the initramfs"
assert_file_has "$OSROOT/build/iso-customize.sh" 'update-initramfs' "live initramfs must be rebuilt with live-boot inside"
assert_file_lacks "$ISO_SH" '^[^#]*(podman|sudo|--privileged|live-build|lb build)' "ISO build must stay rootless and live-build free"
assert_file_lacks "$OSROOT/make-iso.sh" 'sudo|--privileged' "make-iso must stay rootless"
for _gone in iso/add-uefi-boot.sh iso/build-debian-live.sh iso/Containerfile.live-build iso/stage-debian-live.sh \
	debian-live/config/package-lists/luna.list.binary debian-live/config/hooks/0110-isolinux-paths.hook.chroot; do
	[ ! -e "$OSROOT/$_gone" ] || { echo "FAIL $_gone belonged to live-build and must stay deleted" >&2; fail=$((fail + 1)); }
done
assert_file_lacks "$OSROOT/rapidinstall.sh" 'LUNA_ROOTFS|luna-rootfs' "the rootfs tarball install path is gone"
assert_file_lacks "$OSROOT/lib/flash-disk.sh" 'tar -x|_populate_slot' "the tarball install path is gone"
assert_file_has "$OSROOT/lib/flash-disk.sh" 'xz -dc' "installer must stream the .img.xz onto both slots"
assert_file_has "$OSROOT/lib/flash-disk.sh" '_verify_os_image' "installer must check the .img.xz against its .sha256 before erasing"
assert_file_has "$OSROOT/lib/flash-disk.sh" 'i386-pc --boot-directory="$_espmnt" "$_dev"' \
	"BIOS GRUB must use the ESP root as boot-directory so it finds ESP/grub/grub.cfg"
assert_file_lacks "$OSROOT/lib/flash-disk.sh" 'boot-directory="$_espmnt/grub"' \
	"boot-directory=ESP/grub nests GRUB under grub/grub and BIOS boots stop at a grub> prompt"

if [ "$fail" -ne 0 ]; then
	echo "$fail failed" >&2
	exit 1
fi
echo "os/debian-live/debian_live_test.sh ok"

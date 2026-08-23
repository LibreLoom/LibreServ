#!/bin/sh
# Unit tests for GRUB config fragments in os/lib/flash-disk.sh
set -eu
HERE="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
. "$HERE/flash-disk.sh"

fail=0
_tmp="$(mktemp -d)"
trap 'rm -rf "$_tmp"' EXIT INT

assert_has() {
	_file="$1"
	_pat="$2"
	_msg="$3"
	if ! grep -q "$_pat" "$_file"; then
		echo "FAIL $_msg: missing '$_pat' in $_file" >&2
		fail=$((fail + 1))
	fi
}

mkdir -p "$_tmp/boot"
printf 'kernel\n' >"$_tmp/boot/vmlinuz-lts"
printf 'initrd\n' >"$_tmp/boot/initramfs-lts"

_write_grub_cfg "$_tmp" '11111111-2222-3333-4444-555555555555' vmlinuz-lts initramfs-lts
assert_has "$_tmp/boot/grub/grub.cfg" 'menuentry "Luna"' "root grub.cfg needs Luna menuentry"
assert_has "$_tmp/boot/grub/grub.cfg" 'search_fs_uuid' "root grub.cfg must search by UUID"
assert_has "$_tmp/boot/grub/grub.cfg" 'root=UUID=11111111-2222-3333-4444-555555555555' "root grub.cfg must pass root UUID"

_esptmp="$(mktemp -d)"
_write_efi_grub_cfg "$_esptmp" '11111111-2222-3333-4444-555555555555'
assert_has "$_esptmp/EFI/BOOT/grub/grub.cfg" 'configfile $prefix/grub.cfg' "ESP grub.cfg must chain to root"
assert_has "$_esptmp/EFI/BOOT/grub/grub.cfg" '11111111-2222-3333-4444-555555555555' "ESP grub.cfg must search root UUID"

if [ -f /usr/lib/grub/x86_64-efi/ext4.mod ]; then
	_install_grub_modules "$_tmp" x86_64-efi
	assert_has "$_tmp/boot/grub/x86_64-efi/ext4.mod" '.*' "must copy ext4.mod for UEFI"
fi

if [ "$fail" -ne 0 ]; then
	echo "$fail failed" >&2
	exit 1
fi
echo "os/lib/flash-disk_test.sh ok"

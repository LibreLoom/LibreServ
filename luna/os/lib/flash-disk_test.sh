#!/bin/sh
# Unit tests for os/lib/flash-disk.sh — GRUB config fragments against fake
# root dirs, and the mounted-disk guard against a fake /proc/mounts.
set -eu
HERE="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
. "$HERE/disk.sh"
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

assert_true() {
	if ! "$@"; then
		echo "FAIL expected true: $*" >&2
		fail=$((fail + 1))
	fi
}

assert_false() {
	if "$@"; then
		echo "FAIL expected false: $*" >&2
		fail=$((fail + 1))
	fi
}

mkdir -p "$_tmp/boot"
printf 'kernel\n' >"$_tmp/boot/vmlinuz-lts"
printf 'initrd\n' >"$_tmp/boot/initramfs-lts"

mkdir -p "$_tmp/grub"
_write_grub_cfg "$_tmp/grub/grub.cfg" \
	'11111111-2222-3333-4444-555555555555' \
	'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' \
	vmlinuz-lts initramfs-lts
assert_has "$_tmp/grub/grub.cfg" 'menuentry "Luna"' "grub.cfg needs Luna menuentry"
assert_has "$_tmp/grub/grub.cfg" 'search_fs_uuid' "grub.cfg must search by UUID"
assert_has "$_tmp/grub/grub.cfg" 'root=UUID=11111111-2222-3333-4444-555555555555' "grub.cfg must pass slot A UUID"
assert_has "$_tmp/grub/grub.cfg" 'root=UUID=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' "grub.cfg must pass slot B UUID"
assert_has "$_tmp/grub/grub.cfg" 'rootflags=ro,noatime' "grub.cfg must mount OS slots read-only + noatime"
assert_has "$_tmp/grub/grub.cfg" 'luna_slot' "grub.cfg must implement A/B tryboot via luna_slot"
assert_has "$_tmp/grub/grub.cfg" 'luna_boot_ok' "grub.cfg must track luna_boot_ok for rollback"

_esptmp="$(mktemp -d)"
_write_efi_grub_cfg "$_esptmp"
assert_has "$_esptmp/EFI/BOOT/grub/grub.cfg" 'configfile $prefix/grub.cfg' "ESP grub.cfg must chain to shared grub"
assert_has "$_esptmp/EFI/BOOT/grub/grub.cfg" 'LUNAESP' "ESP grub.cfg must find the ESP by label"

if [ -f /usr/lib/grub/x86_64-efi/ext2.mod ]; then
	_install_grub_modules "$_tmp/grub" x86_64-efi
	[ -f "$_tmp/grub/x86_64-efi/ext2.mod" ] || {
		echo "FAIL must copy ext2.mod for UEFI" >&2
		fail=$((fail + 1))
	}
fi
assert_file_lacks() {
	_file="$1"
	_pat="$2"
	_msg="$3"
	if grep -q "$_pat" "$_file"; then
		echo "FAIL $_msg: unexpected '$_pat' in $_file" >&2
		fail=$((fail + 1))
	fi
}
assert_file_lacks "$_tmp/grub/grub.cfg" 'insmod ext4' "grub.cfg must use ext2.mod, not ext4"
# Mounted-disk guard: flash_luna_disk refuses any device whose whole node or
# partitions appear mounted. A full trigger needs a real block device (root),
# so assert the classification the guard acts on via LUNA_PROC_MOUNTS.
_mnt_dir="$_tmp/mounts.d"
mkdir -p "$_mnt_dir"
cat >"$_mnt_dir/mounts" <<EOF
/dev/sr0 /src iso9660 ro 0 0
/dev/sda1 /boot ext4 rw 0 0
/dev/nvme1n1p3 /mnt/data ext4 rw 0 0
tmpfs /tmp tmpfs rw 0 0
EOF

LUNA_PROC_MOUNTS="$_mnt_dir/mounts"
export LUNA_PROC_MOUNTS

assert_true _disk_is_mounted /dev/sda
assert_true _disk_is_mounted /dev/nvme1n1
assert_false _disk_is_mounted /dev/sdb
assert_false _disk_is_mounted /dev/nvme0n1
assert_false _disk_is_mounted /dev/mmcblk0

# Prefix collisions must not false-positive: sda vs sdaa, nvme1n1 vs nvme11n1.
cat >"$_mnt_dir/mounts2" <<EOF
/dev/sdaa1 /data ext4 rw 0 0
/dev/nvme11n1p2 /mnt ext4 rw 0 0
EOF
LUNA_PROC_MOUNTS="$_mnt_dir/mounts2"
export LUNA_PROC_MOUNTS
assert_true _disk_is_mounted /dev/sdaa
assert_false _disk_is_mounted /dev/sda
assert_true _disk_is_mounted /dev/nvme11n1
assert_false _disk_is_mounted /dev/nvme1n1

# Refuse-before-wipe ordering: the whole pre-flight chain lives in
# _flash_guards, which flash_luna_disk consults before touching anything
# destructive. Every veto path is reachable here via LUNA_FAKE_BLOCK plus
# the LUNA_PROC_MOUNTS fixtures — no real block device required.
LUNA_FAKE_BLOCK=1
export LUNA_FAKE_BLOCK

# Mounted disk: refused outright.
assert_false _flash_guards /dev/sda "$_tmp/missing.tar"

# Same device unmounted: the chain keeps going and hits the next veto
# (missing archive) — proving the -b probe and the mount guard are
# independent checks, both ahead of anything destructive.
cat >"$_mnt_dir/mounts3" <<'EOF'
/dev/sr0 /src iso9660 ro 0 0
EOF
LUNA_PROC_MOUNTS="$_mnt_dir/mounts3"
export LUNA_PROC_MOUNTS
assert_false _flash_guards /dev/sda "$_tmp/missing.tar"
# A present archive gets past every data guard; whether _flash_guards then
# succeeds depends only on whether this environment has GRUB.
printf 'fake archive\n' >"$_tmp/archive.tar.gz"
[ -f /usr/lib/grub/x86_64-efi/ext2.mod ] && have_grub=1 || have_grub=0
if [ "$have_grub" -eq 1 ]; then
	assert_true _flash_guards /dev/sda "$_tmp/archive.tar.gz"
else
	# No GRUB in this environment: the last guard vetoes with 1.
	assert_false _flash_guards /dev/sda "$_tmp/archive.tar.gz"
fi

# flash_luna_disk itself inherits every veto and returns before
# partitioning.
assert_false flash_luna_disk /dev/sda "$_tmp/missing.tar"

# The classifier fixtures above remain the exact input the in-function
# mount guard acts on.
cat >"$_mnt_dir/mounts" <<'EOF'
/dev/sr0 /src iso9660 ro 0 0
/dev/sda1 /boot ext4 rw 0 0
/dev/nvme1n1p3 /mnt/data ext4 rw 0 0
EOF
LUNA_PROC_MOUNTS="$_mnt_dir/mounts"
export LUNA_PROC_MOUNTS
if ! _disk_is_mounted /dev/sda || ! _disk_is_mounted /dev/nvme1n1; then
	echo "FAIL mount-guard fixtures drifted from flash_luna_disk usage" >&2
	fail=$((fail + 1))
fi

# Hex-only stamp: companion file may be a GNU sha256sum line; dest is one hash.
printf 'deadbeefcafebabe  luna-os-x86_64.img\n' >"$_tmp/img.sha256"
_got="$(_resolve_os_image_hash "" "$_tmp/img")"
if [ "$_got" != "deadbeefcafebabe" ]; then
	echo "FAIL _resolve_os_image_hash must take first field of companion: got '$_got'" >&2
	fail=$((fail + 1))
fi
_record_os_image_hash "$_tmp/data" "aabbccdd  extra"
if [ "$(cat "$_tmp/data/os-image.sha256")" != "aabbccdd" ]; then
	echo "FAIL _record_os_image_hash must write hex only" >&2
	fail=$((fail + 1))
fi

if [ "$fail" -ne 0 ]; then
	echo "$fail failed" >&2
	exit 1
fi
echo "os/lib/flash-disk_test.sh ok"

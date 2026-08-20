#!/bin/sh
# Unit tests for os/lib/disk.sh — no root, no hardware.
set -eu
HERE="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
. "$HERE/disk.sh"

fail=0
assert_eq() {
	_got="$1"
	_want="$2"
	_msg="$3"
	if [ "$_got" != "$_want" ]; then
		echo "FAIL $_msg: got '$_got' want '$_want'" >&2
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

assert_true is_whole_disk /dev/sda
assert_true is_whole_disk /dev/mmcblk0
assert_true is_whole_disk /dev/mmcblk1
assert_true is_whole_disk /dev/nvme0n1
assert_false is_whole_disk /dev/sda1
assert_false is_whole_disk /dev/mmcblk0p1
assert_false is_whole_disk /dev/mmcblk0boot0
assert_false is_whole_disk /dev/nvme0n1p1

assert_eq "$(partition_node /dev/sda)" /dev/sda1 "sda ESP"
assert_eq "$(partition_esp /dev/mmcblk0)" /dev/mmcblk0p1 "eMMC ESP"
assert_eq "$(partition_root /dev/mmcblk0)" /dev/mmcblk0p2 "eMMC root"
assert_eq "$(partition_root /dev/nvme0n1)" /dev/nvme0n1p2 "nvme root"
assert_eq "$(partition_node /dev/nvme0n1)" /dev/nvme0n1p1 "nvme ESP"

assert_eq "$(whole_disk_of /dev/sda)" /dev/sda "sda disk"
assert_eq "$(whole_disk_of /dev/sda1)" /dev/sda "sda1 parent"
assert_eq "$(whole_disk_of /dev/mmcblk0)" /dev/mmcblk0 "mmc disk"
assert_eq "$(whole_disk_of /dev/mmcblk0p1)" /dev/mmcblk0 "mmc ESP parent"
assert_eq "$(whole_disk_of /dev/mmcblk0p2)" /dev/mmcblk0 "mmc root parent"
assert_eq "$(whole_disk_of /dev/nvme0n1p1)" /dev/nvme0n1 "nvme partition parent"

assert_true is_emmc_aux /dev/mmcblk0boot0
assert_true is_emmc_aux /dev/mmcblk0rpmb
assert_false is_emmc_aux /dev/mmcblk0
assert_false is_emmc_aux /dev/mmcblk0p1

LUNA_INSTALL_DISK=/dev/sdb
export LUNA_INSTALL_DISK
assert_true is_install_media /dev/sdb
assert_true is_install_media /dev/sdb1
assert_false is_install_media /dev/mmcblk0

if [ "$fail" -ne 0 ]; then
	echo "$fail failed" >&2
	exit 1
fi
echo "os/lib/disk_test.sh ok"

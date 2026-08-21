#!/bin/sh
# Unit tests for find-media.sh — fake sysfs only, no mounts.
set -eu
HERE="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
. "$HERE/find-media.sh"

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

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/sys/sda" "$TMP/sys/sda1" "$TMP/sys/sdb" "$TMP/sys/sdb1" \
	"$TMP/sys/sr0" "$TMP/sys/nvme0n1" "$TMP/sys/nvme0n1p1" \
	"$TMP/sys/loop0" "$TMP/sys/mmcblk0" "$TMP/sys/mmcblk0p1"
LUNA_SYS_CLASS_BLOCK="$TMP/sys"
export LUNA_SYS_CLASS_BLOCK

got="$(luna_block_candidates)"
assert_eq "$(printf '%s\n' "$got" | head -1)" "/dev/sr0" "optical device first"
assert_eq "$(printf '%s\n' "$got" | grep -c loop || true)" "0" "skip loop devices"
# Whole disks before any partition of the same disk.
sdb_line="$(printf '%s\n' "$got" | grep -n '^/dev/sdb$' | head -1 | cut -d: -f1)"
sdb1_line="$(printf '%s\n' "$got" | grep -n '^/dev/sdb1$' | head -1 | cut -d: -f1)"
if [ -z "$sdb_line" ] || [ -z "$sdb1_line" ] || [ "$sdb_line" -ge "$sdb1_line" ]; then
	echo "FAIL whole disk /dev/sdb must come before /dev/sdb1" >&2
	fail=$((fail + 1))
fi

mkdir -p "$TMP/media"
assert_false luna_dir_has_installer "$TMP/media"
touch "$TMP/media/rapidinstall.sh"
assert_true luna_dir_has_installer "$TMP/media"

if [ "$fail" -ne 0 ]; then
	echo "$fail failed" >&2
	exit 1
fi
echo "os/iso/find-media_test.sh ok"

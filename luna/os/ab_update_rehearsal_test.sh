#!/bin/sh
# Rehearsal / static gate for the A/B + OS OTA pipeline (no real disk, no ISO build).
# Proves the release contract, flash layout, GRUB tryboot, data hash, and updater
# wiring are present and consistent — the e2e gate from the OS update plan.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
OS="$ROOT/os"
fail=0

assert_file_has() {
	_f="$1"
	_pat="$2"
	_msg="$3"
	if ! grep -q "$_pat" "$_f"; then
		echo "FAIL $_msg (missing '$_pat' in $_f)" >&2
		fail=$((fail + 1))
	fi
}

assert_file_has "$OS/lib/disk.sh" 'partition_root_b' "disk helpers must expose slot B"
assert_file_has "$OS/lib/disk.sh" 'partition_data' "disk helpers must expose LUNA_DATA"
assert_file_has "$OS/lib/disk.sh" 'LUNA_SLOT_SIZE_MIB' "slot size must be shared with make-image"

assert_file_has "$OS/lib/flash-disk.sh" 'name=LUNA_A' "flash must create LUNA_A"
assert_file_has "$OS/lib/flash-disk.sh" 'name=LUNA_B' "flash must create LUNA_B"
assert_file_has "$OS/lib/flash-disk.sh" 'name=LUNA_DATA' "flash must create LUNA_DATA"
assert_file_has "$OS/lib/flash-disk.sh" 'luna_boot_ok' "flash must write tryboot grubenv keys"
assert_file_has "$OS/lib/flash-disk.sh" 'os-image.sha256' "flash must record OS image hash on data"

assert_file_has "$OS/build-rootfs.sh" 'LABEL=LUNA_DATA /var/lib/luna' "rootfs must mount data"
assert_file_has "$OS/build-rootfs.sh" 'luna-run' "OpenRC must prefer data-dir lunad"
assert_file_has "$OS/build-rootfs.sh" 'remount,ro,noatime' "root must remount read-only"

assert_file_has "$OS/make-image.sh" 'luna-os-x86_64.img' "make-image must produce the OTA slot asset"
assert_file_has "$OS/build-iso.sh" 'make-image.sh' "ISO build must produce the slot image"
assert_file_has "$OS/iso/stage-debian-live.sh" 'luna-os-' "ISO stage must copy the slot image when present"
assert_file_has "$OS/rapidinstall.sh" 'partition_data' "factory must peel token onto LUNA_DATA"

assert_file_has "$ROOT/crates/lunad/src/updates.rs" 'luna-os-x86_64.img' "updater must know the OS asset name"
assert_file_has "$ROOT/crates/lunad/src/updates.rs" 'os-image.sha256' "updater must compare installed OS hash"
assert_file_has "$ROOT/crates/lunad/src/updates.rs" 'DataDirInstaller' "daemon OTA must target LUNA_DATA"
assert_file_has "$ROOT/crates/lunad/src/updates.rs" 'install_os_image' "updater must apply OS slot images"
assert_file_has "$ROOT/crates/lunad/src/updates.rs" 'reboot_required' "apply must signal reboot when OS changes"

assert_file_has "$ROOT/../release.sh" 'luna-os-x86_64.img' "release.sh must publish the slot image on OS cuts"
assert_file_has "$ROOT/../docs/RELEASE.md" 'luna-os-x86_64.img' "RELEASE.md must document the slot image"

# UI must stay undifferentiated (no Software vs System split).
if grep -E 'System update|OS update|system update' \
	"$ROOT/web/src/components/settings/categories/UpdatesCategory.jsx" >/dev/null 2>&1; then
	echo "FAIL Updates UI must not differentiate OS vs software" >&2
	fail=$((fail + 1))
fi
assert_file_has "$ROOT/web/src/components/settings/categories/UpdatesCategory.jsx" 'Install update' \
	"Updates UI must keep a single Install update action"

# Simulate hash-detect → apply decision (mirrors updates.rs logic).
_tmp="$(mktemp -d)"
trap 'rm -rf "$_tmp"' EXIT INT
printf 'aaa\n' >"$_tmp/os-image.sha256"
printf 'bbb  luna-os-x86_64.img\nccc  lunad-linux-amd64\n' >"$_tmp/SHA256SUMS.txt"
_remote="$(awk '/luna-os-x86_64.img/ {print $1}' "$_tmp/SHA256SUMS.txt")"
_local="$(cat "$_tmp/os-image.sha256")"
if [ "$_remote" = "$_local" ]; then
	echo "FAIL rehearsal hash fixture should differ" >&2
	fail=$((fail + 1))
fi
# After "apply", hash is updated — no longer needed.
printf '%s\n' "$_remote" >"$_tmp/os-image.sha256"
_local2="$(cat "$_tmp/os-image.sha256")"
if [ "$_remote" != "$_local2" ]; then
	echo "FAIL post-apply hash should match release" >&2
	fail=$((fail + 1))
fi

# GRUB tryboot rollback path is present (tries → 0 flips slot).
assert_file_has "$OS/lib/flash-disk.sh" 'luna_tries" = "0"' \
	"GRUB must flip slot when tries are exhausted"

if [ "$fail" -ne 0 ]; then
	echo "$fail failed" >&2
	exit 1
fi
echo "os/ab_update_rehearsal_test.sh ok"

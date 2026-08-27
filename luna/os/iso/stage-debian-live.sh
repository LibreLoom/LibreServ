#!/bin/sh
# Assemble config/includes.binary/luna/ and copy helper scripts into the live root.
# Runs on the host before live-build inside Debian.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
ARCH="${ARCH:-x86_64}"
OUT="$ROOT/os/dist"
DL="$ROOT/os/debian-live"
TARBALL="$OUT/luna-rootfs-$ARCH.tar.gz"
BINL="$DL/config/includes.binary/luna"
CHROOT_LIB="$DL/config/includes.chroot/usr/lib/luna-installer"

[ -f "$TARBALL" ] || {
	echo "missing $TARBALL — run os/build-rootfs.sh first" >&2
	exit 2
}

rm -rf "$BINL"
mkdir -p "$BINL/lib" "$CHROOT_LIB"

cp "$ROOT/os/rapidinstall.sh" "$BINL/rapidinstall.sh"
cp "$ROOT/os/lib/disk.sh" "$BINL/lib/disk.sh"
cp "$ROOT/os/lib/flash-disk.sh" "$BINL/lib/flash-disk.sh"
cp "$ROOT/os/lib/console.sh" "$BINL/lib/console.sh"
cp "$ROOT/os/lib/factory-assets.sh" "$BINL/lib/factory-assets.sh"
chmod +x "$BINL/rapidinstall.sh" "$BINL/lib/flash-disk.sh"

cp "$TARBALL" "$BINL/luna-rootfs-$ARCH.tar.gz"

cp "$ROOT/os/iso/find-media.sh" "$CHROOT_LIB/find-media.sh"
chmod +x "$CHROOT_LIB/find-media.sh" "$DL/config/includes.chroot/usr/lib/luna-installer/start.sh"

printf 'Luna rapidinstall payload staged (%s)\n' "$BINL"

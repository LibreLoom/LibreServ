#!/bin/sh
# Build a UEFI+BIOS hybrid rapidinstall ISO for ordinary x86_64 PCs.
# Boot the USB; the installer writes Luna to built-in storage, never the stick.
#
# Needs: rootfs tarball from build-rootfs.sh, Podman.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/alpine-image.sh
. "$ROOT/os/lib/alpine-image.sh"
ALPINE_VERSION="${ALPINE_VERSION:-v3.24}"
ARCH="${ARCH:-x86_64}"
OUT="$ROOT/os/dist"
WORK="$ROOT/os/work/iso"
ISOROOT="$WORK/tree"
TARBALL="$OUT/luna-rootfs-$ARCH.tar.gz"
ISO="$OUT/luna-rapidinstall-$ARCH.iso"

[ -f "$TARBALL" ] || {
	echo "missing $TARBALL — run os/build-rootfs.sh first" >&2
	exit 2
}

rm -rf "$WORK"
mkdir -p "$ISOROOT/boot" "$ISOROOT/isolinux" "$ISOROOT/lib" "$OUT"

cp "$ROOT/os/iso/init" "$WORK/init"
cp "$ROOT/os/iso/isolinux.cfg" "$ISOROOT/isolinux/isolinux.cfg"
cp "$ROOT/os/iso/build-live.sh" "$WORK/build-live.sh"
cp "$ROOT/os/iso/build-xorriso.sh" "$WORK/build-xorriso.sh"
cp "$ROOT/os/rapidinstall.sh" "$ISOROOT/rapidinstall.sh"
cp "$ROOT/os/lib/disk.sh" "$ISOROOT/lib/disk.sh"
cp "$ROOT/os/lib/flash-disk.sh" "$ISOROOT/lib/flash-disk.sh"
chmod +x "$ISOROOT/rapidinstall.sh" "$WORK/init" "$WORK/build-live.sh" "$WORK/build-xorriso.sh"
cp "$TARBALL" "$ISOROOT/luna-rootfs-$ARCH.tar.gz"

podman run --rm \
	-e ALPINE_VERSION="$ALPINE_VERSION" \
	-e ARCH="$ARCH" \
	-v "$ISOROOT:/iso:z" \
	-v "$WORK/init:/init.in:ro,z" \
	-v "$WORK/build-live.sh:/build-live.sh:ro,z" \
	"$ALPINE_IMAGE" sh /build-live.sh

podman run --rm \
	-e ARCH="$ARCH" \
	-v "$ISOROOT:/iso:z" \
	-v "$OUT:/out:z" \
	-v "$WORK/build-xorriso.sh:/build-xorriso.sh:ro,z" \
	"$ALPINE_IMAGE" sh /build-xorriso.sh

printf 'built %s\n' "$ISO"
printf 'Write to USB: dd if=%s of=/dev/sdX bs=4M status=progress conv=fsync\n' "$ISO"
printf 'Boot any x86_64 PC from USB (BIOS or UEFI; Secure Boot off).\n'

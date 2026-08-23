#!/bin/sh
# Build a UEFI+BIOS hybrid rapidinstall ISO for ordinary x86_64 PCs.
# Uses Debian live (full kernel, udev, firmware) for the install boot;
# flashes the Alpine Luna rootfs tarball to built-in storage.
#
# Needs: rootfs tarball, live-build on the host, sudo for debootstrap.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
ARCH="${ARCH:-x86_64}"
OUT="$ROOT/os/dist"
ISO="$OUT/luna-rapidinstall-$ARCH.iso"
TARBALL="$OUT/luna-rootfs-$ARCH.tar.gz"
WORK="$ROOT/os/work/debian-live"
BUILD="$ROOT/os/iso/build-debian-live.sh"
STAMP="$OUT/.luna-rapidinstall-${ARCH}.stamp"

die() {
	echo "ERROR: $*" >&2
	exit 1
}

[ -f "$TARBALL" ] || die "missing $TARBALL — run os/build-rootfs.sh first"

if ! command -v lb >/dev/null 2>&1; then
	die "live-build required: sudo apt install live-build debootstrap debian-archive-keyring xorriso"
fi

if ! sudo -n true 2>/dev/null; then
	if [ ! -t 0 ]; then
		die "sudo credentials required for live-build (non-interactive)"
	fi
fi

mkdir -p "$OUT"
"$ROOT/os/iso/stage-debian-live.sh" || die "stage-debian-live.sh failed"

echo "==> preparing live-build workspace"
if [ -d "$WORK" ]; then
	sudo rm -rf "$WORK" || die "could not clean $WORK (leftover root-owned live-build files?)"
fi
mkdir -p "$WORK"
cp -a "$ROOT/os/debian-live/." "$WORK/"

if [ -d "$ROOT/os/debian-live/config/includes.binary/luna" ]; then
	mkdir -p "$WORK/config/includes.binary"
	cp -a "$ROOT/os/debian-live/config/includes.binary/luna" "$WORK/config/includes.binary/"
fi

echo "==> Debian live ISO (bookworm)"
if ! sudo env ARCH="$ARCH" OUT="$OUT" WORK="$WORK" bash "$BUILD"; then
	echo "==> ISO build failed; see $WORK/build.log" >&2
	if [ -f "$WORK/build.log" ]; then
		tail -30 "$WORK/build.log" >&2
	fi
	exit 1
fi

[ -f "$ISO" ] || die "build reported success but $ISO is missing"

# Fail if output is suspiciously small (empty/hybrid stub).
_iso_bytes="$(wc -c <"$ISO" | tr -d ' ')"
if [ "$_iso_bytes" -lt 500000000 ]; then
	die "$ISO is only ${_iso_bytes} bytes — expected hundreds of MB+"
fi

date -u +%Y-%m-%dT%H:%M:%SZ >"$STAMP"

printf 'built %s (%s bytes)\n' "$ISO" "$_iso_bytes"
printf 'Write to USB: dd if=%s of=/dev/sdX bs=4M status=progress conv=fsync\n' "$ISO"
printf 'Boot any x86_64 PC from USB (BIOS or UEFI; Secure Boot off).\n'

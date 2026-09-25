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

# Stage the OTA/factory slot image when present (built by make-image.sh).
if [ -f "$OUT/luna-os-$ARCH.img" ]; then
	cp "$OUT/luna-os-$ARCH.img" "$BINL/luna-os-$ARCH.img"
	if [ -f "$OUT/luna-os-$ARCH.img.sha256" ]; then
		cp "$OUT/luna-os-$ARCH.img.sha256" "$BINL/luna-os-$ARCH.img.sha256"
	fi
fi

# Stage the EuroOffice pack (built by scripts/build-eurooffice-pack.sh via
# build-iso.sh). rapidinstall extracts it onto LUNA_DATA; missing = office
# editing unavailable on the installed device, so warn loudly.
if [ -f "$OUT/eurooffice-pack.tar.zst" ]; then
	cp "$OUT/eurooffice-pack.tar.zst" "$BINL/eurooffice-pack.tar.zst"
	if [ -f "$OUT/eurooffice-pack.tar.zst.sha256" ]; then
		cp "$OUT/eurooffice-pack.tar.zst.sha256" "$BINL/eurooffice-pack.tar.zst.sha256"
	fi
else
	echo "WARNING: no eurooffice-pack.tar.zst in $OUT — installed devices will lack office editing." >&2
	echo "         Run scripts/build-eurooffice-pack.sh (or make eurooffice-pack) first." >&2
fi

# Same for the draw.io pack (scripts/build-drawio-pack.sh) — extracted to
# LUNA_DATA/drawio by rapidinstall; missing = diagram editing unavailable.
if [ -f "$OUT/drawio-pack.tar.zst" ]; then
	cp "$OUT/drawio-pack.tar.zst" "$BINL/drawio-pack.tar.zst"
	if [ -f "$OUT/drawio-pack.tar.zst.sha256" ]; then
		cp "$OUT/drawio-pack.tar.zst.sha256" "$BINL/drawio-pack.tar.zst.sha256"
	fi
else
	echo "WARNING: no drawio-pack.tar.zst in $OUT — installed devices will lack diagram editing." >&2
	echo "         Run scripts/build-drawio-pack.sh (or make drawio-pack) first." >&2
fi

cp "$ROOT/os/iso/find-media.sh" "$CHROOT_LIB/find-media.sh"
chmod +x "$CHROOT_LIB/find-media.sh" "$DL/config/includes.chroot/usr/lib/luna-installer/start.sh"

printf 'Luna rapidinstall payload staged (%s)\n' "$BINL"

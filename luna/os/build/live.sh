#!/bin/sh
# The Debian live system of the rapidinstall ISO, IN-CONTAINER step (runs inside
# build/Containerfile.iso). mmdebstrap + mksquashfs; never calls podman or sudo.
#
#   in:  OSDIR (/luna/os) package lists, hooks, includes; CACHE (optional) apt
#        downloads; env SUITE DEBIAN_MIRROR XZ_THREADS
#   out: LIVE_OUT/filesystem.squashfs, vmlinuz, initrd.img
# build/iso.sh caches the result; the cache key includes this file.
set -eu

OSDIR="${OSDIR:-/luna/os}"
CACHE="${CACHE:-/cache}"
WORK="${WORK:-/build}"
LIVE_OUT="${LIVE_OUT:-$WORK/live}"
SUITE="${SUITE:-bookworm}"
MIRROR="${DEBIAN_MIRROR:-http://deb.debian.org/debian}"
THREADS="${XZ_THREADS:-$(nproc)}"
DL="$OSDIR/debian-live/config"

die() {
	echo "ERROR: $*" >&2
	exit 1
}

pkglist() {
	sed 's/#.*//' "$@" | awk 'NF { print $1 }' | sort -u
}
PKGS="$(pkglist "$DL"/package-lists/*.list.chroot | tr '\n' ',' | sed 's/,$//')"
mkdir -p "$LIVE_OUT"

echo "==> live system: mmdebstrap $SUITE"
CHROOT="$WORK/chroot"
rm -rf "$CHROOT"
APT_CACHE="$CACHE/apt"
mkdir -p "$APT_CACHE"
# --mode=root: this container is its own user namespace, so "root" here
# is the invoking user on the host. apt downloads are synced in and out
# of the cache volume so a rebuild does not fetch them again.
mmdebstrap --mode=root --variant=minbase \
	--architectures=amd64 \
	--components="main contrib non-free non-free-firmware" \
	--aptopt='APT::Install-Recommends "false"' \
	--aptopt='Acquire::Languages "none"' \
	--include="linux-image-amd64,xz-utils,$PKGS" \
	--setup-hook='mkdir -p "$1/var/cache/apt/archives"' \
	--setup-hook="sync-in $APT_CACHE /var/cache/apt/archives" \
	--customize-hook="$OSDIR/build/iso-customize.sh \"\$1\"" \
	--customize-hook="sync-out /var/cache/apt/archives $APT_CACHE" \
	"$SUITE" "$CHROOT" "$MIRROR"

_k="$(ls "$CHROOT"/boot/vmlinuz-* | sort | tail -n 1)"
_i="$(ls "$CHROOT"/boot/initrd.img-* | sort | tail -n 1)"
[ -f "$_k" ] && [ -f "$_i" ] || die "the live system has no kernel or initramfs"
cp "$_k" "$LIVE_OUT/vmlinuz"
cp "$_i" "$LIVE_OUT/initrd.img"
# Without live-boot inside the initramfs, boot=live finds nothing.
chroot "$CHROOT" lsinitramfs "/boot/$(basename "$_i")" | grep -q 'scripts/live' \
	|| die "live-boot is missing from the initramfs"

echo "==> live system: squashfs"
mksquashfs "$CHROOT" "$LIVE_OUT/filesystem.squashfs" \
	-comp xz -b 1M -Xbcj x86 -processors "$THREADS" -no-progress -noappend \
	-wildcards -e 'boot/vmlinuz-*' -e 'boot/initrd.img-*' -e 'var/cache/apt/archives/*.deb' >/dev/null
rm -rf "$CHROOT"

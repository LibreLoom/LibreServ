#!/bin/sh
# mmdebstrap customize hook for the rapidinstall live system.
# Usage (by mmdebstrap): iso-customize.sh <chroot dir>
# Reproduces what live-build did for us: copy includes.chroot, run the
# 0100 hook, build the initramfs with live-boot inside. Rootless, no podman.
set -eu

CHROOT="$1"
OSDIR="${OSDIR:-/luna/os}"
DL="$OSDIR/debian-live/config"

# includes.chroot: /etc/live/config.conf, the installer's init/start/network
# scripts, and the live-config 9999 hook. Owned by root inside the build.
cp -a "$DL/includes.chroot/." "$CHROOT/"
# The installer's media finder lives beside the other iso/ helpers.
install -D -m 0755 "$OSDIR/iso/find-media.sh" "$CHROOT/usr/lib/luna-installer/find-media.sh"

# Hooks (0100 only: it chmods the installer scripts and masks getty).
for hook in "$DL"/hooks/*.hook.chroot; do
	[ -f "$hook" ] || continue
	install -m 0755 "$hook" "$CHROOT/tmp/luna-hook.sh"
	chroot "$CHROOT" /bin/bash /tmp/luna-hook.sh
	rm -f "$CHROOT/tmp/luna-hook.sh"
done

# live-boot must be inside the initramfs or `boot=live` finds nothing.
chroot "$CHROOT" update-initramfs -u -k all

# Keep the squashfs small: no apt lists, caches, logs, docs of the live system.
rm -rf "$CHROOT"/var/cache/apt/*.bin "$CHROOT"/var/log/*.log "$CHROOT"/var/log/apt \
	"$CHROOT"/var/lib/apt/lists/* "$CHROOT"/tmp/* 2>/dev/null || true

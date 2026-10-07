#!/bin/sh
# Dev wrapper: build the rapidinstall ISO (BIOS + UEFI hybrid, volume LUNAINST)
# from os/dist/luna-os-x86_64.img.xz and the packs in os/dist/. Rootless
# podman only; no sudo, no live-build. The work is build/iso.sh, which runs
# inside build/Containerfile.iso.
#
# Needs first: ./os/make-image.sh (the .img.xz), and optionally the EuroOffice
# and draw.io packs (make eurooffice-pack drawio-pack).
set -eu

OSDIR="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
OUT="${OUT:-$OSDIR/dist}"
# shellcheck source=lib/host-podman.sh
. "$OSDIR/lib/host-podman.sh"
ARCH="${ARCH:-x86_64}"
DEBIAN_IMAGE="${DEBIAN_IMAGE:-docker.io/library/debian:bookworm}"
ISO="$OUT/luna-rapidinstall-$ARCH.iso"

luna_need_podman
[ -s "$OUT/luna-os-$ARCH.img.xz" ] || luna_die "missing $OUT/luna-os-$ARCH.img.xz: run os/make-image.sh first"

IMAGE="$(luna_build_image iso "$OSDIR/build/Containerfile.iso" "DEBIAN_IMAGE=$DEBIAN_IMAGE")"
podman volume exists "$LUNA_ISO_CACHE_VOLUME" || podman volume create "$LUNA_ISO_CACHE_VOLUME" >/dev/null

echo "==> rapidinstall ISO"
podman run --rm --security-opt label=disable --memory "$LUNA_BUILD_MEMORY" \
	-v "$OSDIR:/luna/os:ro" \
	-v "$OUT:/payload:ro" \
	-v "$OUT:/out" \
	-v "$LUNA_ISO_CACHE_VOLUME:/cache" \
	-e ARCH="$ARCH" -e LUNA_LIVE_REFRESH="${LUNA_LIVE_REFRESH:-}" \
	"$IMAGE" sh /luna/os/build/iso.sh

[ -f "$ISO" ] || luna_die "build reported success but $ISO is missing"
date -u +%Y-%m-%dT%H:%M:%SZ >"$OUT/.luna-rapidinstall-$ARCH.stamp"
printf 'Write to USB: dd if=%s of=/dev/sdX bs=4M status=progress conv=fsync\n' "$ISO"
printf 'Boot any x86_64 PC from USB (BIOS or UEFI; Secure Boot off).\n'

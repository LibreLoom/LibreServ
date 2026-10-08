#!/bin/sh
# End-to-end test of Luna OS in QEMU, rootless, inside one container.
#
#   iso/e2e.sh [stage ...]       run the named stages (default: all)
#   iso/e2e.sh --list            list stages
#   E2E_KEEP=1 iso/e2e.sh ...    keep os/dist/e2e/ (golden disks) between runs
#
# Needs os/dist/luna-rapidinstall-x86_64.iso (os/make-iso.sh or build-iso.sh) and
# os/dist/luna-os-x86_64.img.xz. Works in os/dist/e2e/ (several GiB of sparse
# disks). Uses KVM when /dev/kvm is writable. Exit status is the number of failed
# checks > 0. The test code is in iso/e2e/ (lib.py = QEMU + API helpers,
# run.py = the stages).
set -eu

OSDIR="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
# shellcheck source=../lib/host-podman.sh
. "$OSDIR/lib/host-podman.sh"
luna_need_podman

IMAGE="$(luna_build_image qemu "$OSDIR/iso/Containerfile.qemu" "DEBIAN_IMAGE=${DEBIAN_IMAGE:-docker.io/library/debian:bookworm}")"
WORK="$OSDIR/dist/e2e"
mkdir -p "$WORK"
DEV=""
[ -w /dev/kvm ] && DEV="--device /dev/kvm"
# shellcheck disable=SC2086
exec podman run --rm --name luna-e2e --security-opt label=disable --memory "${E2E_MEMORY:-8g}" $DEV \
	-v "$OSDIR/dist:/dist:ro" -v "$WORK:/work" -v "$OSDIR/iso/e2e:/e2e:ro" \
	-v "$OSDIR/../../keys:/keys:ro" -v "$OSDIR/../scripts/mocks:/mocks:ro" -v "$OSDIR/../target/x86_64-unknown-linux-musl/release/lunad:/lunad:ro" \
	-e E2E_KEEP="${E2E_KEEP:-}" -e E2E_CMDS="${E2E_CMDS:-}" -e E2E_USB="${E2E_USB:-}" \
	"$IMAGE" python3 -u /e2e/run.py "$@"

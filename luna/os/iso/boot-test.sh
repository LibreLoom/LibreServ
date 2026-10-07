#!/bin/sh
# Dev check: boot os/dist/luna-rapidinstall-x86_64.iso in QEMU, rootless, as a
# USB disk (the way a dd'd stick looks to firmware), and capture the screen.
#
#   iso/boot-test.sh bios|uefi [seconds]
#
# Output in os/dist/boot-test/: <mode>.png (the VGA console after <seconds>),
# <mode>-serial.log. Uses KVM when /dev/kvm is writable, otherwise TCG (slower:
# raise the seconds). The production kernel line only has console=tty0, so the
# installer's text shows on the VGA screen, not the serial port.
set -eu

OSDIR="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
# shellcheck source=../lib/host-podman.sh
. "$OSDIR/lib/host-podman.sh"
MODE="${1:-bios}"
SECS="${2:-60}"
ISO="${ISO:-$OSDIR/dist/luna-rapidinstall-x86_64.iso}"
OUT="$OSDIR/dist/boot-test"

luna_need_podman
[ -f "$ISO" ] || luna_die "missing $ISO: run os/make-iso.sh first"
case "$MODE" in
bios) FW="" ;;
uefi) FW="-drive if=pflash,format=raw,readonly=on,file=/usr/share/OVMF/OVMF_CODE_4M.fd -drive if=pflash,format=raw,file=/tmp/ovmf-vars.fd" ;;
*) luna_die "usage: boot-test.sh bios|uefi [seconds]" ;;
esac
KVM=""
DEV=""
if [ -w /dev/kvm ]; then
	KVM="-enable-kvm -cpu host"
	DEV="--device /dev/kvm"
else
	echo "no usable /dev/kvm: using TCG (slow)" >&2
fi

IMAGE="$(luna_build_image qemu "$OSDIR/iso/Containerfile.qemu" "DEBIAN_IMAGE=${DEBIAN_IMAGE:-docker.io/library/debian:bookworm}")"
mkdir -p "$OUT"
rm -f "$OUT/$MODE.png" "$OUT/$MODE-serial.log"
# shellcheck disable=SC2086
podman run --rm --security-opt label=disable --memory 3g $DEV \
	-v "$(dirname "$ISO"):/iso:ro" -v "$OUT:/out" \
	"$IMAGE" sh -euc "
	cp /usr/share/OVMF/OVMF_VARS_4M.fd /tmp/ovmf-vars.fd 2>/dev/null || true
	qemu-system-x86_64 -machine q35 $KVM -m 2048 -smp 2 \
		$FW \
		-drive if=none,id=stick,format=raw,readonly=on,file=/iso/$(basename "$ISO") \
		-device qemu-xhci -device usb-storage,drive=stick,bootindex=1 \
		-vga std -display none -serial file:/out/$MODE-serial.log \
		-monitor unix:/tmp/mon,server,nowait -net none -daemonize
	sleep $SECS
	echo screendump /tmp/shot.ppm | socat - UNIX-CONNECT:/tmp/mon >/dev/null
	sleep 1
	pnmtopng /tmp/shot.ppm >/out/$MODE.png
	echo quit | socat - UNIX-CONNECT:/tmp/mon >/dev/null || true
"
echo "screen: $OUT/$MODE.png"

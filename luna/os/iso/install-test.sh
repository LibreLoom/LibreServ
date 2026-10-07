#!/bin/sh
# Dev check: run the whole installer in QEMU, rootless. Boots the ISO as a USB
# stick with an empty virtual disk (/dev/vda) as the target, auto-confirms the
# install, then boots the installed disk and prints what it shows.
#
#   iso/install-test.sh [bios|uefi]        install, then boot the result in that mode
#   SKIP_INSTALL=1 iso/install-test.sh uefi   only boot the disk left by an earlier run
#
# Output in os/dist/install-test/: install-serial.log (installer text),
# installed.png (screen of the installed Luna), disk.raw (sparse, 6 GiB).
# Uses the kernel/initrd from the ISO with LUNA_TARGET / LUNA_CONFIRM on the
# command line (the installer's documented automation hooks) and
# console=ttyS0 added for a text log; the ISO itself is untouched.
set -eu

OSDIR="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
# shellcheck source=../lib/host-podman.sh
. "$OSDIR/lib/host-podman.sh"
MODE="${1:-bios}"
ISO="${ISO:-$OSDIR/dist/luna-rapidinstall-x86_64.iso}"
OUT="$OSDIR/dist/install-test"

luna_need_podman
[ -f "$ISO" ] || luna_die "missing $ISO: run os/make-iso.sh first"
KVM=""
DEV=""
if [ -w /dev/kvm ]; then
	KVM="-enable-kvm -cpu host"
	DEV="--device /dev/kvm"
fi
FW=""
if [ "$MODE" = uefi ]; then
	FW="-drive if=pflash,format=raw,readonly=on,file=/usr/share/OVMF/OVMF_CODE_4M.fd -drive if=pflash,format=raw,file=/tmp/ovmf-vars.fd"
fi

IMAGE="$(luna_build_image qemu "$OSDIR/iso/Containerfile.qemu" "DEBIAN_IMAGE=${DEBIAN_IMAGE:-docker.io/library/debian:bookworm}")"
mkdir -p "$OUT"
if [ -z "${SKIP_INSTALL:-}" ]; then rm -f "$OUT"/*; else rm -f "$OUT"/installed*; fi
# shellcheck disable=SC2086
podman run --rm --security-opt label=disable --memory 3g $DEV \
	-v "$(dirname "$ISO"):/iso:ro" -v "$OUT:/out" \
	"$IMAGE" sh -euc "
	apt-get update -qq >/dev/null 2>&1; DEBIAN_FRONTEND=noninteractive apt-get install -y -qq xorriso >/dev/null 2>&1
	cp /usr/share/OVMF/OVMF_VARS_4M.fd /tmp/ovmf-vars.fd 2>/dev/null || true
	xorriso -osirrox on -indev /iso/$(basename "$ISO") -extract /live/vmlinuz /tmp/vmlinuz -extract /live/initrd.img /tmp/initrd.img >/dev/null 2>&1
	if [ -z '${SKIP_INSTALL:-}' ]; then
	truncate -s 6G /out/disk.raw
	echo '==> installing'
	# The installer asks for an optional device token at the end: send Enter
	# presses on the serial console until it moves on and reboots.
	( sleep 50; i=0; while [ \$i -lt 40 ]; do printf '\\n'; sleep 3; i=\$((i + 1)); done ) | qemu-system-x86_64 -machine q35 $KVM -m 2048 -smp 2 -nographic -no-reboot -net none \
		-drive if=none,id=stick,format=raw,readonly=on,file=/iso/$(basename "$ISO") \
		-device qemu-xhci -device usb-storage,drive=stick \
		-drive if=virtio,format=raw,file=/out/disk.raw \
		-kernel /tmp/vmlinuz -initrd /tmp/initrd.img \
		-append 'boot=live text nomodeset console=tty0 console=ttyS0 net.ifnames=0 biosdevname=0 init=/usr/lib/luna-installer/init.sh LUNA_TARGET=/dev/vda LUNA_CONFIRM=INSTALL LUNA_OVERRIDE_WAIT=1' \
		>/out/install-serial.log 2>&1 || true
	fi
	echo '==> booting the installed disk'
	qemu-system-x86_64 -machine q35 $KVM -m 1024 -smp 2 $FW \
		-drive if=virtio,format=raw,file=/out/disk.raw \
		-vga std -display none -serial file:/out/installed-serial.log \
		-monitor unix:/tmp/mon,server,nowait -net none -daemonize
	sleep 45
	echo screendump /tmp/shot.ppm | socat - UNIX-CONNECT:/tmp/mon >/dev/null
	sleep 1
	pnmtopng /tmp/shot.ppm >/out/installed.png
	echo quit | socat - UNIX-CONNECT:/tmp/mon >/dev/null || true
"
echo "installer log: $OUT/install-serial.log"
echo "installed screen: $OUT/installed.png"

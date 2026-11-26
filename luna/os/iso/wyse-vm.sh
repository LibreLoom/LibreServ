#!/bin/sh
# Dev: run the rapidinstall ISO in a window on a virtual Dell Wyse 3040
# (quad-core Atom x5-Z8350 without AVX, 1.9 GB RAM, 8 GB slow eMMC, UEFI,
# gigabit ethernet, USB).
#
#   iso/wyse-vm.sh install   boot the ISO from a virtual USB stick, install to the eMMC
#   iso/wyse-vm.sh run       boot the installed eMMC (no USB stick)
#   iso/wyse-vm.sh reset     delete the virtual eMMC and UEFI settings
#
# Window size: RES_X / RES_Y (default 1024x768). The web UI is forwarded to http://localhost:8080. A USB drive image can be
# attached with USB_IMG=/path/to/file.img. State lives in os/dist/wyse-vm/.
set -eu

OSDIR="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
ISO="${ISO:-$OSDIR/dist/luna-rapidinstall-x86_64.iso}"
DIR="$OSDIR/dist/wyse-vm"
EMMC="$DIR/emmc.qcow2"
VARS="$DIR/ovmf-vars.fd"
MODE="${1:-install}"
mkdir -p "$DIR"

case "$MODE" in
reset) rm -f "$EMMC" "$VARS"; echo "virtual Wyse 3040 reset"; exit 0 ;;
install | run) ;;
*) echo "usage: $0 install|run|reset" >&2; exit 2 ;;
esac

[ -f "$EMMC" ] || qemu-img create -f qcow2 "$EMMC" 8G >/dev/null
[ -f "$VARS" ] || cp /usr/share/OVMF/OVMF_VARS_4M.fd "$VARS"

KVM=""
[ -w /dev/kvm ] && KVM="-enable-kvm"
# Cherry Trail Atom: SSE4.2, AES, no AVX. Westmere is the closest stock model.
CPU="Westmere,+aes,+pclmulqdq,+rdrand,+popcnt"

set -- -machine q35 $KVM -cpu "$CPU" -m 1900 -smp 4 -name wyse3040 \
	-drive if=pflash,format=raw,readonly=on,file=/usr/share/OVMF/OVMF_CODE_4M.fd \
	-drive if=pflash,format=raw,file="$VARS" \
	-device qemu-xhci,id=xhci \
	-drive if=none,id=emmc,file="$EMMC",format=qcow2,throttling.bps-read=90000000,throttling.bps-write=30000000 \
	-device sdhci-pci -device sd-card,drive=emmc \
	-netdev user,id=n0,hostfwd=tcp:127.0.0.1:8080-:80 -device e1000e,netdev=n0 \
	-device VGA,edid=on,xres=${RES_X:-1024},yres=${RES_Y:-768} -display gtk,zoom-to-fit=on -device usb-kbd,bus=xhci.0 -device usb-tablet,bus=xhci.0

if [ "$MODE" = install ]; then
	[ -f "$ISO" ] || { echo "missing $ISO: run os/build-iso.sh" >&2; exit 2; }
	# Boot the kernel straight from the ISO so we can pass the keyboard layout
	# (KEYMAP, default colemak); the ISO is still attached as the install USB stick.
	isoinfo -i "$ISO" -R -x /live/vmlinuz >"$DIR/vmlinuz"
	isoinfo -i "$ISO" -R -x /live/initrd.img >"$DIR/initrd.img"
	set -- "$@" -drive if=none,id=stick,format=raw,readonly=on,file="$ISO" \
		-device usb-storage,drive=stick,bus=xhci.0,bootindex=1 \
		-kernel "$DIR/vmlinuz" -initrd "$DIR/initrd.img" \
		-append "boot=live text nomodeset console=tty0 net.ifnames=0 biosdevname=0 init=/usr/lib/luna-installer/init.sh luna.keymap=${KEYMAP:-colemak}"
fi
if [ -n "${USB_IMG:-}" ]; then
	set -- "$@" -drive if=none,id=usbdata,format=raw,file="$USB_IMG" \
		-device usb-storage,drive=usbdata,bus=xhci.0
fi
exec qemu-system-x86_64 "$@"

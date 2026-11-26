#!/bin/sh
# Dev: run Luna in a window on a virtual Dell Wyse 3040 (quad-core Atom
# x5-Z8350 without AVX, 1.9 GB RAM, 8 GB slow eMMC, UEFI, gigabit ethernet, USB).
#
#   iso/wyse-vm.sh [start] [DEVICE_ID CODE]
#        Default. Boots the virtual eMMC. If there is none yet, it is built from
#        os/dist/luna-os-x86_64.img.zst with the installer's own flash code
#        (iso/provision-disk.sh, uses sudo), so no installer screens. DEVICE_ID
#        and CODE (the Luna Connect pairing values) are optional.
#   iso/wyse-vm.sh install
#        Erase the virtual eMMC and run the real rapidinstall ISO from a virtual
#        USB stick (keyboard layout: KEYMAP, default colemak).
#   iso/wyse-vm.sh reset
#        Delete the virtual eMMC and UEFI settings.
#
# The web UI is forwarded to http://localhost:8080. USB_IMG=/path/file.img
# attaches a virtual USB drive. RES_X / RES_Y set the window size (1024x768).
# The slow eMMC chip is imitated everywhere except during install.
# State lives in os/dist/wyse-vm/; QEMU's monitor is dist/wyse-vm/monitor.sock.
set -eu

OSDIR="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
ISO="${ISO:-$OSDIR/dist/luna-rapidinstall-x86_64.iso}"
DIR="$OSDIR/dist/wyse-vm"
EMMC="$DIR/emmc.img"
VARS="$DIR/ovmf-vars.fd"
MODE="${1:-start}"
mkdir -p "$DIR"

case "$MODE" in
reset) rm -f "$EMMC" "$VARS"; echo "virtual Wyse 3040 reset"; exit 0 ;;
start)
	[ "$#" -le 3 ] || { echo "usage: $0 [start] [DEVICE_ID CODE]" >&2; exit 2; }
	if [ ! -f "$EMMC" ]; then
		echo "==> building the virtual eMMC from the OS image (sudo needed for a loop device)"
		if ! sudo "$OSDIR/iso/provision-disk.sh" "$EMMC.new" ${2:+"$2"} ${3:+"$3"}; then
			rm -f "$EMMC.new"; exit 1
		fi
		sudo chown "$(id -u):$(id -g)" "$EMMC.new"
		mv "$EMMC.new" "$EMMC"
	fi
	;;
install) rm -f "$EMMC"; truncate -s 8G "$EMMC" ;;
*) echo "usage: $0 [start|install|reset]" >&2; exit 2 ;;
esac

[ -f "$VARS" ] || cp /usr/share/OVMF/OVMF_VARS_4M.fd "$VARS"

KVM=""
[ -w /dev/kvm ] && KVM="-enable-kvm"
# Cherry Trail Atom: SSE4.2, AES, no AVX. Westmere is the closest stock model.
CPU="Westmere,+aes,+pclmulqdq,+rdrand,+popcnt"
THROTTLE=""
[ "$MODE" = install ] || THROTTLE=",throttling.bps-read=90000000,throttling.bps-write=30000000"

set -- -machine q35 $KVM -cpu "$CPU" -m 1900 -smp 4 -name wyse3040 \
	-monitor unix:"$DIR/monitor.sock",server,nowait \
	-drive if=pflash,format=raw,readonly=on,file=/usr/share/OVMF/OVMF_CODE_4M.fd \
	-drive if=pflash,format=raw,file="$VARS" \
	-device qemu-xhci,id=xhci \
	-drive if=none,id=emmc,file="$EMMC",format=raw"$THROTTLE" \
	-device sdhci-pci -device sd-card,drive=emmc \
	-netdev user,id=n0,hostfwd=tcp:127.0.0.1:8080-:80 -device e1000e,netdev=n0 \
	-device VGA,edid=on,xres="${RES_X:-1024}",yres="${RES_Y:-768}" -display gtk,zoom-to-fit=on \
	-device usb-kbd,bus=xhci.0 -device usb-tablet,bus=xhci.0

if [ "$MODE" = install ]; then
	[ -f "$ISO" ] || { echo "missing $ISO: run os/build-iso.sh" >&2; exit 2; }
	# Boot the kernel straight from the ISO so we can pass the keyboard layout;
	# the ISO is still attached as the install USB stick.
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

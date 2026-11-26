#!/bin/sh
# Dev: run Luna in a window on a virtual Dell Wyse 3040 (quad-core Atom
# x5-Z8350 without AVX, 1.9 GB RAM, 8 GB slow eMMC, gigabit ethernet, USB). It boots
# with BIOS (SeaBIOS), not UEFI like the real thing: QEMU's UEFI firmware cannot read
# an eMMC/SD controller, SeaBIOS can (the e2e tests do the same). The disk has both.
#
#   iso/wyse-vm.sh [start] [DEVICE_TOKEN]
#        Default. Boots the virtual eMMC. If there is none yet, it is built from
#        os/dist/luna-os-x86_64.img.zst with the installer's own flash code
#        (iso/provision-disk.sh, uses sudo), so no installer screens. DEVICE_TOKEN
#        (the Luna Connect device token) is optional.
#   iso/wyse-vm.sh install
#        Erase the virtual eMMC and run the real rapidinstall ISO from a virtual
#        USB stick (keyboard layout: KEYMAP, default colemak).
#   iso/wyse-vm.sh usb add [IMAGE]    plug a virtual USB drive into the running VM
#   iso/wyse-vm.sh usb remove [NAME]  pull it out again (the name `usb add` printed)
#        With no IMAGE a blank 16 GB image is made (dist/wyse-vm/usb-blank.img).
#   iso/wyse-vm.sh refresh
#        With the VM closed: put the latest OS image on the virtual eMMC and keep
#        everything on it (accounts, settings, files). The old disk is kept as
#        emmc.before-refresh.img.
#   iso/wyse-vm.sh reset
#        Delete the virtual eMMC.
#
# The web UI is forwarded to http://localhost:8080. USB_IMG=/path/file.img
# attaches a virtual USB drive. RES_X / RES_Y set the window size (1024x768).
# The slow eMMC chip is imitated everywhere except during install.
# DISK_BUS=virtio|sdhci picks how the eMMC looks to Luna (see below).
# State lives in os/dist/wyse-vm/; QEMU's monitor is dist/wyse-vm/monitor.sock.
set -eu

OSDIR="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
ISO="${ISO:-$OSDIR/dist/luna-rapidinstall-x86_64.iso}"
DIR="$OSDIR/dist/wyse-vm"
EMMC="$DIR/emmc.img"
MODE="${1:-start}"
mkdir -p "$DIR"

# Send monitor commands to the running VM (no socat needed).
monitor() {
	[ -S "$DIR/monitor.sock" ] || { echo "the VM is not running" >&2; exit 1; }
	python3 -I - "$DIR/monitor.sock" "$@" <<'PY'
import socket, sys, time
s = socket.socket(socket.AF_UNIX)
s.connect(sys.argv[1])
time.sleep(0.3)
for c in sys.argv[2:]:
    s.send((c + "\n").encode())
    time.sleep(0.5)
PY
}

case "$MODE" in
usb)
	case "${2:-}" in
	add)
		IMG="${3:-$DIR/usb-blank.img}"
		[ -f "$IMG" ] || truncate -s 16G "$IMG"
		IMG="$(readlink -f "$IMG")"
		NAME="usb$(date +%s)"
		monitor "drive_add 0 if=none,id=$NAME,file=$IMG,format=raw" \
			"device_add usb-storage,id=dev-$NAME,drive=$NAME,bus=xhci.0,removable=on"
		echo "plugged in $IMG as $NAME"
		;;
	remove)
		[ -n "${3:-}" ] || { echo "usage: $0 usb remove NAME" >&2; exit 2; }
		monitor "device_del dev-$3" && sleep 1 && monitor "drive_del $3"
		echo "pulled $3"
		;;
	*) echo "usage: $0 usb add [IMAGE] | usb remove NAME" >&2; exit 2 ;;
	esac
	exit 0
	;;
reset) rm -f "$EMMC"; echo "virtual Wyse 3040 reset"; exit 0 ;;
start)
	[ "$#" -le 2 ] || { echo "usage: $0 [start] [DEVICE_TOKEN]" >&2; exit 2; }
	if [ ! -f "$EMMC" ]; then
		echo "==> building the virtual eMMC from the OS image (sudo needed for a loop device)"
		if ! sudo "$OSDIR/iso/provision-disk.sh" "$EMMC.new" ${2:+"$2"}; then
			rm -f "$EMMC.new"; exit 1
		fi
		sudo chown "$(id -u):$(id -g)" "$EMMC.new"
		mv "$EMMC.new" "$EMMC"
	fi
	;;
refresh)
	[ -f "$EMMC" ] || { echo "no virtual eMMC yet: run $0 first" >&2; exit 2; }
	if pgrep -x qemu-system-x86 >/dev/null; then
		echo "close the VM window first (a running disk can't be copied safely)" >&2; exit 1
	fi
	echo "==> new OS image, keeping the data partition (sudo needed for a loop device)"
	if ! sudo env KEEP_DATA_FROM="$EMMC" "$OSDIR/iso/provision-disk.sh" "$EMMC.new"; then
		rm -f "$EMMC.new"; exit 1
	fi
	sudo chown "$(id -u):$(id -g)" "$EMMC.new"
	mv "$EMMC" "$DIR/emmc.before-refresh.img"
	mv "$EMMC.new" "$EMMC"
	;;
install) rm -f "$EMMC"; truncate -s 8G "$EMMC" ;;
*) echo "usage: $0 [start|install|refresh|reset]" >&2; exit 2 ;;
esac

KVM=""
[ -w /dev/kvm ] && KVM="-enable-kvm"
# Cherry Trail Atom: SSE4.2, AES, no AVX. Westmere is the closest stock model.
CPU="Westmere,+aes,+pclmulqdq,+rdrand,+popcnt"
# DISK_BUS=virtio (default) shows the drive as a fast virtual disk (/dev/vda);
# DISK_BUS=sdhci shows it as a real eMMC (/dev/mmcblk0), the 3040's own name, but
# QEMU's SD controller is emulated at only ~2 MB/s, far slower than a real chip.
case "${DISK_BUS:-virtio}" in
virtio) DISK_DEVICE="-device virtio-blk-pci,drive=emmc,serial=LUNAEMMC" ;;
sdhci) DISK_DEVICE="-device sdhci-pci -device sd-card,drive=emmc" ;;
*) echo "DISK_BUS must be virtio or sdhci" >&2; exit 2 ;;
esac
THROTTLE=""
[ "$MODE" = install ] || THROTTLE=",throttling.bps-read=90000000,throttling.bps-write=30000000"

set -- -machine q35 $KVM -cpu "$CPU" -m 1900 -smp 4 -name wyse3040 \
	-monitor unix:"$DIR/monitor.sock",server,nowait \
	-device qemu-xhci,id=xhci \
	-drive if=none,id=emmc,file="$EMMC",format=raw"$THROTTLE" \
	$DISK_DEVICE \
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

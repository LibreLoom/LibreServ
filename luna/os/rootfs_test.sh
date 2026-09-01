#!/bin/sh
# Static checks for Luna OS rootfs wiring (no podman build required).
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="$ROOT/os/build-rootfs.sh"

assert_file_has() {
	file="$1"
	needle="$2"
	msg="$3"
	grep -q "$needle" "$file" || {
		echo "FAIL: $msg (missing '$needle' in $file)" >&2
		exit 1
	}
}

assert_file_lacks() {
	file="$1"
	needle="$2"
	msg="$3"
	if grep -Eq "$needle" "$file"; then
		echo "FAIL: $msg (found '$needle' in $file)" >&2
		exit 1
	fi
}

assert_file_has "$BUILD" 'luna-network-up' "rootfs must ship wired bring-up script"
assert_file_has "$BUILD" 'etc/init.d/luna-network' "rootfs must ship luna-network OpenRC service"
assert_file_has "$BUILD" '/etc/network/interfaces' "rootfs must ship a minimal interfaces file"
# Ethernet-only: rootfs must not ship wpa_supplicant / setup-AP leftovers.
if grep -E 'wpa_supplicant|dnsmasq' "$BUILD" >/dev/null 2>&1; then
	echo "FAIL: Luna OS is Ethernet-only; do not package wpa_supplicant or dnsmasq" >&2
	exit 1
fi
assert_file_has "$BUILD" 'for svc in hwclock modules sysctl hostname bootmisc syslog luna-input luna-network;' \
	"boot runlevel must start luna-input before luna-network"
assert_file_has "$BUILD" 'for svc in devfs dmesg mdev hwdrivers;' \
	"sysinit must enable Alpine hwdrivers coldplug (USB HID at boot)"
assert_file_has "$BUILD" 'modules-load.d/luna-input.conf' "rootfs must ship keyboard module list"
assert_file_has "$BUILD" 'luna-input-up' "rootfs must ship keyboard / HID bring-up script"
assert_file_has "$BUILD" 'usbhid' "rootfs must load usbhid for USB keyboards"
assert_file_has "$BUILD" 'hid-generic' "rootfs must load hid-generic"
assert_file_has "$BUILD" 'evdev' "rootfs must load evdev for /dev/input/event*"
assert_file_has "$BUILD" 'atkbd' "rootfs must load atkbd for PS/2 keyboards"
assert_file_has "$BUILD" ' alpine-base openrc linux-lts kmod ' \
	"rootfs must install kmod so gzipped .ko.gz modules load"
assert_file_has "$BUILD" 'linux-firmware-none' \
	"rootfs must use linux-firmware-none instead of the full firmware meta package"
assert_file_has "$BUILD" 'virtio_net' \
	"rootfs network bring-up must load virtio_net for QEMU / virt guests"
assert_file_has "$BUILD" 'rc_parallel="YES"' \
	"OpenRC must start services in parallel for faster boot"
assert_file_has "$BUILD" 'udhcpc -i "$iface" -q -n -t 3' \
	"boot DHCP must use a short retry budget so OpenRC is not blocked"
assert_file_has "$BUILD" 'after luna-network' \
	"lunad must not wait on avahi before binding HTTP"
assert_file_has "$BUILD" 'makestep 1.0 3' \
	"chrony must step the clock quickly after DHCP for TLS"
assert_file_has "$BUILD" 'tmpfs /tmp' \
	"rootfs must mount /tmp on tmpfs (read-only root slot)"
assert_file_has "$BUILD" 'tmpfs /var/log' \
	"syslog must land on tmpfs so messages do not wear the eMMC"
assert_file_has "$BUILD" 'LABEL=LUNA_DATA /var/lib/luna' \
	"rootfs must mount the data partition at /var/lib/luna"
assert_file_has "$BUILD" 'luna-root-ro.start' \
	"rootfs must remount root read-only + noatime"
assert_file_has "$BUILD" 'luna-run' \
	"rootfs must prefer /var/lib/luna/bin/lunad for daemon OTA"
assert_file_has "$BUILD" 'util-linux' \
	"rootfs must include util-linux (provides fstrim)"
assert_file_has "$BUILD" 'cloudflared' \
	"rootfs must ship cloudflared so Luna Connect tunnels can start"
assert_file_has "$BUILD" 'tty1::respawn:/sbin/getty -f /var/lib/luna/issue' \
	"rootfs must enable tty1 getty with issue file on LUNA_DATA"
assert_file_has "$BUILD" 'luna-pwreset' \
	"rootfs must ship luna-pwreset as the pwreset login shell"
assert_file_has "$BUILD" 'pwreset:x:1001' \
	"rootfs must bake the pwreset Linux account"
assert_file_has "$BUILD" '/usr/local/sbin/luna-pwreset' \
	"pwreset account must use luna-pwreset as its login shell"
assert_file_has "$BUILD" 'luna:x:1000' \
	"rootfs must bake the luna Linux account"
assert_file_has "$BUILD" '/sbin/nologin' \
	"luna console account must use nologin"
assert_file_has "$BUILD" 'root::' \
	"root may keep an empty password hash for local console login"
assert_file_has "$BUILD" '/bin/ash' \
	"root console account must use /bin/ash"
assert_file_has "$BUILD" 'luna:!:' \
	"luna must be locked in the baked shadow (not empty password)"
assert_file_has "$BUILD" 'pwreset::' \
	"pwreset may keep an empty password hash for local recovery login"
assert_file_has "$BUILD" "tail -n 1" \
	"luna-pwreset must capture HTTP code without a temp file"
assert_file_lacks "$BUILD" 'for u in root luna pwreset' \
	"build must not empty passwords for root/luna/pwreset in one loop"
assert_file_lacks "$BUILD" 'exec /bin/sh' \
	"luna-pwreset must exit after success, not exec a shell"
assert_file_lacks "$BUILD" 'openssh|dropbear' \
	"rootfs must not package SSH (console accounts are local only)"

FLASH="$ROOT/os/lib/flash-disk.sh"
assert_file_has "$FLASH" 'rootflags=ro,noatime' \
	"installed kernel cmdline must mount OS slots read-only with noatime"
assert_file_has "$FLASH" 'LUNA_A' \
	"flash must create OS slot A"
assert_file_has "$FLASH" 'LUNA_B' \
	"flash must create OS slot B"
assert_file_has "$FLASH" 'LUNA_DATA' \
	"flash must create the data partition"
assert_file_has "$FLASH" 'luna_boot_ok' \
	"flash GRUB must implement tryboot rollback"

# Only flag an apk install of the meta package, not comments mentioning it.
if grep -E 'apk add' "$BUILD" | grep -qE '(^|[[:space:]])linux-firmware([[:space:]]|$)'; then
	echo "FAIL: do not install the linux-firmware meta package (hundreds of MB of unused blobs)" >&2
	exit 1
fi

if grep 'for svc in .*networking;' "$BUILD" >/dev/null 2>&1; then
	echo "FAIL: stock Alpine networking must not stay in boot runlevel" >&2
	exit 1
fi

if ! grep -q 'hwdrivers' "$BUILD"; then
	echo "FAIL: hwdrivers must be enabled so cold-plugged keyboards bind at boot" >&2
	exit 1
fi

echo "rootfs_test ok"

#!/bin/sh
# Build the Luna OS Alpine rootfs. Requires rootless Podman (pull of alpine).
# Output: dist/luna-rootfs.tar.gz
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# shellcheck source=lib/alpine-image.sh
. "$ROOT/os/lib/alpine-image.sh"
# Pinned for reproducibility; override with digest in CI if needed (e.g. alpine:3.24@sha256:...).
ALPINE_VERSION="${ALPINE_VERSION:-v3.24}"
ARCH="${ARCH:-x86_64}"
WORK="$ROOT/os/work"
ROOTFS="$WORK/rootfs"
OUT="$ROOT/os/dist"
BIN="${LUNAD_BIN:-}"
if [ -z "$BIN" ]; then
    for candidate in         "$ROOT/target/${ARCH}-unknown-linux-musl/release/lunad"         "$ROOT/target/release/lunad"; do
        if [ -x "$candidate" ]; then
            BIN="$candidate"
            break
        fi
    done
fi

if [ -z "$BIN" ] || [ ! -x "$BIN" ]; then
    echo "missing lunad binary" >&2
    echo "build it first: cargo build --release -p lunad (musl) or set LUNAD_BIN" >&2
    exit 1
fi

rm -rf "$WORK" 2>/dev/null || sudo rm -rf "$WORK" || {
	echo "could not clean $WORK (leftover root-owned live-build files?)" >&2
	exit 1
}
mkdir -p "$ROOTFS" "$OUT"

# Assemble the root filesystem inside Alpine's own apk.
# --privileged is required so mkinitfs can mount proc/sys/dev in the chroot
# (rootless Podman otherwise returns "mount: permission denied").
podman run --rm --privileged -v "$ROOTFS:/rootfs:z" "$ALPINE_IMAGE" sh -euc '
    apk add --root /rootfs --initdb --keys-dir /etc/apk/keys --arch '"$ARCH"' \
        --repository "https://dl-cdn.alpinelinux.org/alpine/'"$ALPINE_VERSION"'/main" \
        --repository "https://dl-cdn.alpinelinux.org/alpine/'"$ALPINE_VERSION"'/community" \
        alpine-base openrc linux-lts kmod \
        avahi \
        e2fsprogs exfatprogs ntfs-3g-progs \
        smartmontools syslinux util-linux \
        dhcpcd ca-certificates ssl_client pciutils curl \
        libheif libheif-tools \
        hdparm \
        chrony logrotate

    mkdir -p /rootfs/proc /rootfs/sys /rootfs/dev
    # linux-lts apk trigger already ran mkinitfs. The extra chroot pass
    # needs proc/sys/dev mounts, which rootless Podman often cannot grant.
    if mount -t proc proc /rootfs/proc 2>/dev/null; then
        mount -t sysfs sys /rootfs/sys 2>/dev/null || true
        mount --bind /dev /rootfs/dev 2>/dev/null || true
        chroot /rootfs /sbin/mkinitfs || true
        umount /rootfs/dev /rootfs/sys /rootfs/proc 2>/dev/null || true
    fi

    # Luna keeps its own clock in sync (chrony) so TLS certificate validation
    # and share expiry work even if the RTC drifts. It does not pull updates.
    rm -f /rootfs/etc/apk/repositories
    ln -s /bin/busybox /rootfs/usr/bin/logger 2>/dev/null || true
    apk info --root /rootfs -v | sort > /rootfs/etc/apk-manifest.txt
'

# Lay down Luna OS config (owned files, no secrets).
printf 'Luna\n' > "$ROOTFS/etc/hostname"
printf '127.0.0.1 luna localhost\n::1 luna localhost\n' > "$ROOTFS/etc/hosts"
printf 'hostname="luna"\n' > "$ROOTFS/etc/conf.d/hostname"

# lunad init script
cat > "$ROOTFS/etc/init.d/luna" <<'INIT'
#!/sbin/openrc-run
description="Luna file server"
command="/usr/local/bin/lunad"
command_args=""
command_background="yes"
pidfile="/run/luna.pid"
start_stop_daemon_args="--env LUNA_DATA_DIR=/var/lib/luna --env LUNA_PORT=80"
depend() {
    need localmount
    after avahi-daemon
}
INIT
chmod +x "$ROOTFS/etc/init.d/luna"

# Keyboard / HID bring-up for cold-plugged USB (and PS/2) keyboards.
# Alpine's mdev hotplug loads modules on *new* uevents, so a keyboard
# plugged in after boot often works, but ones present at power-on are
# missed unless hwdrivers + an explicit HID pass run before lunad.
# Password recovery reads /dev/input/event* (see crates/lunad recovery).
mkdir -p "$ROOTFS/etc/modules-load.d"
cat > "$ROOTFS/etc/modules-load.d/luna-input.conf" <<'MODS'
# Core USB HID + evdev (CONFIG_* =m on linux-lts).
usb-common
usbcore
ehci-hcd
ehci-pci
ohci-hcd
ohci-pci
uhci-hcd
xhci-hcd
xhci-pci
xhci-pci-renesas
hid
hid-generic
usbhid
evdev
# Common mini-PC wireless / brand keyboards (same set as the live ISO).
hid-logitech
hid-logitech-dj
hid-logitech-hidpp
hid-apple
hid-cherry
hid-microsoft
hid-lenovo
# PS/2 and platform glue used on thin clients / mini PCs.
atkbd
i8042
serio
libps2
intel-lpss
intel-lpss-pci
pinctrl-intel
pwm-lpss
pwm-lpss-pci
MODS

cat > "$ROOTFS/usr/local/bin/luna-input-up" <<'INIT'
#!/bin/sh
set -eu

# Same ordering as the rapidinstall ISO: USB host, then HID, then PS/2.
for mod in usb-common usbcore \
    ehci-hcd ehci-pci ohci-hcd ohci-pci uhci-hcd \
    xhci-hcd xhci-pci xhci-pci-renesas xhci-plat-hcd \
    dwc3 dwc3-pci \
    intel-lpss intel-lpss-pci mfd-core \
    pinctrl-intel pinctrl-cherryview \
    pwm-lpss pwm-lpss-pci pwm-lpss-platform \
    hid hid-generic usbhid evdev ff-memless \
    hid-logitech hid-logitech-dj hid-logitech-hidpp \
    hid-apple hid-cherry hid-microsoft hid-lenovo hid-corsair \
    atkbd i8042 serio libps2 \
    i2c-core i2c-hid i2c-hid-acpi i2c-i801; do
    modprobe "$mod" 2>/dev/null || true
done

# Re-coldplug USB so keyboards already enumerated before the modules
# loaded get bound and /dev/input/event* nodes appear for lunad.
if [ -d /sys/devices ]; then
    find /sys/devices -name 'usb[0-9]*' 2>/dev/null | while read -r _usb; do
        [ -e "$_usb/uevent" ] && echo add >"$_usb/uevent" 2>/dev/null || true
    done
fi
mdev -s 2>/dev/null || true
INIT
chmod +x "$ROOTFS/usr/local/bin/luna-input-up"

cat > "$ROOTFS/etc/init.d/luna-input" <<'INIT'
#!/sbin/openrc-run
description="Luna keyboard / HID bring-up"
command="/usr/local/bin/luna-input-up"
depend() {
    need localmount
    after modules mdev hwdrivers bootmisc
    before luna
}
INIT
chmod +x "$ROOTFS/etc/init.d/luna-input"

# Wired bring-up: DHCP every non-wireless interface on cable insert / boot.
# Alpine's stock `networking` service requires /etc/network/interfaces; Luna
# ships without a static eth0 name (enp*, eth*, etc.), so we probe sysfs instead.
cat > "$ROOTFS/usr/local/bin/luna-network-up" <<'INIT'
#!/bin/sh
set -eu

# ProDesk / Wyse: drivers are modules, not always autoloaded before we run.
# Wired NICs only — Luna is Ethernet-only (no USB Wi-Fi dongle in the box).
for mod in e1000e igc igb ixgbe r8169 atl1c; do
    modprobe "$mod" 2>/dev/null || true
done

for iface_path in /sys/class/net/*; do
    iface="${iface_path##*/}"
    [ "$iface" = lo ] && continue
    [ -e "$iface_path/wireless" ] || [ -e "$iface_path/phy80211" ] && continue

    ip link set "$iface" up 2>/dev/null || continue

    if ! ip -4 addr show dev "$iface" | grep -q 'inet '; then
        udhcpc -i "$iface" -q -n -t 15 2>/dev/null || true
    fi
done
INIT
chmod +x "$ROOTFS/usr/local/bin/luna-network-up"

cat > "$ROOTFS/etc/init.d/luna-network" <<'INIT'
#!/sbin/openrc-run
description="Luna wired network bring-up"
command="/usr/local/bin/luna-network-up"
depend() {
    need localmount
    after modules bootmisc
    before dns avahi-daemon luna
    provide net
}
INIT
chmod +x "$ROOTFS/etc/init.d/luna-network"

# Minimal interfaces file so ifupdown tools don't error if invoked manually.
mkdir -p "$ROOTFS/etc/network/interfaces.d"
printf 'auto lo\niface lo inet loopback\n' > "$ROOTFS/etc/network/interfaces"
printf 'source /etc/network/interfaces.d/*.conf\n' >> "$ROOTFS/etc/network/interfaces"

mkdir -p "$ROOTFS/etc/runlevels/default" "$ROOTFS/etc/runlevels/boot" "$ROOTFS/etc/runlevels/sysinit"
# hwdrivers: Alpine's coldplug modalias pass. Without it, USB HID present at
# power-on often never loads (hot-plug after boot still works via mdev).
for svc in devfs dmesg mdev hwdrivers; do
    ln -sf "/etc/init.d/$svc" "$ROOTFS/etc/runlevels/sysinit/$svc" 2>/dev/null || true
done
for svc in hwclock modules sysctl hostname bootmisc syslog luna-input luna-network; do
    ln -sf "/etc/init.d/$svc" "$ROOTFS/etc/runlevels/boot/$svc" 2>/dev/null || true
done
for svc in avahi-daemon luna crond chronyd; do
    ln -sf "/etc/init.d/$svc" "$ROOTFS/etc/runlevels/default/$svc" 2>/dev/null || true
done

# Rotate busybox syslog output so the small OS disk never fills up.
cat > "$ROOTFS/etc/logrotate.d/luna" <<'LOGROT'
/var/log/messages {
    weekly
    rotate 4
    compress
    missingok
    notifempty
    copytruncate
}
LOGROT
chmod 644 "$ROOTFS/etc/logrotate.d/luna"

# Install the daemon binary.
install -m 0755 "$BIN" "$ROOTFS/usr/local/bin/lunad"
mkdir -p "$ROOTFS/var/lib/luna"

# Tar inside the container so suid files (e.g. busybox bbsuid) are readable.
# GNU tar (not BusyBox) for --sort=name / --mtime so the archive is deterministic.
podman run --rm --privileged -v "$ROOTFS:/rootfs:z" -v "$OUT:/out:z" "$ALPINE_IMAGE" \
    sh -euc "apk add --no-cache tar >/dev/null && tar --sort=name --mtime=@946684800 --owner=0 --group=0 --numeric-owner -C /rootfs -czf /out/luna-rootfs-$ARCH.tar.gz ."
printf 'built %s\n' "$OUT/luna-rootfs-$ARCH.tar.gz"

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
for mod in e1000e igc igb ixgbe r8169 atl1c virtio_net virtio_pci; do
    modprobe "$mod" 2>/dev/null || true
done

# Ensure loopback interface is active with standard localhost address.
if ip link show lo >/dev/null 2>&1; then
    ip link set lo up 2>/dev/null || true
    if ! ip -4 addr show dev lo 2>/dev/null | grep -q 'inet '; then
        ip addr add 127.0.0.1/8 dev lo brd + 2>/dev/null || true
    fi
fi

for iface_path in /sys/class/net/*; do
    iface="${iface_path##*/}"
    [ "$iface" = lo ] && continue
    [ -e "$iface_path/wireless" ] || [ -e "$iface_path/phy80211" ] && continue

    ip link set "$iface" up 2>/dev/null || continue

    # Short budget so OpenRC is not stuck for ~15s on an unplugged cable.
    # lunad's link watcher retries DHCP after carrier comes up.
    if ! ip -4 addr show dev "$iface" | grep -q 'inet '; then
        udhcpc -i "$iface" -q -n -t 3 2>/dev/null || true
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
for svc in hwclock modules sysctl hostname bootmisc syslog loopback luna-input luna-network; do
    ln -sf "/etc/init.d/$svc" "$ROOTFS/etc/runlevels/boot/$svc" 2>/dev/null || true
done
for svc in avahi-daemon luna crond chronyd; do
    ln -sf "/etc/init.d/$svc" "$ROOTFS/etc/runlevels/default/$svc" 2>/dev/null || true
done

# Keep syslog off the eMMC OS slots: /var/log is tmpfs. Luna state lives on
# the separate LUNA_DATA partition mounted at /var/lib/luna.
cat > "$ROOTFS/etc/fstab" <<'FSTAB'
tmpfs /tmp tmpfs rw,nosuid,nodev,noatime,size=32M,mode=1777 0 0
tmpfs /var/log tmpfs rw,nosuid,nodev,noatime,size=32M,mode=0755 0 0
LABEL=LUNA_DATA /var/lib/luna ext4 defaults,noatime 0 2
FSTAB

# OS image identity for operators/logs (not shown as a Settings split).
printf 'os_release=luna-os\n' > "$ROOTFS/etc/luna-os-release"


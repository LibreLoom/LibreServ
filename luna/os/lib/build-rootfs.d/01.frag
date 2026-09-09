# /var/lib/luna/issue (writable on LUNA_DATA); leave tty2–6 commented.
if [ -f "$ROOTFS/etc/inittab" ]; then
    sed -i -E 's/^[[:space:]]*tty[0-9]+::.*getty/# &/' "$ROOTFS/etc/inittab"
    sed -i -E '/^#?[[:space:]]*tty1::/d' "$ROOTFS/etc/inittab"
    printf 'tty1::respawn:/usr/local/bin/luna-console\n' >> "$ROOTFS/etc/inittab"
fi

# cloudflared is not in Alpine 3.24; official Go binaries are static.
# Pinned download + ELF check live in lib/cloudflared-bake.sh (never a floating latest tag).
# shellcheck source=lib/cloudflared-bake.sh
. "$ROOT/os/lib/cloudflared-bake.sh"
mkdir -p "$ROOTFS/usr/local/bin" "$ROOTFS/usr/local/sbin"
luna_cloudflared_download "$ROOTFS/usr/local/bin/cloudflared" \
    || { echo "error: pinned cloudflared download failed" >&2; exit 1; }

# Prefer a daemon-only OTA binary on the data partition over the image bake.
cat > "$ROOTFS/usr/local/sbin/luna-run" <<'RUN'
#!/bin/sh
if [ -x /var/lib/luna/bin/lunad ]; then
    exec /var/lib/luna/bin/lunad "$@"
fi
exec /usr/local/bin/lunad "$@"
RUN
chmod +x "$ROOTFS/usr/local/sbin/luna-run"

# lunad init script
cat > "$ROOTFS/etc/init.d/luna" <<'INIT'
#!/sbin/openrc-run
description="Luna file server"
command="/usr/local/sbin/luna-run"
command_args=""
command_background="yes"
pidfile="/run/luna.pid"
start_stop_daemon_args="--env LUNA_DATA_DIR=/var/lib/luna --env LUNA_PORT=80 --env PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
depend() {
    need localmount
    # HTTP must not wait on mDNS — avahi can start in parallel.
    after luna-network
}
INIT
chmod +x "$ROOTFS/etc/init.d/luna"

# Parallel OpenRC so luna-input / luna-network / chronyd / avahi / luna overlap.
printf 'rc_parallel="YES"\n' > "$ROOTFS/etc/rc.conf"

# Chrony: step the clock quickly after DHCP so TLS works without delaying HTTP.
mkdir -p "$ROOTFS/etc/chrony"
cat > "$ROOTFS/etc/chrony/chrony.conf" <<'CHRONY'
pool pool.ntp.org iburst
driftfile /var/lib/luna/chrony/drift
makestep 1.0 3
rtcsync
CHRONY
mkdir -p "$ROOTFS/var/lib/luna/chrony"

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
# Modules come from modules-load.d + hwdrivers. This script only re-triggers
# cold-plugged USB so HID devices present at power-on bind to /dev/input.
if [ -d /sys/bus/usb/devices ]; then
    for _uevent in /sys/bus/usb/devices/*/uevent; do
        [ -e "$_uevent" ] && echo add >"$_uevent" 2>/dev/null || true
    done
fi
mdev -s 2>/dev/null || true
INIT
chmod +x "$ROOTFS/usr/local/bin/luna-input-up"

cat > "$ROOTFS/etc/init.d/luna-input" <<'INIT'
#!/sbin/openrc-run

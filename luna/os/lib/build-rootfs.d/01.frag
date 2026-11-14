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

# lunad runs straight from the OS image. There is no daemon on the data
# partition: the whole system is the image, so an update is an OS update and
# the A/B slots are what make it safe. A binary that never changes is not data.
#
# lunad init script
cat > "$ROOTFS/etc/init.d/luna" <<'INIT'
#!/sbin/openrc-run
description="Luna file server"
# supervise-daemon restarts lunad if it crashes. An update replaces the whole
# OS image (A/B slots), so nothing swaps the binary underneath it.
supervisor="supervise-daemon"
command="/usr/local/bin/lunad"
pidfile="/run/luna.pid"
respawn_delay=2
respawn_max=0
respawn_period=60
# lunad logs to stdout; without this the log goes nowhere. It lives on the data
# partition, not the tmpfs /var/log, so what happened before a power cut or a
# crash-and-reboot is still there afterwards. Lunad logs a few lines an hour.
output_log="/var/lib/luna/logs/luna.log"
error_log="/var/lib/luna/logs/luna.log"
supervise_daemon_args="--env LUNA_DATA_DIR=/var/lib/luna --env LUNA_PORT=80 --env PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
depend() {
    need localmount luna-root-ro
    # HTTP must not wait on mDNS — avahi can start in parallel.
    after luna-network
}
start_pre() {
    if ! mountpoint -q /var/lib/luna; then
        eerror "LUNA_DATA is not mounted at /var/lib/luna"
        eerror "Check that the data partition exists and is labelled LUNA_DATA"
        return 1
    fi
    # The data dir holds the device token, the signing key, and the database.
    # Create it owner-only, the way lunad itself insists on.
    mkdir -m 0700 -p /var/lib/luna/logs
    chmod 0700 /var/lib/luna /var/lib/luna/logs
}
INIT
chmod +x "$ROOTFS/etc/init.d/luna"

# Keep Luna's log from filling the 32 MB /var/log tmpfs: rotate hourly by size.
mkdir -p "$ROOTFS/etc/logrotate.d" "$ROOTFS/etc/periodic/hourly"
cat > "$ROOTFS/etc/logrotate.d/luna" <<'LOGROTATE'
/var/lib/luna/logs/luna.log {
    size 2M
    rotate 2
    copytruncate
    missingok
    notifempty
}
LOGROTATE
cat > "$ROOTFS/etc/periodic/hourly/luna-logrotate" <<'HOURLY'
#!/bin/sh
exec /usr/sbin/logrotate /etc/logrotate.conf
HOURLY
chmod +x "$ROOTFS/etc/periodic/hourly/luna-logrotate"

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

# Device-mapper and dm-crypt: without these, `cryptsetup luksOpen` on an
# encrypted drive fails with "device-mapper: reload ioctl failed" on a cold
# boot, so an encrypted drive could never be unlocked after a power-on.
cat > "$ROOTFS/etc/modules-load.d/luna-crypt.conf" <<'MODS'
# Order matters: dm-mod provides the mapper, dm-crypt the target, and the
# cipher/IV modules are loaded on demand by the kernel once dm-crypt is up.
dm-mod
dm-crypt
# aes-xts-plain64 lives here; loading it up front avoids a first-unlock stall.
aes-x86_64
xts
sha256
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

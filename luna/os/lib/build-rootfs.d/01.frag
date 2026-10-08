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

# Run whichever lunad is newer: the daemon-only OTA binary on the data
# partition, or the one baked into this OS image. A stale daemon-only update
# must never shadow a newer OS, so both report `--version` and the higher
# strict-semver wins. If the data-dir one will not run or prints something
# unparseable, the baked one runs. (os/luna_run_test.sh covers the comparison.)
cat > "$ROOTFS/usr/local/sbin/luna-run" <<'RUN'
#!/bin/sh
DATA_LUNAD="${LUNA_RUN_DATA_LUNAD:-/var/lib/luna/bin/lunad}"
BAKED_LUNAD="${LUNA_RUN_BAKED_LUNAD:-/usr/local/bin/lunad}"

# Strict semver 2.0 (no leading v, no leading zeros), numbers of any length.
LUNA_SEMVER_RE='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-((0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(\.(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'

luna_semver_valid() {
    printf '%s\n' "$1" | grep -Eq "$LUNA_SEMVER_RE"
}

# Compare two numbers or identifiers. Prints -1, 0 or 1. Always runs in a
# command substitution, so its variables never leak into the caller.
luna_cmp_ident() {
    ci_a=$1
    ci_b=$2
    if [ "$ci_a" = "$ci_b" ]; then echo 0; return; fi
    ci_an=0
    ci_bn=0
    case $ci_a in *[!0-9]*) ;; *) ci_an=1 ;; esac
    case $ci_b in *[!0-9]*) ;; *) ci_bn=1 ;; esac
    # Digits only: no leading zeros, so a longer number is a bigger one.
    if [ "$ci_an" = 1 ] && [ "$ci_bn" = 1 ] && [ "${#ci_a}" -ne "${#ci_b}" ]; then
        if [ "${#ci_a}" -lt "${#ci_b}" ]; then echo -1; else echo 1; fi
        return
    fi
    # Numbers rank below words.
    if [ "$ci_an" = 1 ] && [ "$ci_bn" = 0 ]; then echo -1; return; fi
    if [ "$ci_an" = 0 ] && [ "$ci_bn" = 1 ]; then echo 1; return; fi
    # Same length digits, or two words: plain ASCII order.
    ci_first=$(printf '%s\n%s\n' "$ci_a" "$ci_b" | LC_ALL=C sort | head -n 1)
    if [ "$ci_first" = "$ci_a" ]; then echo -1; else echo 1; fi
}

# Compare two pre-release strings (the part after "-"; may be empty).
# A release ranks above its own pre-releases.
luna_cmp_pre() {
    cp_a=$1
    cp_b=$2
    if [ "$cp_a" = "$cp_b" ]; then echo 0; return; fi
    if [ -z "$cp_a" ]; then echo 1; return; fi
    if [ -z "$cp_b" ]; then echo -1; return; fi
    while :; do
        cp_r=$(luna_cmp_ident "${cp_a%%.*}" "${cp_b%%.*}")
        if [ "$cp_r" != 0 ]; then echo "$cp_r"; return; fi
        cp_ma=0
        cp_mb=0
        case $cp_a in *.*) cp_a=${cp_a#*.}; cp_ma=1 ;; esac
        case $cp_b in *.*) cp_b=${cp_b#*.}; cp_mb=1 ;; esac
        if [ "$cp_ma" = 0 ] && [ "$cp_mb" = 0 ]; then echo 0; return; fi
        # The shorter list is the lower version.
        if [ "$cp_ma" = 0 ]; then echo -1; return; fi
        if [ "$cp_mb" = 0 ]; then echo 1; return; fi
    done
}

# luna_semver_cmp A B: prints -1, 0 or 1 for A < B, A = B, A > B. Both must
# pass luna_semver_valid. Build metadata (+...) is ignored, as semver says.
luna_semver_cmp() {
    sv_a=${1%%+*}
    sv_b=${2%%+*}
    for sv_side in a b; do
        eval "sv_v=\$sv_$sv_side"
        sv_core=${sv_v%%-*}
        if [ "$sv_core" = "$sv_v" ]; then sv_pre=; else sv_pre=${sv_v#*-}; fi
        sv_rest=${sv_core#*.}
        eval "sv_${sv_side}_maj=\${sv_core%%.*} sv_${sv_side}_min=\${sv_rest%%.*} sv_${sv_side}_pat=\${sv_rest#*.} sv_${sv_side}_pre=\$sv_pre"
    done
    for sv_part in maj min pat; do
        eval "sv_x=\$sv_a_$sv_part sv_y=\$sv_b_$sv_part"
        sv_r=$(luna_cmp_ident "$sv_x" "$sv_y")
        if [ "$sv_r" != 0 ]; then echo "$sv_r"; return; fi
    done
    luna_cmp_pre "$sv_a_pre" "$sv_b_pre"
}

# The version a lunad binary reports, or nothing. An older lunad ignores
# --version and would start serving, so it only gets a few seconds.
luna_binary_version() {
    [ -x "$1" ] || return 1
    command -v timeout >/dev/null 2>&1 || return 1
    bv_line=$(timeout 5 "$1" --version 2>/dev/null | head -n 1) || return 1
    bv_ver=${bv_line##* }
    luna_semver_valid "$bv_ver" || return 1
    printf '%s\n' "$bv_ver"
}

luna_pick_lunad() {
    if [ ! -x "$DATA_LUNAD" ]; then echo "$BAKED_LUNAD"; return; fi
    pick_data=$(luna_binary_version "$DATA_LUNAD") || { echo "$BAKED_LUNAD"; return; }
    pick_baked=$(luna_binary_version "$BAKED_LUNAD") || { echo "$DATA_LUNAD"; return; }
    # Ties go to the baked one: it matches this OS image exactly.
    if [ "$(luna_semver_cmp "$pick_data" "$pick_baked")" = 1 ]; then
        echo "$DATA_LUNAD"
    else
        echo "$BAKED_LUNAD"
    fi
}

[ -n "${LUNA_RUN_SOURCE_ONLY:-}" ] && return 0 2>/dev/null
exec "$(luna_pick_lunad)" "$@"
RUN
chmod +x "$ROOTFS/usr/local/sbin/luna-run"

# lunad init script
cat > "$ROOTFS/etc/init.d/luna" <<'INIT'
#!/sbin/openrc-run
description="Luna file server"
# supervise-daemon restarts lunad if it crashes, and after an update that makes
# it exit so the new binary starts (a lunad-only update just exits).
supervisor="supervise-daemon"
command="/usr/local/sbin/luna-run"
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
    mkdir -p /var/lib/luna/logs
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

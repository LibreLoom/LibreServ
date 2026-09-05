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
    # linux-lts depends on linux-firmware-any. The meta package
    # linux-firmware pulls ~800 MiB of GPU/Wi-Fi blobs we never use
    # (Luna is Ethernet-only). linux-firmware-none satisfies the dep;
    # keep only common wired NIC firmware for mini PCs / thin clients.
    apk add --root /rootfs --initdb --keys-dir /etc/apk/keys --arch '"$ARCH"' \
        --repository "https://dl-cdn.alpinelinux.org/alpine/'"$ALPINE_VERSION"'/main" \
        --repository "https://dl-cdn.alpinelinux.org/alpine/'"$ALPINE_VERSION"'/community" \
        alpine-base openrc linux-lts kmod \
        linux-firmware-none linux-firmware-rtl_nic linux-firmware-e100 \
        avahi \
        e2fsprogs exfatprogs ntfs-3g-progs \
        smartmontools syslinux util-linux \
        dhcpcd ca-certificates ssl_client pciutils curl \
        libheif libheif-tools ffmpeg \
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

# tty1 luna-console for status + shell login (root / luna / pwreset). Device token + IP help is
# /var/lib/luna/issue (writable on LUNA_DATA); leave tty2–6 commented.
if [ -f "$ROOTFS/etc/inittab" ]; then
    sed -i -E 's/^[[:space:]]*tty[0-9]+::.*getty/# &/' "$ROOTFS/etc/inittab"
    sed -i -E '/^#?[[:space:]]*tty1::/d' "$ROOTFS/etc/inittab"
    printf 'tty1::respawn:/usr/local/bin/luna-console\n' >> "$ROOTFS/etc/inittab"
fi

# cloudflared is not in Alpine 3.24; official Go binaries are static.
CLOUDFLARED_VERSION="${CLOUDFLARED_VERSION:-2026.7.3}"
case "$ARCH" in
    aarch64|arm64) _cf_arch=arm64 ;;
    *) _cf_arch=amd64 ;;
esac
mkdir -p "$ROOTFS/usr/local/bin" "$ROOTFS/usr/local/sbin"
curl -fsSL -o "$ROOTFS/usr/local/bin/cloudflared" \
    "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-${_cf_arch}"
chmod 755 "$ROOTFS/usr/local/bin/cloudflared"

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

# Remount root read-only + noatime after localmount (cmdline also passes ro,noatime).
cat > "$ROOTFS/etc/local.d/luna-root-ro.start" <<'NORW'
#!/bin/sh
mount -o remount,ro,noatime / 2>/dev/null || mount -o remount,noatime / 2>/dev/null || true
NORW
chmod +x "$ROOTFS/etc/local.d/luna-root-ro.start"
ln -sf /etc/init.d/local "$ROOTFS/etc/runlevels/default/local" 2>/dev/null || true

# Mark tryboot success once lunad's OpenRC unit is up (best-effort).
cat > "$ROOTFS/etc/local.d/luna-boot-ok.start" <<'BOOTOK'
#!/bin/sh
# Clear GRUB tryboot failure state after a successful boot into this slot.
for _env in /boot/efi/grub/grubenv /efi/grub/grubenv; do
    [ -f "$_env" ] || continue
    if command -v grub-editenv >/dev/null 2>&1; then
        grub-editenv "$_env" set luna_boot_ok=1 2>/dev/null || true
        grub-editenv "$_env" set luna_tries=3 2>/dev/null || true
    fi
done
# ESP is often at /boot/efi only after an extra mount; also try by label.
if command -v grub-editenv >/dev/null 2>&1 && command -v findfs >/dev/null 2>&1; then
    _esp="$(findfs LABEL=LUNAESP 2>/dev/null || true)"
    if [ -n "$_esp" ]; then
        _m="$(mktemp -d /tmp/luna-esp.XXXXXX 2>/dev/null || true)"
        if [ -n "$_m" ] && mount -o rw "$_esp" "$_m" 2>/dev/null; then
            grub-editenv "$_m/grub/grubenv" set luna_boot_ok=1 2>/dev/null || true
            grub-editenv "$_m/grub/grubenv" set luna_tries=3 2>/dev/null || true
            umount "$_m" 2>/dev/null || true
        fi
        rmdir "$_m" 2>/dev/null || true
    fi
fi
BOOTOK
chmod +x "$ROOTFS/etc/local.d/luna-boot-ok.start"

# Install the daemon binary.
install -m 0755 "$BIN" "$ROOTFS/usr/local/bin/lunad"
CONSOLE_BIN="${LUNA_CONSOLE_BIN:-}"
if [ -z "$CONSOLE_BIN" ]; then
    CONSOLE_BIN="$(dirname "$BIN")/luna-console"
fi
if [ ! -x "$CONSOLE_BIN" ]; then
    echo "missing luna-console binary next to lunad ($CONSOLE_BIN)" >&2
    echo "build it first: cargo build --release -p lunad --bin luna-console (musl) or set LUNA_CONSOLE_BIN" >&2
    exit 1
fi
install -m 0755 "$CONSOLE_BIN" "$ROOTFS/usr/local/bin/luna-console"
mkdir -p "$ROOTFS/var/lib/luna"

# Console password reset: Linux user `pwreset` runs this as its login shell.
cat > "$ROOTFS/usr/local/sbin/luna-pwreset" <<'PWRESET'
#!/bin/sh
# Interactive admin password reset. Talks to lunad on loopback only.
echo
echo "Luna recovery"
echo "Reset an admin password, then sign in from a phone or computer."
echo
printf "Admin username: "
read -r _user || exit 1
stty -echo 2>/dev/null || true
printf "New password: "
read -r _pass || { stty echo 2>/dev/null || true; exit 1; }
echo
printf "Type it again: "
read -r _pass2 || { stty echo 2>/dev/null || true; exit 1; }
echo
stty echo 2>/dev/null || true
if [ -z "$_user" ] || [ -z "$_pass" ]; then
	echo "Username and password are required. Nothing was changed."
	exit 1
fi
if [ "$_pass" != "$_pass2" ]; then
	echo "Those didn't match. Nothing was changed."
	exit 1
fi
# Soft client check: Luna rejects weak passwords; fail before curl when empty
# or obviously short so the console stays free of API JSON.
if [ "${#_pass}" -lt 12 ]; then
	echo "Passwords need at least 12 characters with a letter and a number. Nothing was changed."
	exit 1
fi
_port="${LUNA_PORT:-80}"
_url="http://127.0.0.1:${_port}/api/v1/console/reset-password"
_esc() {
	printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}
_body=$(printf '{"username":"%s","password":"%s"}' "$(_esc "$_user")" "$(_esc "$_pass")")
_resp=$(curl -sS -w '\n%{http_code}' -X POST "$_url" \
	-H 'Content-Type: application/json' \
	--data-binary "$_body" 2>/dev/null || printf '\n000')
_code=$(printf '%s' "$_resp" | tail -n 1)
case "$_code" in
200)
	echo "Password updated. Sign in on your phone or computer."
	exit 0
	;;
*)
	echo "Could not reset the password (HTTP ${_code}). Is Luna running?"
	echo "Passwords must meet Luna's rules (12+ characters, letter and number)."
	exit 1
	;;
esac
PWRESET
chmod 755 "$ROOTFS/usr/local/sbin/luna-pwreset"

# Seed console issue file (lunad overwrites with live IP / setup code).
cat > "$ROOTFS/var/lib/luna/issue" <<'ISSUE'

============================================================
  Luna is starting. Open it from a phone or computer on your home internet.
============================================================

ISSUE

# Console accounts (HDMI/USB keyboard only; no SSH).
# `root` and `pwreset` keep an empty password for local tty1 login.
# `luna` stays locked (!). Rootfs is remounted read-only later.
podman run --rm --privileged -v "$ROOTFS:/rootfs:z" "$ALPINE_IMAGE" sh -euc '
    if grep -q "^root:" /rootfs/etc/passwd; then
        sed -i -E "s|^root:([^:]*):([^:]*):([^:]*):([^:]*):([^:]*):[^:]*$|root:\1:\2:\3:\4:\5:/bin/ash|" /rootfs/etc/passwd
    fi
    if ! grep -q "^luna:" /rootfs/etc/passwd; then
        echo "luna:x:1000:1000:Luna:/home/luna:/sbin/nologin" >> /rootfs/etc/passwd
        echo "luna:x:1000:" >> /rootfs/etc/group
        mkdir -p /rootfs/home/luna
        chown 1000:1000 /rootfs/home/luna
    else
        sed -i -E "s|^luna:([^:]*):([^:]*):([^:]*):([^:]*):([^:]*):[^:]*$|luna:\1:\2:\3:\4:\5:/sbin/nologin|" /rootfs/etc/passwd
    fi
    if ! grep -q "^pwreset:" /rootfs/etc/passwd; then
        echo "pwreset:x:1001:1001:Luna recovery:/home/pwreset:/usr/local/sbin/luna-pwreset" >> /rootfs/etc/passwd
        echo "pwreset:x:1001:" >> /rootfs/etc/group
        mkdir -p /rootfs/home/pwreset
        chown 1001:1001 /rootfs/home/pwreset
    fi
    # Empty hash for root and pwreset (blank password login); lock luna.
    if grep -q "^root:" /rootfs/etc/shadow; then
        sed -i -E "s|^root:[^:]*:|root::|" /rootfs/etc/shadow
    else
        echo "root::19000:0:99999:7:::" >> /rootfs/etc/shadow
    fi
    if grep -q "^luna:" /rootfs/etc/shadow; then
        sed -i -E "s|^luna:[^:]*:|luna:!:|" /rootfs/etc/shadow
    else
        echo "luna:!:19000:0:99999:7:::" >> /rootfs/etc/shadow
    fi
    if grep -q "^pwreset:" /rootfs/etc/shadow; then
        sed -i -E "s|^pwreset:[^:]*:|pwreset::|" /rootfs/etc/shadow
    else
        echo "pwreset::19000:0:99999:7:::" >> /rootfs/etc/shadow
    fi
'

# Cloudflare tunnel helper (remote access). Prefer the pinned bake above when it
# already looks complete — never clobber a good binary with a partial "latest"
# download. lunad can also install on demand to {data_dir}/bin/cloudflared.
CF_ARCH=amd64
case "$ARCH" in
    aarch64|arm64) CF_ARCH=arm64 ;;
esac
_cf_baked="$ROOTFS/usr/local/bin/cloudflared"
_cf_size=0
if [ -f "$_cf_baked" ]; then
    _cf_size=$(wc -c < "$_cf_baked" 2>/dev/null || echo 0)
fi
if [ -f "$_cf_baked" ] && [ "$_cf_size" -gt 1024 ]; then
    echo "keeping baked cloudflared ($_cf_size bytes); skip latest refresh"
elif command -v curl >/dev/null 2>&1; then
    _cf_tmp=$(mktemp)
    if curl -fsSL -o "$_cf_tmp" \
        "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${CF_ARCH}"; then
        mv "$_cf_tmp" "$_cf_baked"
        chmod 0755 "$_cf_baked"
    else
        rm -f "$_cf_tmp"
        echo "warning: could not download cloudflared (lunad can also install on demand to data_dir/bin)" >&2
    fi
fi

# Tar inside the container so suid files (e.g. busybox bbsuid) are readable.
# GNU tar (not BusyBox) for --sort=name / --mtime so the archive is deterministic.
podman run --rm --privileged -v "$ROOTFS:/rootfs:z" -v "$OUT:/out:z" "$ALPINE_IMAGE" \
    sh -euc "apk add --no-cache tar >/dev/null && tar --sort=name --mtime=@946684800 --owner=0 --group=0 --numeric-owner -C /rootfs -czf /out/luna-rootfs-$ARCH.tar.gz ."
printf 'built %s\n' "$OUT/luna-rootfs-$ARCH.tar.gz"

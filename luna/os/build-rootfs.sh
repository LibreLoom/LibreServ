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

rm -rf "$WORK"
mkdir -p "$ROOTFS" "$OUT"

# Assemble the root filesystem inside Alpine's own apk.
# --privileged is required so mkinitfs can mount proc/sys/dev in the chroot
# (rootless Podman otherwise returns "mount: permission denied").
podman run --rm --privileged -v "$ROOTFS:/rootfs:z" "$ALPINE_IMAGE" sh -euc '
    apk add --root /rootfs --initdb --keys-dir /etc/apk/keys --arch '"$ARCH"' \
        --repository "https://dl-cdn.alpinelinux.org/alpine/'"$ALPINE_VERSION"'/main" \
        --repository "https://dl-cdn.alpinelinux.org/alpine/'"$ALPINE_VERSION"'/community" \
        alpine-base openrc linux-lts \
        avahi wpa_supplicant hostapd \
        e2fsprogs exfatprogs ntfs-3g-progs \
        smartmontools syslinux util-linux dnsmasq \
        dhcpcd ca-certificates ssl_client \
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

# Link-local fallback: when DHCP gives nothing, Luna still answers on 169.254.42.42.
cat > "$ROOTFS/usr/local/bin/luna-net-fallback" <<'INIT'
#!/bin/sh
# Direct-cable fallback printed on the quick-start card.
iface="${1:-eth0}"
if ! ip -4 addr show dev "$iface" | grep -q 'inet '; then
    ip addr add 169.254.42.42/16 dev "$iface" 2>/dev/null || true
fi
INIT
chmod +x "$ROOTFS/usr/local/bin/luna-net-fallback"

mkdir -p "$ROOTFS/etc/runlevels/default" "$ROOTFS/etc/runlevels/boot" "$ROOTFS/etc/runlevels/sysinit"
for svc in devfs dmesg mdev; do
    ln -sf "/etc/init.d/$svc" "$ROOTFS/etc/runlevels/sysinit/$svc" 2>/dev/null || true
done
for svc in hwclock modules sysctl hostname bootmisc syslog networking; do
    ln -sf "/etc/init.d/$svc" "$ROOTFS/etc/runlevels/boot/$svc" 2>/dev/null || true
done
for svc in avahi-daemon wpa_supplicant luna crond chronyd; do
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

# wpa_supplicant config: Luna's daemon drives it through wpa_cli at runtime.
printf 'ctrl_interface=/run/wpa_supplicant\nupdate_config=1\n' > "$ROOTFS/etc/wpa_supplicant/wpa_supplicant.conf"
chmod 600 "$ROOTFS/etc/wpa_supplicant/wpa_supplicant.conf"

# Install the daemon binary.
install -m 0755 "$BIN" "$ROOTFS/usr/local/bin/lunad"
mkdir -p "$ROOTFS/var/lib/luna"

# Tar inside the container so suid files (e.g. busybox bbsuid) are readable.
# GNU tar (not BusyBox) for --sort=name / --mtime so the archive is deterministic.
podman run --rm --privileged -v "$ROOTFS:/rootfs:z" -v "$OUT:/out:z" "$ALPINE_IMAGE" \
    sh -euc "apk add --no-cache tar >/dev/null && tar --sort=name --mtime=@946684800 --owner=0 --group=0 --numeric-owner -C /rootfs -czf /out/luna-rootfs-$ARCH.tar.gz ."
printf 'built %s\n' "$OUT/luna-rootfs-$ARCH.tar.gz"

#!/bin/sh
# Build the Luna OS Alpine rootfs. Requires rootless Podman (pull of alpine).
# Output: dist/luna-rootfs.tar.gz
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ALPINE_IMAGE="${ALPINE_IMAGE:-docker.io/library/alpine:latest}"
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
podman run --rm -v "$ROOTFS:/rootfs:z" "$ALPINE_IMAGE" sh -euc '
    apk add --root /rootfs --initdb --keys-dir /etc/apk/keys --arch '"$ARCH"' \
        --repository "https://dl-cdn.alpinelinux.org/alpine/'"$ALPINE_VERSION"'/main" \
        --repository "https://dl-cdn.alpinelinux.org/alpine/'"$ALPINE_VERSION"'/community" \
        alpine-base openrc \
        avahi wpa_supplicant hostapd bluez \
        e2fsprogs exfatprogs ntfs-3g-progs \
        smartmontools syslinux util-linux dnsmasq \
        dhcpcd ca-certificates ssl_client \
        hdparm

    # Luna never talks to NTP or package servers by default.
    rm -f /rootfs/etc/apk/repositories
    ln -s /bin/busybox /rootfs/usr/bin/logger 2>/dev/null || true
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
for svc in avahi-daemon wpa_supplicant luna; do
    ln -sf "/etc/init.d/$svc" "$ROOTFS/etc/runlevels/default/$svc" 2>/dev/null || true
done

# wpa_supplicant config: Luna's daemon drives it through wpa_cli at runtime.
printf 'ctrl_interface=/run/wpa_supplicant\nupdate_config=1\n' > "$ROOTFS/etc/wpa_supplicant/wpa_supplicant.conf"
chmod 600 "$ROOTFS/etc/wpa_supplicant/wpa_supplicant.conf"

# Install the daemon binary.
install -m 0755 "$BIN" "$ROOTFS/usr/local/bin/lunad"
mkdir -p "$ROOTFS/var/lib/luna"

# Tar inside the container so suid files (e.g. busybox bbsuid) are readable.
podman run --rm -v "$ROOTFS:/rootfs:z" -v "$OUT:/out:z" "$ALPINE_IMAGE" \
    sh -euc "tar -C /rootfs -czf /out/luna-rootfs-$ARCH.tar.gz ."
printf 'built %s\n' "$OUT/luna-rootfs-$ARCH.tar.gz"

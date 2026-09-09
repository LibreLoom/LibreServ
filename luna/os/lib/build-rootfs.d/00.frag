#!/bin/sh
# Build the Luna OS Alpine rootfs. Requires rootless Podman (pull of alpine).
# Output: dist/luna-rootfs.tar.gz
set -eu

ROOT="${ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
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

# tty1 luna-console for status + shell login (root / luna). Device token + IP help is

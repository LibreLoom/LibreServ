#!/bin/sh
# Luna OS rootfs, assembled INSIDE the build container (build/Containerfile.os).
# Never calls podman. Inputs: lunad + luna-console (LUNAD_BIN, LUNA_CONSOLE_BIN),
# ROOT = the luna/ directory (only os/ is read). Output: the tree at ROOTFS,
# a podman volume mounted at /rootfs, so file ownership stays correct in the
# user namespace and nothing ever needs root on the host.
set -eu

ROOT="${ROOT:-/luna}"
ARCH="${ARCH:-x86_64}"
ALPINE_VERSION="${ALPINE_VERSION:-v3.24}"
ROOTFS="${ROOTFS:-/rootfs}"
BIN="${LUNAD_BIN:-}"

if [ -z "$BIN" ] || [ ! -x "$BIN" ]; then
    echo "missing lunad binary (set LUNAD_BIN to its path inside the container)" >&2
    exit 1
fi

# The volume itself is the mount point: empty it, keep the directory.
mkdir -p "$ROOTFS"
find "$ROOTFS" -mindepth 1 -maxdepth 1 -exec rm -rf {} +

# Assemble the root filesystem with Alpine's own apk.
# linux-lts depends on linux-firmware-any. The meta package linux-firmware
# pulls ~800 MiB of GPU/Wi-Fi blobs we never use (Luna is Ethernet-only).
# linux-firmware-none satisfies the dep; keep only common wired NIC firmware
# for mini PCs / thin clients. NTFS drives use the ntfs3 kernel driver from
# linux-lts, not ntfs-3g.
# grub is here for grub-editenv only: lunad sets the A/B tryboot slot in the
# ESP grubenv, and luna-boot-ok clears it. The bootloader itself is installed
# by the rapidinstall ISO.
# The grub post-install trigger runs grub-probe against whatever disk the
# build host boots from and is useless here, so a trigger error is tolerated;
# the check below still fails the build if any package did not install.
# The linux-lts trigger builds /boot/initramfs-lts itself (no proc/sys mounts
# needed), so there is no extra chroot mkinitfs pass.
APK_CACHE=""
if [ -d "${LUNA_CACHE_DIR:-/nonexistent}" ]; then
    mkdir -p "$LUNA_CACHE_DIR/apk"
    APK_CACHE="--cache-dir $LUNA_CACHE_DIR/apk"
fi
# shellcheck disable=SC2086
apk add --root "$ROOTFS" --initdb --keys-dir /etc/apk/keys --arch "$ARCH" $APK_CACHE \
    --repository "https://dl-cdn.alpinelinux.org/alpine/$ALPINE_VERSION/main" \
    --repository "https://dl-cdn.alpinelinux.org/alpine/$ALPINE_VERSION/community" \
    alpine-base openrc linux-lts kmod \
    linux-firmware-none linux-firmware-rtl_nic linux-firmware-e100 \
    avahi \
    e2fsprogs e2fsprogs-extra exfatprogs \
    smartmontools syslinux util-linux \
    grub \
    dhcpcd ca-certificates ssl_client pciutils curl \
    libheif libheif-tools ffmpeg \
    hdparm \
    chrony logrotate || echo "apk reported errors; verifying installed packages" >&2
for _p in alpine-base openrc linux-lts grub chrony ffmpeg; do
    apk info --root "$ROOTFS" -e "$_p" >/dev/null || { echo "package $_p did not install" >&2; exit 1; }
done
# Every helper program lunad shells out to must be in the image. An OS update
# needs tune2fs and e2label (Alpine ships them in e2fsprogs-extra); without them
# the update fails after the new system is already written.
for _b in tune2fs e2label e2fsck grub-editenv mkfs.exfat wipefs sfdisk partprobe blkid blockdev smartctl ffmpeg ffprobe heif-dec curl timeout logrotate findmnt; do
    _have=0
    for _d in sbin usr/sbin bin usr/bin; do
        if [ -e "$ROOTFS/$_d/$_b" ] || [ -L "$ROOTFS/$_d/$_b" ]; then _have=1; break; fi
    done
    [ "$_have" = 1 ] || { echo "the OS image is missing the program $_b that Luna needs" >&2; exit 1; }
done
# A slot without kernel + initramfs cannot boot: fail here, not on the device.
for _f in boot/vmlinuz-lts boot/initramfs-lts; do
    [ -s "$ROOTFS/$_f" ] || { echo "missing $_f in the rootfs (kernel trigger did not run)" >&2; exit 1; }
done

mkdir -p "$ROOTFS/proc" "$ROOTFS/sys" "$ROOTFS/dev"
# Rootless apk cannot mknod, so it leaves a plain empty file where /dev/null
# goes. The kernel mounts devtmpfs over /dev at boot; drop the stray file.
rm -f "$ROOTFS/dev/null"

# Luna keeps its own clock in sync (chrony) so TLS certificate validation
# and share expiry work even if the RTC drifts. It does not pull updates.
rm -f "$ROOTFS/etc/apk/repositories"
ln -s /bin/busybox "$ROOTFS/usr/bin/logger" 2>/dev/null || true
apk info --root "$ROOTFS" -v | sort > "$ROOTFS/etc/apk-manifest.txt"

# Lay down Luna OS config (owned files, no secrets).
printf 'Luna\n' > "$ROOTFS/etc/hostname"
printf '127.0.0.1 luna localhost\n::1 luna localhost\n' > "$ROOTFS/etc/hosts"
printf 'hostname="luna"\n' > "$ROOTFS/etc/conf.d/hostname"

# The root is read-only, so DNS lives in /run (tmpfs): udhcpc's script writes
# RESOLV_CONF, and /etc/resolv.conf is the path every resolver reads.
# luna-network-up seeds /run/resolv.conf when DHCP leaves it without servers.
mkdir -p "$ROOTFS/etc/udhcpc"
printf 'RESOLV_CONF=/run/resolv.conf\n' >> "$ROOTFS/etc/udhcpc/udhcpc.conf"
rm -f "$ROOTFS/etc/resolv.conf"
ln -s /run/resolv.conf "$ROOTFS/etc/resolv.conf"

# tty1 luna-console for status + shell login (root / luna). Device token + IP help is

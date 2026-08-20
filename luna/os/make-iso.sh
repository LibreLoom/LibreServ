#!/bin/sh
# Build a BIOS-hybrid rapidinstall ISO.
# Boot the USB on the thin client; the installer writes Luna to eMMC
# (/dev/mmcblk0), not to the USB stick.
#
# Needs: rootfs tarball from build-rootfs.sh, rootless Podman.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
ALPINE_IMAGE="${ALPINE_IMAGE:-docker.io/library/alpine:latest}"
ALPINE_VERSION="${ALPINE_VERSION:-v3.24}"
ARCH="${ARCH:-x86_64}"
OUT="$ROOT/os/dist"
WORK="$ROOT/os/work/iso"
ISOROOT="$WORK/tree"
TARBALL="$OUT/luna-rootfs-$ARCH.tar.gz"
ISO="$OUT/luna-rapidinstall-$ARCH.iso"

[ -f "$TARBALL" ] || {
	echo "missing $TARBALL — run os/build-rootfs.sh first" >&2
	exit 2
}

rm -rf "$WORK"
mkdir -p "$ISOROOT/boot" "$ISOROOT/isolinux" "$ISOROOT/lib" "$OUT"

cp "$ROOT/os/iso/init" "$WORK/init"
cp "$ROOT/os/iso/isolinux.cfg" "$ISOROOT/isolinux/isolinux.cfg"
cp "$ROOT/os/rapidinstall.sh" "$ISOROOT/rapidinstall.sh"
cp "$ROOT/os/lib/disk.sh" "$ISOROOT/lib/disk.sh"
cp "$ROOT/os/lib/flash-disk.sh" "$ISOROOT/lib/flash-disk.sh"
chmod +x "$ISOROOT/rapidinstall.sh" "$WORK/init"
cp "$TARBALL" "$ISOROOT/luna-rootfs-$ARCH.tar.gz"

podman run --rm \
	-v "$ISOROOT:/iso:z" \
	-v "$WORK/init:/init.in:ro,z" \
	"$ALPINE_IMAGE" sh -euc "
apk add --no-cache linux-lts busybox util-linux e2fsprogs syslinux xorriso cpio gzip \
	kmod findutils tar \
	--repository https://dl-cdn.alpinelinux.org/alpine/${ALPINE_VERSION}/main \
	--repository https://dl-cdn.alpinelinux.org/alpine/${ALPINE_VERSION}/community

KVER=\$(ls /lib/modules | head -1)
if [ -f /boot/vmlinuz-lts ]; then
	cp /boot/vmlinuz-lts /iso/boot/vmlinuz
else
	cp /boot/vmlinuz-* /iso/boot/vmlinuz
fi

IRD=/tmp/initrd
rm -rf \"\$IRD\"
mkdir -p \"\$IRD/dev\" \"\$IRD/proc\" \"\$IRD/sys\" \"\$IRD/src\" \"\$IRD/tmp\" \"\$IRD/run\"
apk add --root \"\$IRD\" --initdb --no-scripts --keys-dir /etc/apk/keys --arch ${ARCH} \
	--repository https://dl-cdn.alpinelinux.org/alpine/${ALPINE_VERSION}/main \
	--repository https://dl-cdn.alpinelinux.org/alpine/${ALPINE_VERSION}/community \
	busybox musl util-linux util-linux-misc sfdisk e2fsprogs syslinux kmod

mkdir -p \"\$IRD/lib/modules/\$KVER\"
if [ -d /lib/modules/\$KVER ]; then
	cp -a /lib/modules/\$KVER/modules.* \"\$IRD/lib/modules/\$KVER/\" 2>/dev/null || true
	for sub in kernel/drivers/usb kernel/drivers/mmc kernel/drivers/scsi \
		kernel/drivers/ata kernel/drivers/nvme kernel/drivers/cdrom \
		kernel/drivers/block kernel/fs/isofs kernel/fs/ext4 kernel/fs/jbd2 \
		kernel/fs/nls kernel/lib; do
		if [ -d /lib/modules/\$KVER/\$sub ]; then
			mkdir -p \"\$IRD/lib/modules/\$KVER/\$(dirname \$sub)\"
			cp -a /lib/modules/\$KVER/\$sub \"\$IRD/lib/modules/\$KVER/\$(dirname \$sub)/\"
		fi
	done
	depmod -b \"\$IRD\" \"\$KVER\" 2>/dev/null || true
fi

cp /init.in \"\$IRD/init\"
chmod +x \"\$IRD/init\"
mkdir -p \"\$IRD/bin\"
if [ -f \"\$IRD/bin/busybox\" ]; then
	ln -sf busybox \"\$IRD/bin/sh\"
fi

( cd \"\$IRD\" && find . | cpio -o -H newc ) | gzip -9 > /iso/boot/initramfs

cp /usr/share/syslinux/isolinux.bin /iso/isolinux/
cp /usr/share/syslinux/ldlinux.c32 /iso/isolinux/
if [ -f /usr/share/syslinux/isohdpfx.bin ]; then
	cp /usr/share/syslinux/isohdpfx.bin /iso/isolinux/
fi
cp /usr/share/syslinux/mbr.bin /iso/mbr.bin
"

podman run --rm \
	-v "$ISOROOT:/iso:z" \
	-v "$OUT:/out:z" \
	"$ALPINE_IMAGE" sh -euc "
apk add --no-cache xorriso syslinux
MBR=/usr/share/syslinux/isohdpfx.bin
[ -f /iso/isolinux/isohdpfx.bin ] && MBR=/iso/isolinux/isohdpfx.bin
xorriso -as mkisofs \
	-o /out/luna-rapidinstall-${ARCH}.iso \
	-V LUNAINST \
	-isohybrid-mbr \"\$MBR\" \
	-c isolinux/boot.cat \
	-b isolinux/isolinux.bin \
	-no-emul-boot -boot-load-size 4 -boot-info-table \
	/iso
"

printf 'built %s\n' "$ISO"
printf 'Write to USB: dd if=%s of=/dev/sdX bs=4M status=progress conv=fsync\n' "$ISO"
printf 'Then boot the thin client from that USB; installer targets eMMC.\n'

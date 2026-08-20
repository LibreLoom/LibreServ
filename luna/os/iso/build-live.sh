#!/bin/sh
# Runs inside Alpine (podman) to assemble the rapidinstall ISO tree:
# kernel, initramfs (installer + GRUB + disk tools), UEFI GRUB images,
# BIOS isolinux.
set -eu

ALPINE_VERSION="${ALPINE_VERSION:-v3.24}"
ARCH="${ARCH:-x86_64}"

apk add --no-cache linux-lts busybox util-linux e2fsprogs syslinux xorriso cpio gzip \
	kmod findutils tar dosfstools mtools \
	--repository "https://dl-cdn.alpinelinux.org/alpine/${ALPINE_VERSION}/main" \
	--repository "https://dl-cdn.alpinelinux.org/alpine/${ALPINE_VERSION}/community"
# grub's post-install probe fails on overlayfs; we only need the binaries.
apk add --no-cache --no-scripts grub grub-efi \
	--repository "https://dl-cdn.alpinelinux.org/alpine/${ALPINE_VERSION}/main" \
	--repository "https://dl-cdn.alpinelinux.org/alpine/${ALPINE_VERSION}/community"

KVER="$(ls /lib/modules | head -1)"
if [ -f /boot/vmlinuz-lts ]; then
	cp /boot/vmlinuz-lts /iso/boot/vmlinuz
else
	cp /boot/vmlinuz-* /iso/boot/vmlinuz
fi

IRD=/tmp/initrd
rm -rf "$IRD"
mkdir -p "$IRD/dev" "$IRD/proc" "$IRD/sys" "$IRD/src" "$IRD/tmp" "$IRD/run"
apk add --root "$IRD" --initdb --no-scripts --keys-dir /etc/apk/keys --arch "$ARCH" \
	--repository "https://dl-cdn.alpinelinux.org/alpine/${ALPINE_VERSION}/main" \
	--repository "https://dl-cdn.alpinelinux.org/alpine/${ALPINE_VERSION}/community" \
	busybox musl util-linux util-linux-misc sfdisk e2fsprogs dosfstools \
	syslinux kmod
apk add --root "$IRD" --no-scripts --keys-dir /etc/apk/keys --arch "$ARCH" \
	--repository "https://dl-cdn.alpinelinux.org/alpine/${ALPINE_VERSION}/main" \
	--repository "https://dl-cdn.alpinelinux.org/alpine/${ALPINE_VERSION}/community" \
	grub grub-efi

mkdir -p "$IRD/lib/modules/$KVER"
if [ -d "/lib/modules/$KVER" ]; then
	cp -a /lib/modules/"$KVER"/modules.* "$IRD/lib/modules/$KVER/" 2>/dev/null || true
	for sub in kernel/drivers/usb kernel/drivers/mmc kernel/drivers/scsi \
		kernel/drivers/ata kernel/drivers/nvme kernel/drivers/cdrom \
		kernel/drivers/block kernel/drivers/pinctrl kernel/drivers/acpi \
		kernel/drivers/platform kernel/drivers/net/phy \
		kernel/fs/isofs kernel/fs/ext4 kernel/fs/jbd2 kernel/fs/nls kernel/fs/fat \
		kernel/fs/vfat kernel/lib; do
		if [ -d "/lib/modules/$KVER/$sub" ]; then
			mkdir -p "$IRD/lib/modules/$KVER/$(dirname "$sub")"
			cp -a "/lib/modules/$KVER/$sub" "$IRD/lib/modules/$KVER/$(dirname "$sub")/"
		fi
	done
	depmod -b "$IRD" "$KVER" 2>/dev/null || true
fi

cp /init.in "$IRD/init"
chmod +x "$IRD/init"
mkdir -p "$IRD/bin"
if [ -f "$IRD/bin/busybox" ]; then
	ln -sf busybox "$IRD/bin/sh"
fi

(cd "$IRD" && find . | cpio -o -H newc) | gzip -9 >/iso/boot/initramfs

# BIOS CD boot (unused on Wyse 3040, kept for bench PCs)
mkdir -p /iso/isolinux /iso/boot/grub
cp /usr/share/syslinux/isolinux.bin /iso/isolinux/
cp /usr/share/syslinux/ldlinux.c32 /iso/isolinux/
if [ -f /usr/share/syslinux/isohdpfx.bin ]; then
	cp /usr/share/syslinux/isohdpfx.bin /iso/isolinux/
fi
cp /usr/share/syslinux/mbr.bin /iso/mbr.bin 2>/dev/null || true

# UEFI: standalone GRUB (x64 + ia32 for Cherry Trail 32-bit firmware).
cat >/iso/boot/grub/grub.cfg <<'CFG'
set timeout=2
search --file --set=root /boot/vmlinuz
linux /boot/vmlinuz quiet
initrd /boot/initramfs
CFG

echo "==> GRUB EFI"
GRUB_MODS="iso9660 fat ext2 part_gpt part_msdos normal linux configfile search search_fs_file echo gzio"
grub-mkstandalone -O x86_64-efi -o /tmp/BOOTX64.EFI \
	--install-modules="$GRUB_MODS" --locales="" --fonts="" \
	"boot/grub/grub.cfg=/iso/boot/grub/grub.cfg"

# EFI System partition image El Torito boots from.
dd if=/dev/zero of=/iso/boot/grub/efi.img bs=1M count=8 status=none
mkfs.vfat -n LUNAUEFI /iso/boot/grub/efi.img >/dev/null
mmd -i /iso/boot/grub/efi.img ::EFI ::EFI/BOOT
mcopy -i /iso/boot/grub/efi.img /tmp/BOOTX64.EFI ::EFI/BOOT/BOOTX64.EFI
if [ -f /tmp/BOOTIA32.EFI ]; then
	mcopy -i /iso/boot/grub/efi.img /tmp/BOOTIA32.EFI ::EFI/BOOT/BOOTIA32.EFI
fi
# Also on the ISO9660 tree so firmware that scans the USB ESP can find it.
mkdir -p /iso/EFI/BOOT
cp /tmp/BOOTX64.EFI /iso/EFI/BOOT/BOOTX64.EFI
if [ -f /tmp/BOOTIA32.EFI ]; then
	cp /tmp/BOOTIA32.EFI /iso/EFI/BOOT/BOOTIA32.EFI
fi
echo "==> live tree ready"

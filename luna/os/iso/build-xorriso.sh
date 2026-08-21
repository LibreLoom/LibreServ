#!/bin/sh
# Runs inside Alpine to wrap the ISO tree as a BIOS+UEFI hybrid.
set -eu
ARCH="${ARCH:-x86_64}"

apk add --no-cache xorriso syslinux
MBR=/usr/share/syslinux/isohdpfx.bin
[ -f /iso/isolinux/isohdpfx.bin ] && MBR=/iso/isolinux/isohdpfx.bin

xorriso -as mkisofs \
	-o "/out/luna-rapidinstall-${ARCH}.iso" \
	-R -J \
	-V LUNAINST \
	-isohybrid-mbr "$MBR" \
	-c isolinux/boot.cat \
	-b isolinux/isolinux.bin \
	-no-emul-boot -boot-load-size 4 -boot-info-table \
	-eltorito-alt-boot \
	-e boot/grub/efi.img \
	-no-emul-boot \
	-isohybrid-gpt-basdat \
	/iso

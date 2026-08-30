#!/bin/sh
# Remaster a BIOS-only Luna rapidinstall ISO into a BIOS+UEFI hybrid.
# Ubuntu live-build 3.x only emits isolinux; ProDesk/Wyse UEFI firmware needs
# an El Torito EFI image + GPT protective partition (isohybrid-gpt-basdat).
#
# Usage: add-uefi-boot.sh <input.iso> <output.iso>
set -eu

die() {
	echo "ERROR: $*" >&2
	exit 1
}

IN="${1:-}"
OUT="${2:-}"
[ -n "$IN" ] && [ -f "$IN" ] || die "usage: $0 <input.iso> <output.iso>"
[ -n "$OUT" ] || die "usage: $0 <input.iso> <output.iso>"

command -v xorriso >/dev/null 2>&1 || die "xorriso required"
command -v grub-mkimage >/dev/null 2>&1 || die "grub-mkimage required (grub-efi-amd64-bin)"
command -v mkfs.vfat >/dev/null 2>&1 || die "mkfs.vfat required (dosfstools)"
command -v mmd >/dev/null 2>&1 || die "mmd required (mtools)"

ISOHDPFX=""
for _c in /usr/lib/ISOLINUX/isohdpfx.bin /usr/lib/syslinux/isohdpfx.bin; do
	if [ -f "$_c" ]; then
		ISOHDPFX="$_c"
		break
	fi
done
[ -n "$ISOHDPFX" ] || die "isohdpfx.bin missing (isolinux / syslinux)"

GRUB_EFI_DIR=""
for _d in /usr/lib/grub/x86_64-efi; do
	if [ -f "$_d/moddep.lst" ]; then
		GRUB_EFI_DIR="$_d"
		break
	fi
done
[ -n "$GRUB_EFI_DIR" ] || die "GRUB x86_64-efi modules missing"

# Match auto/config --bootappend-live (without the isolinux 'config' noise).
LIVE_APPEND='boot=live text nomodeset console=tty0 net.ifnames=0 biosdevname=0 init=/usr/lib/luna-installer/init.sh'

WORK="$(mktemp -d)"
cleanup() {
	# ISO extract may preserve root-owned live-build files; force writable then wipe.
	chmod -R u+w "$WORK" 2>/dev/null || true
	rm -rf "$WORK" 2>/dev/null || true
}
trap cleanup EXIT INT

ROOT="$WORK/root"
mkdir -p "$ROOT"
echo "==> extracting ISO for UEFI remaster"
xorriso -osirrox on:auto_chmod_on -indev "$IN" -extract / "$ROOT" >/dev/null 2>&1 \
	|| die "could not extract $IN"
# live-build / prior remasters can leave root-owned or mode-0444 trees.
chmod -R u+w "$ROOT" 2>/dev/null || true

[ -f "$ROOT/isolinux/isolinux.bin" ] || die "ISO missing isolinux (BIOS) bootloader"
[ -f "$ROOT/live/vmlinuz" ] || die "ISO missing /live/vmlinuz"
[ -f "$ROOT/live/initrd.img" ] || die "ISO missing /live/initrd.img"

mkdir -p "$ROOT/boot/grub" "$WORK/efi/EFI/BOOT" "$ROOT/EFI/BOOT"

echo "==> building UEFI GRUB (BOOTX64.EFI)"
# Embed enough modules that /boot/grub/grub.cfg can load the live kernel.
grub-mkimage \
	-O x86_64-efi \
	-o "$WORK/efi/EFI/BOOT/BOOTX64.EFI" \
	-p /boot/grub \
	-d "$GRUB_EFI_DIR" \
	all_video boot cat chain configfile echo efi_gop efi_uga fat font \
	gfxterm gzio halt iso9660 linux loadenv ls lsefi normal part_gpt \
	part_msdos probe reboot regexp search search_fs_file search_fs_uuid \
	search_label sleep test true video \
	|| die "grub-mkimage failed"

# Visible EFI tree on the ISO (some firmwares / USB tools look here first).
cp "$WORK/efi/EFI/BOOT/BOOTX64.EFI" "$ROOT/EFI/BOOT/BOOTX64.EFI"

cat >"$ROOT/boot/grub/grub.cfg" <<EOF
set timeout=2
set default=0
insmod all_video
insmod gfxterm
insmod iso9660
insmod part_gpt
insmod part_msdos
terminal_output gfxterm
# UEFI hybrid boots often start with \$root on the small ESP FAT (efi.img),
# which has no /live/. Find the ISO9660 volume that holds the live kernel.
search --no-floppy --set=root --file /live/vmlinuz
menuentry "Luna rapidinstall" {
	linux /live/vmlinuz $LIVE_APPEND
	initrd /live/initrd.img
}
menuentry "Luna rapidinstall (failsafe)" {
	linux /live/vmlinuz $LIVE_APPEND memtest noapic noapm nodma nomce nolapic nosmp
	initrd /live/initrd.img
}
EOF

# FAT ESP image that firmware finds via El Torito + GPT basdat.
# Size: GRUB EFI binary is ~1 MiB; 4 MiB leaves room for growth.
EFI_IMG="$ROOT/boot/grub/efi.img"
rm -f "$EFI_IMG"
truncate -s 4M "$EFI_IMG"
mkfs.vfat -F 12 -n LUNAUEFI "$EFI_IMG" >/dev/null
mmd -i "$EFI_IMG" ::/EFI
mmd -i "$EFI_IMG" ::/EFI/BOOT
mcopy -i "$EFI_IMG" "$WORK/efi/EFI/BOOT/BOOTX64.EFI" ::/EFI/BOOT/BOOTX64.EFI
# Also drop grub.cfg inside the ESP so some firmwares that only mount the
# EFI image still show a menu (prefix may differ; ISO path remains primary).
mcopy -i "$EFI_IMG" "$ROOT/boot/grub/grub.cfg" ::/EFI/BOOT/grub.cfg

# Writable factory FAT (LUNAASSETS): TOKENS magazine + later device photos.
# ISO9660 is read-only after dd; this appended partition is mountable rw.
echo "==> building empty LUNAASSETS partition (256 MiB FAT)"
ASSETS_IMG="$WORK/lunaassets.img"
rm -f "$ASSETS_IMG"
truncate -s 256M "$ASSETS_IMG"
mkfs.vfat -F 32 -n LUNAASSETS "$ASSETS_IMG" >/dev/null \
	|| die "mkfs.vfat LUNAASSETS failed"

echo "==> writing BIOS+UEFI hybrid ISO (+ LUNAASSETS)"
TMP_OUT="$WORK/out.iso"
xorriso -as mkisofs \
	-r -J -joliet-long \
	-V LUNAINST \
	-A "Luna rapidinstall" \
	-isohybrid-mbr "$ISOHDPFX" \
	-partition_offset 16 \
	-c isolinux/boot.cat \
	-b isolinux/isolinux.bin \
	-no-emul-boot \
	-boot-load-size 4 \
	-boot-info-table \
	-eltorito-alt-boot \
	-e boot/grub/efi.img \
	-no-emul-boot \
	-isohybrid-gpt-basdat \
	-append_partition 3 0x0c "$ASSETS_IMG" \
	-o "$TMP_OUT" \
	"$ROOT" \
	|| die "xorriso remaster failed"

# Verify El Torito reports an EFI path before publishing.
xorriso -indev "$TMP_OUT" -report_el_torito as_mkisofs 2>&1 | grep -q -- '-e ' \
	|| die "remastered ISO has no EFI El Torito boot image"
xorriso -indev "$TMP_OUT" -find / -name 'efi.img' 2>&1 | grep -q efi.img \
	|| die "remastered ISO missing /boot/grub/efi.img"

cp "$TMP_OUT" "$OUT"
printf 'UEFI+BIOS hybrid (+ LUNAASSETS) written to %s\n' "$OUT"

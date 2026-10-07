#!/bin/sh
# Rapidinstall ISO, IN-CONTAINER step (runs inside build/Containerfile.iso).
# Never calls podman or sudo, and needs no root on the host.
#
#   in:  OSDIR   (/luna/os, read-only) installer scripts, package lists, hooks
#        PAYLOAD (/payload, read-only) must hold luna-os-x86_64.img.xz and its
#                .sha256; eurooffice-pack.tar.zst and drawio-pack.tar.zst
#                (+ .sha256) are included when present
#        CACHE   (/cache, optional volume) apt downloads + the finished live
#                system, reused while its inputs are unchanged
#   out: OUT/luna-rapidinstall-x86_64.iso   BIOS+UEFI hybrid, volume LUNAINST
#   env: ARCH SUITE DEBIAN_MIRROR XZ_THREADS LUNA_LIVE_REFRESH (forces a rebuild
#        of the cached live system, e.g. to pick up Debian updates)
set -eu

OSDIR="${OSDIR:-/luna/os}"
PAYLOAD="${PAYLOAD:-/payload}"
OUT="${OUT:-/out}"
CACHE="${CACHE:-/cache}"
ARCH="${ARCH:-x86_64}"
SUITE="${SUITE:-bookworm}"
MIRROR="${DEBIAN_MIRROR:-http://deb.debian.org/debian}"
THREADS="${XZ_THREADS:-$(nproc)}"
WORK="${WORK:-/build}"
DL="$OSDIR/debian-live/config"
ISO="$OUT/luna-rapidinstall-$ARCH.iso"
IMG="luna-os-$ARCH.img.xz"

# What find-media.sh and the installer rely on (see README: kernel line).
LIVE_APPEND='boot=live text nomodeset console=tty0 net.ifnames=0 biosdevname=0 init=/usr/lib/luna-installer/init.sh'
VOLID=LUNAINST

die() {
	echo "ERROR: $*" >&2
	exit 1
}

[ -s "$PAYLOAD/$IMG" ] || die "missing $PAYLOAD/$IMG: build the OS image first"
[ -s "$PAYLOAD/$IMG.sha256" ] || die "missing $PAYLOAD/$IMG.sha256"
# The installer trusts this file; make sure it describes exactly these bytes.
_want="$(awk '{print $1; exit}' "$PAYLOAD/$IMG.sha256")"
_have="$(sha256sum "$PAYLOAD/$IMG" | awk '{print $1}')"
[ "$_want" = "$_have" ] || die "$IMG does not match its .sha256"

mkdir -p "$OUT" "$WORK"
rm -rf "$WORK/iso"
mkdir -p "$WORK/iso/live" "$WORK/iso/boot/grub" "$WORK/iso/luna/lib"

# --- the live system (cached while its inputs are unchanged) ----------------
pkglist() {
	sed 's/#.*//' "$@" | awk 'NF { print $1 }' | sort -u
}
PKGS="$(pkglist "$DL"/package-lists/*.list.chroot | tr '\n' ',' | sed 's/,$//')"

KEY="$(
	{
		printf 'suite=%s mirror=%s refresh=%s\n' "$SUITE" "$MIRROR" "${LUNA_LIVE_REFRESH:-}"
		printf 'pkgs=%s\n' "$PKGS"
		(cd "$OSDIR" && find debian-live/config iso/find-media.sh build/iso-customize.sh -type f | LC_ALL=C sort |
			while read -r f; do printf '%s %s\n' "$f" "$(sha256sum <"$f" | awk '{print $1}')"; done)
	} | sha256sum | awk '{print substr($1, 1, 16)}'
)"
LIVE_CACHE="$CACHE/live-$KEY"
if [ -s "$LIVE_CACHE/filesystem.squashfs" ] && [ -s "$LIVE_CACHE/vmlinuz" ] && [ -s "$LIVE_CACHE/initrd.img" ]; then
	echo "==> live system: reusing cached build $KEY"
	cp "$LIVE_CACHE/filesystem.squashfs" "$WORK/iso/live/filesystem.squashfs"
	cp "$LIVE_CACHE/vmlinuz" "$WORK/iso/live/vmlinuz"
	cp "$LIVE_CACHE/initrd.img" "$WORK/iso/live/initrd.img"
else
	echo "==> live system: mmdebstrap $SUITE"
	CHROOT="$WORK/chroot"
	rm -rf "$CHROOT"
	APT_CACHE="$CACHE/apt"
	mkdir -p "$APT_CACHE"
	# --mode=root: this container is its own user namespace, so "root" here
	# is the invoking user on the host. apt downloads are synced in and out
	# of the cache volume so a rebuild does not fetch them again.
	mmdebstrap --mode=root --variant=minbase \
		--architectures=amd64 \
		--components="main contrib non-free non-free-firmware" \
		--aptopt='APT::Install-Recommends "false"' \
		--aptopt='Acquire::Languages "none"' \
		--include="linux-image-amd64,xz-utils,$PKGS" \
		--setup-hook='mkdir -p "$1/var/cache/apt/archives"' \
		--setup-hook="sync-in $APT_CACHE /var/cache/apt/archives" \
		--customize-hook="$OSDIR/build/iso-customize.sh \"\$1\"" \
		--customize-hook="sync-out /var/cache/apt/archives $APT_CACHE" \
		"$SUITE" "$CHROOT" "$MIRROR"

	_k="$(ls "$CHROOT"/boot/vmlinuz-* | sort | tail -n 1)"
	_i="$(ls "$CHROOT"/boot/initrd.img-* | sort | tail -n 1)"
	[ -f "$_k" ] && [ -f "$_i" ] || die "the live system has no kernel or initramfs"
	cp "$_k" "$WORK/iso/live/vmlinuz"
	cp "$_i" "$WORK/iso/live/initrd.img"
	# Without live-boot inside the initramfs, boot=live finds nothing.
	if command -v lsinitramfs >/dev/null 2>&1; then
		lsinitramfs "$WORK/iso/live/initrd.img" | grep -q 'scripts/live' \
			|| die "live-boot is missing from the initramfs"
	fi

	echo "==> live system: squashfs"
	mksquashfs "$CHROOT" "$WORK/iso/live/filesystem.squashfs" \
		-comp xz -b 1M -Xbcj x86 -processors "$THREADS" -no-progress -noappend \
		-wildcards -e 'boot/vmlinuz-*' -e 'boot/initrd.img-*' -e 'var/cache/apt/archives/*.deb' >/dev/null
	rm -rf "$CHROOT"

	mkdir -p "$LIVE_CACHE"
	for f in filesystem.squashfs vmlinuz initrd.img; do
		cp "$WORK/iso/live/$f" "$LIVE_CACHE/$f.tmp" && mv "$LIVE_CACHE/$f.tmp" "$LIVE_CACHE/$f"
	done
	# Keep only the newest cached live system.
	for d in "$CACHE"/live-*; do
		[ "$d" = "$LIVE_CACHE" ] || rm -rf "$d"
	done
fi

# --- the Luna payload at /luna ----------------------------------------------
echo "==> Luna payload"
LUNA="$WORK/iso/luna"
install -m 0755 "$OSDIR/rapidinstall.sh" "$LUNA/rapidinstall.sh"
for f in disk.sh flash-disk.sh console.sh factory-assets.sh; do
	install -m 0644 "$OSDIR/lib/$f" "$LUNA/lib/$f"
done
chmod 0755 "$LUNA/lib/flash-disk.sh"
# The big files are grafted from the payload directory instead of copied.
GRAFTS="$WORK/grafts"
: >"$GRAFTS"
for f in "$IMG" "$IMG.sha256" eurooffice-pack.tar.zst eurooffice-pack.tar.zst.sha256 \
	drawio-pack.tar.zst drawio-pack.tar.zst.sha256; do
	if [ -f "$PAYLOAD/$f" ]; then
		printf -- '-map %s /luna/%s\n' "$PAYLOAD/$f" "$f" >>"$GRAFTS"
	else
		case "$f" in
		eurooffice-pack.tar.zst)
			echo "WARNING: no $f in $PAYLOAD: installed devices will lack office editing." >&2
			;;
		drawio-pack.tar.zst)
			echo "WARNING: no $f in $PAYLOAD: installed devices will lack diagram editing." >&2
			;;
		esac
	fi
done

# --- boot menu --------------------------------------------------------------
cat >"$WORK/iso/boot/grub/grub.cfg" <<GRUBCFG
set timeout=2
set default=0
insmod iso9660
insmod part_gpt
insmod part_msdos
# Hand the kernel a framebuffer on UEFI (no VGA text mode there): without a
# video driver GRUB says "booting in blind mode" and the screen stays empty.
if [ "\$grub_platform" = "efi" ]; then
	insmod all_video
	insmod efi_gop
	insmod efi_uga
	set gfxpayload=keep
fi
# Plain VGA text console: gfxterm without a font file in the ISO renders
# nothing on firmware whose GOP handling differs from QEMU's.
terminal_output console
# UEFI hybrid boots often start with \$root on the small ESP FAT, which has no
# /live/. Find the ISO9660 volume that holds the live kernel.
search --no-floppy --set=root --file /live/vmlinuz
menuentry "Luna rapidinstall" {
	linux /live/vmlinuz $LIVE_APPEND
	initrd /live/initrd.img
}
menuentry "Luna rapidinstall (failsafe)" {
	linux /live/vmlinuz $LIVE_APPEND memtest noapic noapm nodma nomce nolapic nosmp
	initrd /live/initrd.img
}
GRUBCFG

# --- hybrid ISO -------------------------------------------------------------
# Writable factory FAT (LUNAASSETS): the TOKENS magazine + later device photos.
# ISO9660 is read-only after dd; this appended partition is mountable rw.
ASSETS="$WORK/lunaassets.img"
rm -f "$ASSETS"
truncate -s 256M "$ASSETS"
mkfs.vfat -F 32 -n LUNAASSETS "$ASSETS" >/dev/null

echo "==> hybrid ISO (BIOS + UEFI)"
TMP_ISO="$OUT/.luna-rapidinstall-$ARCH.iso.tmp"
rm -f "$TMP_ISO" "$ISO"
# grub-mkrescue adds the BIOS El Torito image, the EFI image and the hybrid
# MBR/GPT; everything after -- goes to xorriso. It puts its EFI partition at
# 2, so LUNAASSETS is partition 3, as before.
# Everything after -- is native xorriso syntax; -map adds the big payload files
# from the payload directory instead of copying them into the tree first.
# shellcheck disable=SC2046
grub-mkrescue -o "$TMP_ISO" --product-name="Luna rapidinstall" \
	"$WORK/iso" \
	-- -volid "$VOLID" -application_id "Luna rapidinstall" -joliet on \
	-append_partition 3 0x0c "$ASSETS" \
	$(tr '\n' ' ' <"$GRAFTS") >"$WORK/mkrescue.log" 2>&1 \
	|| { tail -30 "$WORK/mkrescue.log" >&2; die "grub-mkrescue failed"; }

mv -f "$TMP_ISO" "$ISO"
printf 'built %s (%s bytes, volume %s)\n' "$ISO" "$(wc -c <"$ISO" | tr -d ' ')" "$VOLID"

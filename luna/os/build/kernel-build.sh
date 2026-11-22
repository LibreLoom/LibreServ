#!/bin/sh
# Build the kernel a Luna slot boots from, INSIDE build/Containerfile.os.
# Never calls podman or sudo.
#
# Why Luna builds its own: the slot boots without an initramfs, so the kernel
# has to find and mount the root filesystem itself. That needs the storage path
# (libata/AHCI, sd, NVMe, mmc, USB storage, virtio-blk) built into the kernel
# instead of loaded from an initramfs. Alpine's linux-lts package ships them as
# modules, so its config is taken as the starting point — every driver a Luna
# box might have stays available — and only the boot path is switched to
# built-in.
#
#   out: /out/vmlinuz-lts, /out/modules/<uname -r>
#   env: JOBS (default: all cores)
set -eu
KERNEL_VERSION=6.18.64
KERNEL_SHA256=020d45510c539972e6f14c5c71566878d3b7ef56fb082b3e09134f2ebaade562
JOBS="${JOBS:-$(nproc)}"

if [ "$(uname -m)" != x86_64 ]; then
	echo "error: the Luna kernel is built on an x86_64 host, not $(uname -m)" >&2
	exit 1
fi
for _t in gcc make bc bison flex bash ld.bfd objcopy tar xz curl; do
	command -v "$_t" >/dev/null || { echo "error: kernel build needs $_t" >&2; exit 1; }
done

# Alpine's own kernel config is the base: it is the same one the package was
# built from, so nothing a Luna box could need is dropped by accident. The
# Containerfile copies it out of the package into /alpine-boot.
_cfg="$(ls /alpine-boot/config-* /boot/config-* 2>/dev/null | head -1)"
[ -n "$_cfg" ] || { echo "error: no Alpine kernel config in /alpine-boot or /boot" >&2; exit 1; }
_kv="$(basename "$_cfg" | sed 's/^config-//')"
case "$_kv" in
"$KERNEL_VERSION"-*) ;;
*)
	echo "error: Alpine ships kernel $_kv, this build is pinned to $KERNEL_VERSION; bump KERNEL_VERSION and KERNEL_SHA256 here when the Alpine pin moves" >&2
	exit 1
	;;
esac
# module tree name (uname -r) of the kernel being built
_lv="$(printf '%s' "$_kv" | sed "s/^$KERNEL_VERSION//")"

w="$(mktemp -d)"
trap 'rm -rf "$w"' EXIT
# The source comes from kernel.org, pinned: the config is Alpine's, the tree is
# upstream's, and a moving target is not allowed.
_src="linux-$KERNEL_VERSION.tar.xz"
echo "==> kernel $KERNEL_VERSION source"
curl -fsSL --retry 3 -o "$w/$_src" "https://cdn.kernel.org/pub/linux/kernel/v$(echo "$KERNEL_VERSION" | cut -d. -f1).x/$_src"
echo "$KERNEL_SHA256  $w/$_src" | sha256sum -c - >/dev/null || {
	echo "error: kernel source does not match KERNEL_SHA256" >&2
	exit 1
}
tar -xf "$w/$_src" -C "$w"
cd "$w/linux-$KERNEL_VERSION"

cp "$_cfg" .config
# Boot path built in, everything else left as Alpine ships it. A driver that is
# built in is also still loadable by name (modprobe finds it in modules.builtin).
./scripts/config --file .config \
	-e SCSI -e SCSI_MOD -e BLK_DEV_SD \
	-e ATA -e ATA_PIIX -e SATA_AHCI \
	-e VIRTIO -e VIRTIO_PCI -e VIRTIO_BLK -e SCSI_VIRTIO \
	-e NVME_CORE -e BLK_DEV_NVME \
	-e MMC -e MMC_BLOCK -e MMC_SDHCI -e MMC_SDHCI_PCI -e MMC_SDHCI_ACPI \
	-e EXT4_FS \
	-e USB -e USB_XHCI_HCD -e USB_EHCI_HCD -e USB_STORAGE -e USB_UAS \
	--set-str MODULE_SIG_KEY certs/signing_key.pem
# Nothing in the image reads debug data: the crash path is lunad's own log, not
# a symbolized backtrace, and build/validate-rootfs.sh refuses to ship a
# System.map. Dropping it roughly halves the build.
./scripts/config --file .config \
	-d DEBUG_INFO -d DEBUG_INFO_BTF -d DEBUG_INFO_BTF_MODULES \
	-e DEBUG_INFO_NONE
make -s ARCH=x86_64 olddefconfig

# The whole point of this build: prove the boot path is not a module.
for _s in SCSI BLK_DEV_SD ATA SATA_AHCI EXT4_FS VIRTIO_BLK VIRTIO_PCI \
	BLK_DEV_NVME NVME_CORE MMC_BLOCK USB_STORAGE USB_XHCI_HCD; do
	grep -q "^CONFIG_$_s=y$" .config \
		|| { echo "error: CONFIG_$_s is not built into the kernel" >&2; exit 1; }
done

echo "==> kernel $KERNEL_VERSION$_lv: bzImage + modules (jobs $JOBS)"
make -j"$JOBS" ARCH=x86_64 LOCALVERSION="$_lv" bzImage modules
rm -rf /out/modroot
mkdir -p /out/modroot
# INSTALL_MOD_STRIP=1 strips the debug data the size check would otherwise carry
# into every download.
make -s -j"$JOBS" ARCH=x86_64 LOCALVERSION="$_lv" \
	INSTALL_MOD_PATH=/out/modroot INSTALL_MOD_STRIP=1 modules_install
mkdir -p /out
rm -rf /out/modules /out/vmlinuz-lts
cp arch/x86/boot/bzImage /out/vmlinuz-lts
mv /out/modroot/lib/modules /out/modules
rm -rf /out/modroot
printf '%s\n' "$KERNEL_VERSION$_lv" > /out/kernel-release
echo "KERNEL_OK $(cat /out/kernel-release)"

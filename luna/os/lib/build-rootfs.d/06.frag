# Trim the finished image down to what an appliance boots.
# The storage-only initramfs keeps the installer’s broad root-disk support;
# runtime modules, kernel debug maps, and vendor editor builds that Luna never
# loads are trimmed independently.

# The kernel Luna ships. build/kernel-build.sh built it from Alpine's linux-lts
# config with the common boot storage path switched to built-in. Kernel and
# modules must come from that one build (a module only loads into the kernel it
# was built with), so the tree the apk installed is replaced whole.
[ -s /kout/vmlinuz-lts ] || { echo "error: no kernel in /kout: the kernel stage of build/Containerfile.os did not run" >&2; exit 1; }
_kv="$(basename "$(ls -d /kout/modules/* 2>/dev/null | head -1)")"
[ -n "$_kv" ] || { echo "error: no kernel modules in /kout" >&2; exit 1; }
rm -rf "$ROOTFS"/lib/modules/*
cp /kout/vmlinuz-lts "$ROOTFS/boot/vmlinuz-lts"
cp -a /kout/modules/"$_kv" "$ROOTFS/lib/modules/$_kv"

# Build the initramfs before trimming runtime modules. The common SATA/NVMe/
# MMC/USB/virtio path is built into the kernel; these features carry the other
# root-capable storage drivers in Alpine's module tree, including RAID/HBA,
# PCIe block and FireWire disks. Keeping this image small is not worth letting
# the installer erase a disk the installed system cannot boot.
mkdir -p "$ROOTFS/etc/mkinitfs/features.d"
cat > "$ROOTFS/etc/mkinitfs/features.d/luna-storage.modules" <<'EOF'
kernel/drivers/block/*
kernel/drivers/firewire/*
EOF
: > "$ROOTFS/dev/null"
if ! chroot "$ROOTFS" /sbin/mkinitfs -q \
    -F 'base ata ext4 mmc nvme raid scsi usb virtio luna-storage' \
    -o /boot/initramfs-lts "$_kv"; then
    rm -f "$ROOTFS/dev/null"
    echo "error: could not build the storage initramfs" >&2
    exit 1
fi
rm -f "$ROOTFS/dev/null"

# Kernel debug artifacts. Nothing on the box reads them: the crash path is
# lunad's own log, not a symbolized vmlinux backtrace.
rm -f "$ROOTFS"/boot/System.map-* "$ROOTFS"/boot/config-*

# Kernel modules for hardware a Luna box cannot have. Luna is a headless,
# wired appliance: no GPU (the console is text), no sound card, no webcam, no
# Wi-Fi/Bluetooth radio, no Fibre Channel or iSCSI HBA, no InfiniBand. Every
# wired NIC driver, every filesystem a user's drive may carry, the AHCI/NVMe/
# USB storage paths and virtio all stay; the check below proves it.
KV="$(ls "$ROOTFS/lib/modules" | head -1)"
[ -n "$KV" ] || { echo "error: no kernel module tree under $ROOTFS/lib/modules" >&2; exit 1; }
KMOD="$ROOTFS/lib/modules/$KV/kernel"
for _d in \
    drivers/gpu drivers/media drivers/infiniband drivers/bluetooth \
    drivers/net/wireless \
    drivers/net/arcnet drivers/net/can drivers/net/dsa drivers/net/fddi \
    drivers/net/hamradio drivers/net/ieee802154 drivers/net/ppp \
    drivers/net/slip drivers/net/team drivers/net/wan drivers/net/wwan \
    drivers/net/appletalk \
    drivers/accel drivers/vfio drivers/pcmcia drivers/parport drivers/uio \
    drivers/gnss drivers/pps drivers/mtd \
    drivers/scsi/aacraid drivers/scsi/advansys drivers/scsi/arcmsr \
    drivers/scsi/be2iscsi drivers/scsi/bfa drivers/scsi/bnx2fc \
    drivers/scsi/csiostor drivers/scsi/cxlflash drivers/scsi/esas2r \
    drivers/scsi/fcoe drivers/scsi/hpsa drivers/scsi/iscsi \
    drivers/scsi/lpfc drivers/scsi/megaraid drivers/scsi/mpi3mr \
    drivers/scsi/mpt3sas drivers/scsi/mvsas drivers/scsi/nsp32 \
    drivers/scsi/pm8001 drivers/scsi/qedf \
    drivers/scsi/qedi drivers/scsi/qla2xxx drivers/scsi/qla4xxx \
    drivers/scsi/smartpqi drivers/scsi/snic drivers/scsi/sym53c8xx_2 \
    drivers/scsi/ufs drivers/scsi/virtio_scsi \
    fs/9p fs/afs fs/ceph fs/gfs2 fs/jffs2 fs/nfs \
    fs/nfsd fs/nilfs2 fs/ocfs2 fs/orangefs fs/pstore fs/smb fs/ubifs \
    net/bluetooth net/mac80211 net/wireless \
    sound; do
    [ -d "$KMOD/$_d" ] || continue
    rm -rf "$KMOD/$_d"
done
# Rewrite the index the modules came with, so modprobe never chases a file
# that is no longer there.
depmod -b "$ROOTFS" -a "$KV"
# The kernel carries the boot storage path inside itself, and the rest of what
# Luna needs must still be there as modules. Either answer counts: a driver the
# kernel has built in is in modules.builtin, the others are in the index.
_BUILTIN="$ROOTFS/lib/modules/$KV/modules.builtin"
for _m in e1000 e1000e igc r8169 virtio_net ahci sd_mod sr_mod ext4 exfat \
    vfat nls_cp437 nls_utf8 usb_storage xhci_hcd hid_generic usbhid evdev \
    virtio_blk virtio_pci dm_crypt xts sha256; do
	if ! grep -q "/$_m\.ko$" "$_BUILTIN" 2>/dev/null; then
		modprobe -S "$KV" -d "$ROOTFS" --dry-run "$_m" >/dev/null 2>&1 \
			|| { echo "error: kernel module $_m is gone" >&2; exit 1; }
	fi
done

# Vendor editor builds Luna can never load, because Luna never serves the page
# that would load them: the editors run from Luna's own React wrapper, which
# loads sdk-all-min.js (minified, in validate-rootfs.sh's required list) and
# never the unminified sdk-all.js; nothing on the box is Internet Explorer, so
# the _ie.js engines are dead weight; the photo editor is not shipped at all,
# so is its monaco-for-ie copy; and the per-app mobile directories are the
# vendor's phone web-apps, not Luna's UI.
EO="$ROOTFS/usr/share/luna/eurooffice"
rm -f "$EO"/sdkjs/*/sdk-all.js \
    "$EO"/sdkjs/pdf/src/engine/drawingfile_ie.js \
    "$EO"/sdkjs/common/libfont/engine/fonts_ie.js
rm -rf "$EO"/web-apps/vendor/monaco/monaco-for-ie "$EO"/web-apps/apps/*/mobile

#!/bin/sh
# Build-time contract for the complete appliance, also checked before packing.
# Run inside the rootless OS build container, never on the running appliance.
set -eu
ROOTFS="${1:?rootfs directory required}"
fail() { echo "incomplete Luna image: $*" >&2; exit 1; }
for f in boot/vmlinuz-lts \
    usr/local/bin/lunad usr/local/bin/luna-console usr/local/bin/cloudflared usr/local/bin/luna-clip \
    usr/share/luna/eurooffice/web-apps/apps/api/documents/api.js \
    usr/share/luna/eurooffice/x2t/x2t.js usr/share/luna/eurooffice/x2t/x2t.wasm \
    usr/share/luna/eurooffice/sdkjs/word/sdk-all-min.js \
    usr/share/luna/eurooffice/sdkjs/cell/sdk-all-min.js \
    usr/share/luna/eurooffice/sdkjs/slide/sdk-all-min.js \
    usr/share/luna/drawio/pack.json usr/share/luna/drawio/index.html \
    usr/share/luna/models/potion-base-8M/model.safetensors \
    usr/share/luna/models/potion-base-8M/tokenizer.json \
    usr/share/luna/models/tinyclip/image.onnx usr/share/luna/models/tinyclip/text.onnx \
    usr/share/luna/models/tinyclip/tokenizer.json; do
    [ -s "$ROOTFS/$f" ] || fail "missing $f"
done
[ -d "$ROOTFS/usr/share/luna/eurooffice/fonts" ] || fail 'missing office fonts'
# The live installer supports a broad range of root disks. The storage initramfs
# must carry the controllers that are not built into the kernel, or installation
# could erase a disk the installed system cannot discover.
_initfs_list="$(mktemp)"
_initfs_cpio="$(mktemp)"
trap 'rm -f "$_initfs_list" "$_initfs_cpio"' EXIT
gzip -dc "$ROOTFS/boot/initramfs-lts" > "$_initfs_cpio" \
    || fail 'the storage initramfs cannot be decompressed'
chroot "$ROOTFS" /bin/busybox cpio -t < "$_initfs_cpio" > "$_initfs_list" \
    || fail 'the storage initramfs cannot be read'
KV="$(ls "$ROOTFS/lib/modules" | head -1)"
for _driver in aacraid hpsa megaraid_sas mpt3sas vmw_pvscsi smartpqi mtip32xx firewire-sbp2; do
    if ! grep -q "/$_driver\.ko" "$_initfs_list" \
        && ! grep -q "/$_driver\.ko$" "$ROOTFS/lib/modules/$KV/modules.builtin" 2>/dev/null; then
        fail "the storage initramfs cannot boot a disk that needs $_driver"
    fi
done
# The image runs no SSH server, so nothing may be advertised over mDNS except
# the box's own name. Alpine's avahi package ships ssh/sftp-ssh service files.
for svc in "$ROOTFS"/etc/avahi/services/*.service; do
    [ -e "$svc" ] || continue
    fail "mDNS advertises $(basename "$svc"), a service the image does not run"
done
# Resolve commands inside the target tree. Host existence checks accept broken
# absolute symlinks and cannot establish that dynamic libraries are installed.
# Redirect outside chroot: the target /dev is populated only when it boots.
chroot "$ROOTFS" /bin/sh -eu -c '
    for b in acpid tune2fs e2label e2fsck grub-editenv mkfs.exfat wipefs sfdisk \
        partprobe blkid blockdev smartctl ffmpeg ffprobe heif-dec curl timeout \
        logrotate findmnt cryptsetup mkfs.ext4 fsck.exfat fsck.fat pdftotext pdftoppm \
        tesseract fstrim findfs lsblk mount umount reboot; do
        command -v "$b" || exit 1
    done
    /usr/local/bin/lunad --version
    /usr/local/bin/cloudflared --version
    ffmpeg -version
    pdftotext -v
    tesseract --version
' >/dev/null || fail 'a required program cannot run in the target filesystem'
# Load both ONNX encoders against the libraries in the image, then EOF exits
# the runner. This catches mismatched ONNX Runtime and missing shared libraries.
for mode in image text; do
    ready="$(chroot "$ROOTFS" /usr/bin/timeout 60 /usr/local/bin/luna-clip \
        "/usr/share/luna/models/tinyclip/$mode.onnx" "$mode" </dev/null)" \
        || fail "photo search $mode encoder cannot load"
    [ "$ready" = R ] || fail "photo search $mode encoder did not become ready"
done
# The mounted data partition starts empty; software must never be seeded here.
for name in bin eurooffice drawio models; do
    [ ! -e "$ROOTFS/var/lib/luna/$name" ] || fail "software on data partition: $name"
done
echo 'Luna image contents and runtime dependencies verified'

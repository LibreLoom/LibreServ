#!/bin/sh
# Build-time contract for the complete appliance, also checked before packing.
# Run inside the rootless OS build container, never on the running appliance.
set -eu
ROOTFS="${1:?rootfs directory required}"
fail() { echo "incomplete Luna image: $*" >&2; exit 1; }
for f in boot/vmlinuz-lts boot/initramfs-lts \
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
# Resolve commands inside the target tree. Host existence checks accept broken
# absolute symlinks and cannot establish that dynamic libraries are installed.
chroot "$ROOTFS" /bin/sh -eu -c '
    for b in acpid tune2fs e2label e2fsck grub-editenv mkfs.exfat wipefs sfdisk \
        partprobe blkid blockdev smartctl ffmpeg ffprobe heif-dec curl timeout \
        logrotate findmnt cryptsetup mkfs.ext4 fsck.exfat pdftotext pdftoppm \
        tesseract fstrim findfs lsblk mount umount reboot; do
        command -v "$b" >/dev/null || exit 1
    done
    /usr/local/bin/lunad --version
    /usr/local/bin/cloudflared --version
    ffmpeg -version >/dev/null
    pdftotext -v
    tesseract --version
' || fail 'a required program cannot run in the target filesystem'
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

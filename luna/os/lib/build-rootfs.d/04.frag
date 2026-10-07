    echo "root::19000:0:99999:7:::" >> "$ROOTFS"/etc/shadow
fi
if grep -q "^luna:" "$ROOTFS"/etc/shadow; then
    sed -i -E "s|^luna:[^:]*:|luna:!:|" "$ROOTFS"/etc/shadow
else
    echo "luna:!:19000:0:99999:7:::" >> "$ROOTFS"/etc/shadow
fi

# Cloudflare tunnel helper (remote access). Prefer the pinned bake above when it
# already looks complete — never refresh from a floating latest tag.
# shellcheck source=lib/cloudflared-bake.sh
. "$ROOT/os/lib/cloudflared-bake.sh"
luna_cloudflared_ensure "$ROOTFS/usr/local/bin/cloudflared" || true

# Empty data mountpoint, no Luna state in the image (a dirty rootfs volume
# must never leak files into /var/lib/luna).
mkdir -p "$ROOTFS/var/lib/luna"
find "$ROOTFS/var/lib/luna" -mindepth 1 -maxdepth 1 ! -name chrony -exec rm -rf {} +
mkdir -p "$ROOTFS/var/lib/luna/chrony"
printf 'rootfs ready in %s\n' "$ROOTFS"

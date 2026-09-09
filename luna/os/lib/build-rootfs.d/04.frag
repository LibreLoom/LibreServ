        echo "root::19000:0:99999:7:::" >> /rootfs/etc/shadow
    fi
    if grep -q "^luna:" /rootfs/etc/shadow; then
        sed -i -E "s|^luna:[^:]*:|luna:!:|" /rootfs/etc/shadow
    else
        echo "luna:!:19000:0:99999:7:::" >> /rootfs/etc/shadow
    fi
'

# Cloudflare tunnel helper (remote access). Prefer the pinned bake above when it
# already looks complete — never refresh from a floating latest tag.
# shellcheck source=lib/cloudflared-bake.sh
. "$ROOT/os/lib/cloudflared-bake.sh"
luna_cloudflared_ensure "$ROOTFS/usr/local/bin/cloudflared" || true

# Tar inside the container so suid files (e.g. busybox bbsuid) are readable.
# GNU tar (not BusyBox) for --sort=name / --mtime so the archive is deterministic.
podman run --rm --privileged -v "$ROOTFS:/rootfs:z" -v "$OUT:/out:z" "$ALPINE_IMAGE" \
    sh -euc "apk add --no-cache tar >/dev/null && tar --sort=name --mtime=@946684800 --owner=0 --group=0 --numeric-owner -C /rootfs -czf /out/luna-rootfs-$ARCH.tar.gz ."
printf 'built %s\n' "$OUT/luna-rootfs-$ARCH.tar.gz"

#!/bin/sh
# Source this helper, then call libreloom_install_tailscale DEST ARCH.
# Use upstream static binaries instead of an older distro package. These
# SHA-256 values come from the matching pkgs.tailscale.com .tgz.sha256 files.
TAILSCALE_BAKE_VERSION="1.104.2"
TAILSCALE_BAKE_SHA_AMD64="512f613ed7d04fc7282f7dc5bd76aa105aae28168fbb9357eb749ebcbc29f0ae"
TAILSCALE_BAKE_SHA_ARM64="5776aaa901b5ef1916e66be5bb54b9f481cd399c9c28db123a8cab620efa237b"

libreloom_install_tailscale() (
    set -eu
    ts_dest="$1"
    case "$2" in
        x86_64|amd64) ts_arch=amd64; ts_sha="$TAILSCALE_BAKE_SHA_AMD64" ;;
        aarch64|arm64) ts_arch=arm64; ts_sha="$TAILSCALE_BAKE_SHA_ARM64" ;;
        *) echo "unsupported Tailscale architecture: $2" >&2; exit 1 ;;
    esac
    ts_tmp="$(mktemp -d /tmp/libreloom-tailscale.XXXXXX)"
    trap 'rm -rf "$ts_tmp"' EXIT HUP INT TERM
    ts_archive="tailscale_${TAILSCALE_BAKE_VERSION}_${ts_arch}"
    curl -fsSL --retry 3 --connect-timeout 15 --max-time 120 \
        "https://pkgs.tailscale.com/stable/${ts_archive}.tgz" -o "$ts_tmp/tailscale.tgz"
    ts_actual="$(sha256sum "$ts_tmp/tailscale.tgz" | cut -d' ' -f1)"
    if [ "$ts_actual" != "$ts_sha" ]; then
        echo "Tailscale archive failed its SHA-256 check" >&2
        exit 1
    fi
    tar -xzf "$ts_tmp/tailscale.tgz" -C "$ts_tmp"
    test -x "$ts_tmp/$ts_archive/tailscale"
    test -x "$ts_tmp/$ts_archive/tailscaled"
    mkdir -p "$ts_dest"
    install -m 755 "$ts_tmp/$ts_archive/tailscale" "$ts_dest/tailscale"
    install -m 755 "$ts_tmp/$ts_archive/tailscaled" "$ts_dest/tailscaled"
)

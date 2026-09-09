#!/bin/sh
# Pinned cloudflared bake/refresh helpers for Luna OS rootfs builds.
# Sourced by build-rootfs.sh — never use GitHub floating latest tag.
# shellcheck shell=sh

CLOUDFLARED_VERSION="${CLOUDFLARED_VERSION:-2026.7.3}"

luna_cloudflared_arch() {
    case "$1" in
        aarch64|arm64) printf '%s\n' arm64 ;;
        *) printf '%s\n' amd64 ;;
    esac
}

# Download pinned cloudflared into $1 (dest path). Uses CLOUDFLARED_VERSION + ARCH.
luna_cloudflared_download() {
    _dest="$1"
    _arch="$(luna_cloudflared_arch "${ARCH:-x86_64}")"
    _url="https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-${_arch}"
    curl -fsSL --proto '=https' --tlsv1.2 -o "$_dest" "$_url" || return 1
    _magic=$(od -An -N4 -tx1 "$_dest" 2>/dev/null | tr -d ' \n')
    _bytes=$(wc -c < "$_dest" 2>/dev/null || echo 0)
    if [ "$_bytes" -le 1024 ] || [ "$_magic" != "7f454c46" ]; then
        rm -f "$_dest"
        return 1
    fi
    chmod 755 "$_dest"
    return 0
}

# Prefer an already-baked binary; otherwise download the pinned release (never floating latest).
luna_cloudflared_ensure() {
    _baked="$1"
    _size=0
    if [ -f "$_baked" ]; then
        _size=$(wc -c < "$_baked" 2>/dev/null || echo 0)
    fi
    if [ -f "$_baked" ] && [ "$_size" -gt 1024 ]; then
        echo "keeping baked cloudflared ($_size bytes); skip pinned refresh"
        return 0
    fi
    command -v curl >/dev/null 2>&1 || return 1
    _tmp=$(mktemp)
    if luna_cloudflared_download "$_tmp"; then
        mv "$_tmp" "$_baked"
        chmod 0755 "$_baked"
        return 0
    fi
    rm -f "$_tmp"
    echo "warning: could not download cloudflared (lunad can also install on demand to data_dir/bin)" >&2
    return 1
}

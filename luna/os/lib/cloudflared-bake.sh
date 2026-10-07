#!/bin/sh
# Pinned cloudflared bake/refresh helpers for Luna OS rootfs builds.
# Sourced by build/rootfs.sh — never use GitHub floating latest tag.
# shellcheck shell=sh

CLOUDFLARED_VERSION="${CLOUDFLARED_VERSION:-2026.8.3}"
# SHA-256 of the release binaries for exactly that version (from the GitHub
# release's asset digests; re-check them when bumping CLOUDFLARED_VERSION).
CLOUDFLARED_SHA256_AMD64="${CLOUDFLARED_SHA256_AMD64:-f29324fe934d1e100617484c78deef803c4dc2cd351d645bbde42e96b4fccc5e}"
CLOUDFLARED_SHA256_ARM64="${CLOUDFLARED_SHA256_ARM64:-4bcfd35521a7cbc545ebfd5d57334a71ee180e2a64874981f374c81472118391}"

luna_cloudflared_arch() {
    case "$1" in
        aarch64|arm64) printf '%s\n' arm64 ;;
        *) printf '%s\n' amd64 ;;
    esac
}

luna_cloudflared_sha256() {
    case "$1" in
        arm64) printf '%s\n' "$CLOUDFLARED_SHA256_ARM64" ;;
        *) printf '%s\n' "$CLOUDFLARED_SHA256_AMD64" ;;
    esac
}

# True when file $1 has the pinned SHA-256 for arch $2.
luna_cloudflared_verify() {
    _want="$(luna_cloudflared_sha256 "$2")"
    _got="$(sha256sum "$1" 2>/dev/null | cut -d' ' -f1)"
    [ -n "$_got" ] && [ "$_got" = "$_want" ]
}

# Download pinned cloudflared into $1 (dest path). Uses CLOUDFLARED_VERSION + ARCH.
luna_cloudflared_download() {
    _dest="$1"
    _arch="$(luna_cloudflared_arch "${ARCH:-x86_64}")"
    _url="https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-${_arch}"
    # Build cache (a named volume): the pinned release never changes, so a
    # copy from an earlier build is reused instead of downloaded again.
    _cached=""
    if [ -d "${LUNA_CACHE_DIR:-/nonexistent}" ]; then
        _cached="$LUNA_CACHE_DIR/cloudflared-${CLOUDFLARED_VERSION}-${_arch}"
    fi
    _have=0
    if [ -n "$_cached" ] && [ -s "$_cached" ]; then
        if luna_cloudflared_verify "$_cached" "$_arch"; then
            cp "$_cached" "$_dest" || return 1
            _have=1
        else
            echo "warning: cached cloudflared does not match its pinned SHA-256; discarding it" >&2
            rm -f "$_cached"
        fi
    fi
    if [ "$_have" = 0 ]; then
        curl -fsSL --proto '=https' --tlsv1.2 -o "$_dest" "$_url" || return 1
    fi
    if ! luna_cloudflared_verify "$_dest" "$_arch"; then
        echo "error: cloudflared ${CLOUDFLARED_VERSION} ($_arch) does not match its pinned SHA-256" >&2
        rm -f "$_dest"
        return 1
    fi
    _magic=$(od -An -N4 -tx1 "$_dest" 2>/dev/null | tr -d ' \n')
    _bytes=$(wc -c < "$_dest" 2>/dev/null || echo 0)
    if [ "$_bytes" -le 1024 ] || [ "$_magic" != "7f454c46" ]; then
        rm -f "$_dest"
        return 1
    fi
    chmod 755 "$_dest"
    if [ -n "$_cached" ] && [ "$_have" = 0 ]; then
        cp "$_dest" "$_cached.tmp" && mv "$_cached.tmp" "$_cached" || true
    fi
    return 0
}

# Prefer an already-baked binary; otherwise download the pinned release (never a floating latest tag).
luna_cloudflared_ensure() {
    _baked="$1"
    _size=0
    if [ -f "$_baked" ]; then
        _size=$(wc -c < "$_baked" 2>/dev/null || echo 0)
    fi
    if [ -f "$_baked" ] && [ "$_size" -gt 1024 ] \
        && luna_cloudflared_verify "$_baked" "$(luna_cloudflared_arch "${ARCH:-x86_64}")"; then
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

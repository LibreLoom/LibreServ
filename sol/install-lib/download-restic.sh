#!/usr/bin/env bash
# Verified restic downloader for LibreServ.
# Pins RESTIC_VERSION and refuses to install if the .bz2 SHA256 mismatches.
#
# Usage:
#   install-lib/download-restic.sh [DEST_PATH]
#   RESTIC_PATH=/path/to/restic install-lib/download-restic.sh
#
# Optional env:
#   RESTIC_OWNER  -- if set, chown DEST to this user:group (e.g. libreserv:libreserv)
#   RESTIC_ARCH   -- override arch (amd64|arm64); default from uname -m
#   RESTIC_VERSION -- override pin (also requires matching SHA constants below)
#
# Intended install.sh call-site (sibling only — do not bash <(curl) the helper):
#   download_restic() {
#     local dest="${DATA_DIR}/bin/restic"
#     local helper="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)/install-lib/download-restic.sh"
#     if [ ! -f "${helper}" ]; then
#       log_warn "install-lib/download-restic.sh missing; install restic manually: https://restic.net/downloads/"
#       return
#     fi
#     RESTIC_OWNER="${USER}:${USER}" bash "${helper}" "${dest}" || \
#       { log_warn "restic verified download failed; install manually: https://restic.net/downloads/"; return; }
#   }
set -euo pipefail

RESTIC_VERSION="${RESTIC_VERSION:-0.19.1}"
# Upstream SHA256 of restic_${RESTIC_VERSION}_linux_{amd64,arm64}.bz2
# from https://github.com/restic/restic/releases/download/v${RESTIC_VERSION}/SHA256SUMS
RESTIC_SHA256_LINUX_AMD64="f415415624dcc452f2a02b8c33641791a8c6d6d3b65bbb3543fcf9a25151585c"
RESTIC_SHA256_LINUX_ARM64="a5f64aaab53d51e311fa3829124c5b703f2d14cf187d8640b6be3b2b49376465"

log() { echo "[restic-download] $*" >&2; }
die() { log "ERROR: $*"; exit 1; }

dest="${1:-${RESTIC_PATH:-}}"
[ -n "${dest}" ] || die "DEST_PATH argument or RESTIC_PATH required"

# Do not trust an existing dest on version string alone (a planted binary can
# print "restic ${RESTIC_VERSION}"). Always download + SHA256-verify the .bz2,
# then hash-compare the on-disk binary to the freshly verified artifact.
if [ -x "${dest}" ]; then
  existing_ver="$("${dest}" version 2>/dev/null | head -n1 || true)"
  log "existing binary at ${dest} (${existing_ver:-unknown}); will hash-verify against pinned restic ${RESTIC_VERSION}"
fi

arch="${RESTIC_ARCH:-}"
if [ -z "${arch}" ]; then
  case "$(uname -m)" in
    x86_64|amd64) arch="amd64" ;;
    aarch64|arm64) arch="arm64" ;;
    *) die "unsupported arch $(uname -m); set RESTIC_ARCH=amd64|arm64" ;;
  esac
fi

case "${arch}" in
  amd64) expected="${RESTIC_SHA256_LINUX_AMD64}" ;;
  arm64) expected="${RESTIC_SHA256_LINUX_ARM64}" ;;
  *) die "no baked-in checksum for arch=${arch}" ;;
esac
[ -n "${expected}" ] || die "empty checksum constant"

dest_dir="$(dirname "${dest}")"
mkdir -p "${dest_dir}"

url="https://github.com/restic/restic/releases/download/v${RESTIC_VERSION}/restic_${RESTIC_VERSION}_linux_${arch}.bz2"
tmp_bz2="$(mktemp)"
tmp_bin="$(mktemp "${dest_dir}/.restic.download.XXXXXX")"
cleanup() { rm -f "${tmp_bz2:-}" "${tmp_bin:-}"; }
trap cleanup EXIT

log "Downloading restic ${RESTIC_VERSION} linux/${arch}..."
command -v curl >/dev/null || die "curl required"
command -v sha256sum >/dev/null || die "sha256sum required"
command -v bzip2 >/dev/null || die "bzip2 required"

curl -fsSL --proto '=https' --tlsv1.2 "${url}" -o "${tmp_bz2}" || die "download failed: ${url}"

actual="$(sha256sum "${tmp_bz2}" | awk '{print $1}')"
if [ "${actual}" != "${expected}" ]; then
  log "checksum mismatch -- refusing to install untrusted binary"
  log "Expected: ${expected}"
  log "Got:      ${actual}"
  exit 1
fi

bzip2 -d -c "${tmp_bz2}" > "${tmp_bin}" || die "decompress failed"
rm -f "${tmp_bz2}"
tmp_bz2=""

chmod +x "${tmp_bin}"

# Harden existing-dest skip: compare on-disk SHA256 to verified fresh binary.
if [ -x "${dest}" ]; then
  ondisk="$(sha256sum "${dest}" | awk '{print $1}')"
  fresh="$(sha256sum "${tmp_bin}" | awk '{print $1}')"
  if [ "${ondisk}" = "${fresh}" ]; then
    log "restic ${RESTIC_VERSION} already installed and hash-verified at ${dest}"
    exit 0
  fi
  log "existing binary at ${dest} hash mismatch; replacing with verified restic ${RESTIC_VERSION}"
fi

mv -f "${tmp_bin}" "${dest}"
tmp_bin=""

if [ -n "${RESTIC_OWNER:-}" ]; then
  chown "${RESTIC_OWNER}" "${dest}" || die "chown ${RESTIC_OWNER} failed"
fi

trap - EXIT
log "restic ${RESTIC_VERSION} verified and installed to ${dest}"

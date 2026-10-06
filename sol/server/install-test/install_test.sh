#!/bin/bash
# Tests for sol/install.sh against the shared signed fixtures in
# infra/feed-testdata (TEST-ONLY key; injected by overriding the installer's
# variables after sourcing it, never baked into the script).
#
# Needs: bash, curl, python3, minisign, sha256sum. Run: bash install_test.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${HERE}/../../.." && pwd)"
FIX="${ROOT}/infra/feed-testdata"
INSTALLER="${ROOT}/sol/install.sh"

WORK="$(mktemp -d)"
SERVER_PID=""
cleanup() {
    [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null
    rm -rf "$WORK"
}
trap cleanup EXIT

fails=0
pass() { echo "ok   - $1"; }
fail() { echo "FAIL - $1"; fails=$((fails + 1)); }
check() { # check NAME CMD... : passes when CMD succeeds
    local name="$1"; shift
    if "$@" >/dev/null 2>&1; then pass "$name"; else fail "$name"; fi
}
check_not() { # check_not NAME CMD... : passes when CMD fails
    local name="$1"; shift
    if "$@" >/dev/null 2>&1; then fail "$name"; else pass "$name"; fi
}

# --- serve a tree shaped like the real hosts ---------------------------------
SERVE="${WORK}/serve"
mkdir -p "${SERVE}/feeds/sol" "${SERVE}/generic"
cp "${FIX}/sol-stable.json" "${SERVE}/feeds/sol/stable.json"
cp "${FIX}/sol-stable.json.minisig" "${SERVE}/feeds/sol/stable.json.minisig"
cp -r "${FIX}/files/generic/sol" "${SERVE}/generic/sol"
mkdir -p "${SERVE}/bad/sol"
cp "${FIX}/luna-stable.tampered.json" "${SERVE}/bad/sol/stable.json"
cp "${FIX}/luna-stable.tampered.json.minisig" "${SERVE}/bad/sol/stable.json.minisig"
mkdir -p "${SERVE}/wrongkey/sol"
cp "${FIX}/sol-stable.json" "${SERVE}/wrongkey/sol/stable.json"
cp "${FIX}/luna-stable.json.wrongkey.minisig" "${SERVE}/wrongkey/sol/stable.json.minisig"
mkdir -p "${SERVE}/wrongunit/sol"
cp "${FIX}/luna-stable.json" "${SERVE}/wrongunit/sol/stable.json"
cp "${FIX}/luna-stable.json.minisig" "${SERVE}/wrongunit/sol/stable.json.minisig"

# A throwaway key for the package sums (the fixtures have no sol SHA256SUMS).
GENKEY="${WORK}/gen"
mkdir -p "$GENKEY"
minisign -G -W -f -p "${GENKEY}/pub" -s "${GENKEY}/sec" >/dev/null 2>&1 || { echo "minisign -G failed"; exit 2; }
PKG="${SERVE}/generic/sol/0.9.1"
(cd "$PKG" && sha256sum libreserv-linux-amd64 libreserv-linux-arm64 > SHA256SUMS.txt)
minisign -S -s "${GENKEY}/sec" -m "${PKG}/SHA256SUMS.txt" -x "${PKG}/SHA256SUMS.txt.minisig" >/dev/null 2>&1 || { echo "minisign -S failed"; exit 2; }

PORT="$(python3 -I -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')"
(cd "$SERVE" && exec python3 -I -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1) &
SERVER_PID=$!
for _ in $(seq 1 50); do
    curl -fs "http://127.0.0.1:${PORT}/feeds/sol/stable.json" >/dev/null 2>&1 && break
    sleep 0.1
done

# --- load the installer without running it -----------------------------------
# shellcheck disable=SC1090
source "$INSTALLER"
log_info() { :; }
log_warn() { :; }
log_error() { :; }

TEST_KEY="$(cat "${FIX}/test-key.pub")"
GEN_KEY="$(cat "${GENKEY}/pub")"
CURL_SECURE=()
FEED_BASE_URL="http://127.0.0.1:${PORT}/feeds/sol"
PACKAGE_BASE_URL="http://127.0.0.1:${PORT}/generic/sol"
RELEASE_MINISIGN_PUB="$TEST_KEY"

# The baked-in key must be the repo's libreserv key.
want="$(sed -n '2p' "${ROOT}/keys/libreserv.minisign.pub")"
if [[ "$RELEASE_MINISIGN_PUB" == "$TEST_KEY" ]]; then
    # compare against the pristine value from the script text
    baked="$(grep -A1 "^RELEASE_MINISIGN_PUB=" "$INSTALLER" | sed -n '2p' | tr -d "'")"
    [ "$baked" = "$want" ] && pass "installer bakes in keys/libreserv.minisign.pub" || fail "installer bakes in keys/libreserv.minisign.pub"
fi

# --- latest: feed ---------------------------------------------------------------
LATEST_RELEASE=""
get_latest_release >/dev/null 2>&1
[ "$LATEST_RELEASE" = "0.9.1" ] && pass "latest reads version from the verified feed" || fail "latest reads version (got '${LATEST_RELEASE}')"

for dir in bad wrongkey wrongunit; do
    FEED_BASE_URL="http://127.0.0.1:${PORT}/${dir}/sol"
    out="$( (get_latest_release) 2>&1; echo "rc=$?")"
    case "$out" in *rc=0) fail "latest rejects ${dir} feed" ;; *) pass "latest rejects ${dir} feed" ;; esac
done
FEED_BASE_URL="http://127.0.0.1:${PORT}/feeds/sol"
RELEASE_MINISIGN_PUB="$GEN_KEY"
out="$( (get_latest_release) 2>&1; echo "rc=$?")"
case "$out" in *rc=0) fail "latest rejects feed signed by another key" ;; *) pass "latest rejects feed signed by another key" ;; esac
RELEASE_MINISIGN_PUB="$TEST_KEY"

# --- sums_lookup against the fixture cases --------------------------------------
SUMS="${FIX}/files/generic/luna/0.4.0/SHA256SUMS.txt"
check "fixture sums signature verifies" verify_signature "$SUMS" "${SUMS}.minisig"
while IFS=$'\t' read -r name file expect; do
    got="$(sums_lookup "$SUMS" "$file")"
    if [ "$expect" = "not-found" ]; then
        [ -z "$got" ] && pass "sums: ${name}" || fail "sums: ${name} (got ${got})"
    else
        [ "$got" = "$expect" ] && pass "sums: ${name}" || fail "sums: ${name} (got ${got})"
    fi
done < <(python3 -I - "${FIX}/cases.json" <<'PY'
import json, sys
for c in json.load(open(sys.argv[1]))["sums"]["cases"]:
    print("\t".join([c["name"], c["file"], c["expect"]]))
PY
)
printf 'abc *file.bin\n' > "${WORK}/star.txt"
[ "$(sums_lookup "${WORK}/star.txt" file.bin)" = "abc" ] && pass "sums: leading * accepted" || fail "sums: leading * accepted"

# --- version syntax ------------------------------------------------------------
for v in 0.9.1 1.0.0 0.3.0-beta.10; do
    [[ "$v" =~ $VERSION_RE ]] && pass "version ok: $v" || fail "version ok: $v"
done
for v in v1.0.0 1.0 01.0.0 1.0.0-rc.1 1.0.0-beta.01 "" latest; do
    [[ "$v" =~ $VERSION_RE ]] && fail "version rejected: '$v'" || pass "version rejected: '$v'"
done

# --- exact version: package sums, no feed ---------------------------------------
OS=linux
NO_SYSTEMD=true
RELEASE_MINISIGN_PUB="$GEN_KEY"
FEED_BASE_URL="http://127.0.0.1:1/never"   # must not be touched
run_install() { # run_install ARCH
    ARCH="$1"
    INSTALL_DIR="${WORK}/opt-$1"
    BIN_DIR="${WORK}/bin-$1"
    mkdir -p "$BIN_DIR"
    INSTALL_VERSION="0.9.1"
    download_binary
}
for a in amd64 arm64; do
    if (run_install "$a") >/dev/null 2>&1; then
        want_sum="$(sha256sum "${FIX}/files/generic/sol/0.9.1/libreserv-linux-${a}" | cut -d' ' -f1)"
        got_sum="$(sha256sum "${WORK}/opt-${a}/libreserv" | cut -d' ' -f1)"
        [ "$want_sum" = "$got_sum" ] && [ -x "${WORK}/opt-${a}/libreserv" ] && pass "exact version installs ${a} binary" || fail "exact version installs ${a} binary"
    else
        fail "exact version installs ${a} binary"
    fi
done

# tampered binary: wrong checksum must install nothing
cp -r "${SERVE}/generic/sol" "${WORK}/sol-orig"
RELEASE_MINISIGN_PUB="$GEN_KEY"
printf 'tampered' >> "${PKG}/libreserv-linux-amd64"
ARCH=amd64
INSTALL_DIR="${WORK}/opt-t"; BIN_DIR="${WORK}/bin-t"; mkdir -p "$BIN_DIR"
if (download_binary) >/dev/null 2>&1; then fail "tampered binary rejected (amd64)"; else
    [ ! -e "${INSTALL_DIR}/libreserv" ] && pass "tampered binary rejected (amd64), nothing installed" || fail "tampered binary left installed"
fi
rm -rf "${PKG}"; cp -r "${WORK}/sol-orig/0.9.1" "${PKG}"

# sums signed by the wrong key: nothing installed
RELEASE_MINISIGN_PUB="$TEST_KEY"
INSTALL_DIR="${WORK}/opt-k"; BIN_DIR="${WORK}/bin-k"; mkdir -p "$BIN_DIR"
if (download_binary) >/dev/null 2>&1; then fail "sums with wrong key rejected"; else
    [ ! -e "${INSTALL_DIR}/libreserv" ] && pass "sums with wrong key rejected" || fail "sums with wrong key left a binary"
fi

# argument parsing
check "--version syntax accepted by parser" bash -c "source '$INSTALLER'; [[ '0.9.1' =~ \$VERSION_RE ]]"
check_not "--version v0.9.1 refused" bash "$INSTALLER" --version v0.9.1
check_not "--version without value refused" bash "$INSTALLER" --version

if [ "$fails" -eq 0 ]; then echo "all install.sh tests passed"; else echo "${fails} install.sh test(s) failed"; exit 1; fi

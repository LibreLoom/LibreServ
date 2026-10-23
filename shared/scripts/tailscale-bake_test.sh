#!/bin/sh
# Exercise the pinned archives and an isolated, unenrolled userspace daemon.
set -eu
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
. "$REPO/shared/scripts/tailscale-bake.sh"
ts_test_dir="$(mktemp -d /tmp/tailscale-package-test.XXXXXX)"
ts_test_pid=""
trap 'if [ -n "$ts_test_pid" ]; then kill "$ts_test_pid" 2>/dev/null || true; wait "$ts_test_pid" 2>/dev/null || true; fi; rm -rf "$ts_test_dir"' EXIT HUP INT TERM

for ts_test_arch in amd64 arm64; do
    libreloom_install_tailscale "$ts_test_dir/$ts_test_arch" "$ts_test_arch"
    test -x "$ts_test_dir/$ts_test_arch/tailscale"
    test -x "$ts_test_dir/$ts_test_arch/tailscaled"
done
case "$(uname -m)" in
    x86_64) ts_native=amd64 ;;
    aarch64|arm64) ts_native=arm64 ;;
    *) echo "unsupported test host" >&2; exit 1 ;;
esac
"$ts_test_dir/$ts_native/tailscale" version | head -1 | grep -Fx "$TAILSCALE_BAKE_VERSION"
"$ts_test_dir/$ts_native/tailscale" serve --help >/dev/null 2>&1
"$ts_test_dir/$ts_native/tailscale" funnel --help >/dev/null 2>&1

# Real local API shapes, without login, enrollment or a public listener.
mkdir -m 700 "$ts_test_dir/node"
mkdir -p "$ts_test_dir/versions/0.0.1" "$ts_test_dir/versions/0.0.2" "$ts_test_dir/versions/$TAILSCALE_BAKE_VERSION"
ln "$ts_test_dir/$ts_native/tailscaled" "$ts_test_dir/versions/0.0.1/tailscaled"
TS_NO_LOGS_NO_SUPPORT=true "$ts_test_dir/versions/0.0.1/tailscaled" \
    --state="$ts_test_dir/node/state" --socket="$ts_test_dir/node/socket" \
    --tun=userspace-networking --port=0 >"$ts_test_dir/node/log" 2>&1 &
ts_test_pid=$!
ts_ready=false
for ts_attempt in 1 2 3 4 5; do
    if timeout 3 "$ts_test_dir/$ts_native/tailscale" --socket="$ts_test_dir/node/socket" status --json >"$ts_test_dir/node/status.json" 2>/dev/null; then
        ts_ready=true
        break
    fi
    sleep 1
done
if [ "$ts_ready" != true ]; then cat "$ts_test_dir/node/log" >&2; exit 1; fi
python3 -c 'import json,sys; assert json.load(open(sys.argv[1]))["BackendState"] == "NeedsLogin"' "$ts_test_dir/node/status.json"
timeout 3 "$ts_test_dir/$ts_native/tailscale" --socket="$ts_test_dir/node/socket" serve status --json >"$ts_test_dir/node/serve.json"
python3 -c 'import json,sys; assert json.load(open(sys.argv[1])) in (None, {})' "$ts_test_dir/node/serve.json"
# This is why product teardown must also work offline, after stopping tailscaled.
if timeout 3 "$ts_test_dir/$ts_native/tailscale" --socket="$ts_test_dir/node/socket" serve reset >"$ts_test_dir/node/reset.log" 2>&1; then
    echo "Expected the pinned daemon to reject a reset before login" >&2
    exit 1
fi
grep -F 'netMap is nil' "$ts_test_dir/node/reset.log"
# Upgrades reclaim unused versions, but keep the running executable intact.
bash -c '. "$1"; TAILSCALE_INSTALL_DIR="$2"; prune_tailscale_versions' \
    check "$REPO/sol/install.sh" "$ts_test_dir/versions/$TAILSCALE_BAKE_VERSION"
test -d "$ts_test_dir/versions/0.0.1"
test ! -d "$ts_test_dir/versions/0.0.2"
test -d "$ts_test_dir/versions/$TAILSCALE_BAKE_VERSION"
kill "$ts_test_pid"
wait "$ts_test_pid" || true
ts_test_pid=""
bash -c '. "$1"; TAILSCALE_INSTALL_DIR="$2"; prune_tailscale_versions' \
    check "$REPO/sol/install.sh" "$ts_test_dir/versions/$TAILSCALE_BAKE_VERSION"
test ! -d "$ts_test_dir/versions/0.0.1"

# The public installer must remain standalone and pin the same release/hashes.
bash -c '. "$1"; test "$TAILSCALE_VERSION" = "$2" && test "$TAILSCALE_SHA256_AMD64" = "$3" && test "$TAILSCALE_SHA256_ARM64" = "$4"' \
    check "$REPO/sol/install.sh" "$TAILSCALE_BAKE_VERSION" "$TAILSCALE_BAKE_SHA_AMD64" "$TAILSCALE_BAKE_SHA_ARM64"
test "$(sed -n 's/^const TailscaleVersion = "\([^"]*\)"/\1/p' "$REPO/sol/server/backend/internal/network/tailscale.go")" = "$TAILSCALE_BAKE_VERSION"

# Optional native packaging failure must not abort install or upgrade.
bash -c 'set -e; . "$1"; install_tailscale() { return 1; }; install_optional_tailscale; echo continued' \
    check "$REPO/sol/install.sh" | grep -Fx continued

mkdir -p "$ts_test_dir/fakebin"
cat > "$ts_test_dir/fakebin/curl" <<'MOCK'
#!/bin/sh
while [ "$#" -gt 0 ]; do
    if [ "$1" = -o ]; then printf 'corrupt archive' > "$2"; exit 0; fi
    shift
done
exit 1
MOCK
chmod +x "$ts_test_dir/fakebin/curl"
if PATH="$ts_test_dir/fakebin:$PATH" libreloom_install_tailscale "$ts_test_dir/rejected" amd64; then
    echo "corrupt archive was accepted" >&2
    exit 1
fi
test ! -e "$ts_test_dir/rejected/tailscale"
sh "$REPO/luna/os/rootfs_test.sh"
sh "$REPO/shared/scripts/tailscale-rootfs_test.sh"
echo "Pinned Tailscale archives, integrity rejection, and Luna rootfs checks passed"

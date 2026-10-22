#!/bin/sh
# Exercise the real pinned archives without starting or enrolling a daemon.
set -eu
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
. "$REPO/shared/scripts/tailscale-bake.sh"
ts_test_dir="$(mktemp -d /tmp/tailscale-package-test.XXXXXX)"
trap 'rm -rf "$ts_test_dir"' EXIT HUP INT TERM

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

# The public installer must remain standalone and pin the same release/hashes.
bash -c '. "$1"; test "$TAILSCALE_VERSION" = "$2" && test "$TAILSCALE_SHA256_AMD64" = "$3" && test "$TAILSCALE_SHA256_ARM64" = "$4"' \
    check "$REPO/sol/install.sh" "$TAILSCALE_BAKE_VERSION" "$TAILSCALE_BAKE_SHA_AMD64" "$TAILSCALE_BAKE_SHA_ARM64"

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
echo "Pinned Tailscale archives, integrity rejection, and Luna rootfs checks passed"

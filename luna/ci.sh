#!/bin/sh
# Luna CI — runs everything a Luna commit must pass. Read-only except build artifacts.
set -eu

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

# The container/host maps ~/.cargo and ~/.npm read-only in this environment;
# point caches at /tmp when the defaults are unwritable.
if [ ! -w "${CARGO_HOME:-$HOME/.cargo}" ]; then
  export CARGO_HOME="${CARGO_HOME:-/tmp/luna-cargo-home}"
else
  export CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"
fi
mkdir -p "$CARGO_HOME"

# Cloud Agent / CI host shells often skip /etc/profile.d. Pick up the SDK
# install.sh provisions so mobile unit tests can find it.
if [ -z "${ANDROID_HOME:-}" ] && [ -d /usr/local/android-sdk ]; then
  export ANDROID_HOME=/usr/local/android-sdk
  export ANDROID_SDK_ROOT=/usr/local/android-sdk
  export PATH="${ANDROID_HOME}/cmdline-tools/latest/bin:${ANDROID_HOME}/platform-tools:${PATH}"
fi
if [ -n "${ANDROID_HOME:-}" ] && [ ! -f mobile/local.properties ]; then
  echo "sdk.dir=${ANDROID_HOME}" > mobile/local.properties
fi

echo "==> cargo fmt"
cargo fmt --all --check

echo "==> cargo clippy"
cargo clippy --workspace --all-targets -- -D warnings

echo "==> cargo test"
cargo test --workspace

echo "==> os scripts"
sh -n os/build-rootfs.sh os/flash.sh os/make-image.sh os/make-iso.sh os/build-iso.sh os/rapidinstall.sh \
	os/lib/disk.sh os/lib/flash-disk.sh os/lib/console.sh os/lib/factory-assets.sh \
	os/lib/disk_test.sh os/lib/factory-assets_test.sh os/lib/flash-disk_test.sh \
	os/ab_update_rehearsal_test.sh \
	os/lib/alpine-image.sh \
	os/lib/musl-link.sh os/lib/musl-binaries_test.sh \
	os/iso/find-media.sh os/iso/find-media_test.sh \
	os/iso/stage-debian-live.sh os/iso/build-debian-live.sh os/iso/wait-iso-build.sh \
	os/iso/add-uefi-boot.sh \
	os/debian-live/debian_live_test.sh os/rootfs_test.sh os/rapidinstall_wait_test.sh
sh os/lib/disk_test.sh
sh os/lib/factory-assets_test.sh
sh os/lib/flash-disk_test.sh
sh os/ab_update_rehearsal_test.sh
sh os/iso/find-media_test.sh
sh os/debian-live/debian_live_test.sh
sh os/rapidinstall_wait_test.sh
sh os/rootfs_test.sh
sh os/lib/musl-binaries_test.sh
# build-rootfs.sh is a thin concat wrapper; alpine-image lives in the frags.
grep -q 'os/lib/alpine-image.sh' os/make-image.sh || {
	echo "os/make-image.sh must source os/lib/alpine-image.sh" >&2
	exit 1
}
grep -rq 'os/lib/alpine-image.sh' os/lib/build-rootfs.d/ || {
	echo "os/lib/build-rootfs.d must source os/lib/alpine-image.sh" >&2
	exit 1
}
grep -q 'live-build' os/make-iso.sh || {
	echo "os/make-iso.sh must use host live-build" >&2
	exit 1
}
if grep -rq 'alpine:latest' os/make-image.sh os/lib/alpine-image.sh os/lib/build-rootfs.d/; then
	echo "Alpine OS image scripts must not default to alpine:latest" >&2
	exit 1
fi

echo "==> musl static-pie smoke"
# Isolate musl link flags so host desktop/mobile rustc still builds proc-macros.
(
	MUSL_TARGET="${MUSL_TARGET:-x86_64-unknown-linux-musl}"
	# shellcheck source=os/lib/musl-link.sh
	. os/lib/musl-link.sh
	unset RUSTFLAGS
	luna_musl_export "$MUSL_TARGET"
	if ! rustup target list --installed | grep -qx "$MUSL_TARGET"; then
		rustup target add "$MUSL_TARGET"
	fi
	cargo build --release -p lunad --bin lunad --bin luna-console --target "$MUSL_TARGET"
	luna_musl_smoke_lunad "$ROOT/target/${MUSL_TARGET}/release/lunad"
	luna_musl_smoke_console "$ROOT/target/${MUSL_TARGET}/release/luna-console"
)

echo "==> desktop (GTK / libadwaita)"
(
  cd desktop
  if pkg-config --atleast-version=4.14 gtk4 2>/dev/null && pkg-config --atleast-version=1.5 libadwaita-1 2>/dev/null; then
    cargo=cargo
  else
    echo "    host GTK/libadwaita too old for luna/desktop; building in container via scripts/cargo-in-container.sh"
    cargo=./scripts/cargo-in-container.sh
  fi
  "$cargo" fmt --check
  "$cargo" test
  "$cargo" build --release
)

echo "==> mobile unit tests"
(
  cd mobile
  if [ ! -w "${GRADLE_USER_HOME:-$HOME/.gradle}" ]; then
    export GRADLE_USER_HOME="${GRADLE_USER_HOME:-/tmp/luna-gradle}"
  fi
  if [ ! -w "${ANDROID_USER_HOME:-$HOME/.config/.android}" ]; then
    export ANDROID_USER_HOME="${ANDROID_USER_HOME:-/tmp/luna-android}"
  fi
  ./gradlew testDebugUnitTest --no-daemon
)

echo "==> web build"
(
  cd ../shared/ui
  npm install --no-audit --no-fund --cache /tmp/luna-npm-cache
  cd "$ROOT/web"
  npm install --no-audit --no-fund --cache /tmp/luna-npm-cache
  npm run build
  npm test -- --run
  npm run lint
  npm run typecheck
)

echo "==> ci ok"

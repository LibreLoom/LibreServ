#!/bin/sh
# Luna CI — runs everything a Luna commit must pass. Read-only except build artifacts.
set -eu

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

# The container/host maps ~/.cargo and ~/.npm read-only in this environment;
# point caches at /tmp when the defaults are unwritable.
if [ ! -w "${CARGO_HOME:-$HOME/.cargo}" ]; then
  export CARGO_HOME="${CARGO_HOME:-/tmp/luna-cargo-home}"
fi
mkdir -p "$CARGO_HOME"

echo "==> cargo fmt"
cargo fmt --all --check

echo "==> cargo clippy"
cargo clippy --workspace --all-targets -- -D warnings

echo "==> cargo test"
cargo test --workspace

echo "==> os scripts"
sh -n os/build-rootfs.sh os/flash.sh os/make-image.sh os/make-iso.sh os/build-iso.sh os/rapidinstall.sh \
	os/lib/disk.sh os/lib/flash-disk.sh os/lib/disk_test.sh os/lib/alpine-image.sh os/iso/init \
	os/iso/find-media.sh os/iso/find-media_test.sh os/iso/build-live.sh os/iso/build-xorriso.sh
sh os/lib/disk_test.sh
sh os/iso/find-media_test.sh
for f in os/make-iso.sh os/build-rootfs.sh os/make-image.sh; do
	grep -q 'os/lib/alpine-image.sh' "$f" || {
		echo "$f must source os/lib/alpine-image.sh" >&2
		exit 1
	}
done
if grep -q 'alpine:latest' os/make-iso.sh os/build-rootfs.sh os/make-image.sh os/lib/alpine-image.sh; then
	echo "OS image scripts must not default to alpine:latest" >&2
	exit 1
fi

echo "==> desktop core"
(
  cd desktop/src-tauri
  cargo fmt --check
  cargo test
)

echo "==> desktop web"
(
  cd desktop
  npm install --no-audit --no-fund --cache /tmp/luna-npm-cache
  npm run build
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
  cd web
  npm install --no-audit --no-fund --cache /tmp/luna-npm-cache
  npm run build
  npm test -- --run
  npm run lint
  npm run typecheck
)

echo "==> ci ok"

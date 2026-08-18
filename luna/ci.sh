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

# The shipped Luna OS build enables the `ble` (BlueZ GATT) feature; it must
# compile and lint clean too, not just the default build. It needs the dbus
# dev headers, so skip with a warning on hosts that lack them (e.g. a bare CI
# container) rather than failing the whole run.
if pkg-config --exists dbus-1 2>/dev/null; then
  echo "==> cargo clippy (ble feature)"
  cargo clippy -p lunad --features ble --all-targets -- -D warnings

  echo "==> cargo test (ble feature)"
  cargo test -p lunad --features ble
else
  echo "==> skipping ble-feature checks (dbus-1 dev headers not installed)"
fi

echo "==> os scripts"
sh -n os/build-rootfs.sh os/flash.sh os/make-image.sh

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

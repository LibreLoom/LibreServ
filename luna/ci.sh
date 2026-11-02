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
LUNA_CONTRACT_RECORD=1 cargo test --workspace

echo "==> luna-run version picker"
bash os/luna_run_test.sh

# Coverage is a report, not a gate, and re-running the whole workspace test
# suite just for it doubles the CI time — so it is opt-in (LUNA_COVERAGE=1).
echo "==> coverage (report only)"
if [ "${LUNA_COVERAGE:-0}" != "1" ]; then
	echo "    skipped (set LUNA_COVERAGE=1 to re-run the suite for a coverage report)"
elif cargo llvm-cov --version >/dev/null 2>&1; then
	cargo llvm-cov --workspace --summary-only || echo "    coverage run failed (not gating)"
else
	echo "    cargo-llvm-cov is not installed; skipping (cargo install cargo-llvm-cov)"
fi
sh scripts/test-presence.sh

echo "==> os scripts"
sh -n os/build-rootfs.sh os/flash.sh os/make-image.sh os/make-iso.sh os/build-iso.sh os/rapidinstall.sh \
	os/lib/disk.sh os/lib/flash-disk.sh os/lib/console.sh os/lib/factory-assets.sh \
	os/lib/disk_test.sh os/lib/factory-assets_test.sh os/lib/flash-disk_test.sh \
	os/ab_update_rehearsal_test.sh \
	os/lib/alpine-image.sh os/lib/host-podman.sh \
	os/lib/musl-link.sh os/lib/musl-binaries_test.sh \
	os/build/rootfs.sh os/build/image.sh os/build/input-hash.sh \
	os/build/live.sh os/build/iso-customize.sh os/build/iso.sh \
	os/iso/find-media.sh os/iso/find-media_test.sh os/iso/boot-test.sh os/iso/install-test.sh os/iso/e2e.sh \
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
# Build steps run in containers (os/build/*.sh); the os/*.sh wrappers only call
# podman. The pinned Alpine image comes from lib/alpine-image.sh.
for f in os/make-image.sh os/build-rootfs.sh os/build/input-hash.sh; do
	grep -q 'lib/alpine-image.sh' "$f" || {
		echo "$f must source lib/alpine-image.sh (pinned Alpine image)" >&2
		exit 1
	}
done
for f in os/build/rootfs.sh os/build/image.sh os/build/live.sh os/build/iso.sh; do
	[ -s "$f" ] || {
		echo "missing build step $f" >&2
		exit 1
	}
done
grep -q 'mmdebstrap' os/build/live.sh || {
	echo "os/build/live.sh must build the live system with mmdebstrap" >&2
	exit 1
}
grep -q 'grub-mkrescue' os/build/iso.sh || {
	echo "os/build/iso.sh must make the ISO with grub-mkrescue" >&2
	exit 1
}
# Rootless: no live-build (`lb ...`), no sudo command, no privileged containers
# in the OS build. Prose mentions ("no sudo") and comments are fine.
if grep -rEn '^[^#]*((^|[;&|(]|\$\()[[:space:]]*(sudo|lb)[[:space:]]|--privileged|apt-get install[^#]*live-build)' \
	os/*.sh os/build os/lib/*.sh os/iso/*.sh 2>/dev/null |
	grep -v '_test\.sh:'; then
	echo "OS build must stay rootless: no live-build, sudo or --privileged" >&2
	exit 1
fi
if grep -rq 'alpine:latest' os/make-image.sh os/lib/alpine-image.sh os/build/Containerfile.os; then
	echo "Alpine OS image scripts must not default to alpine:latest" >&2
	exit 1
fi

# The remaining blocks are independent (different toolchains and directories),
# so they run as parallel lanes instead of one long serial tail. The lanes are
# memory-hungry (rustc, gradle, vite), so their number follows the job's
# memory share: the ci runner exports LIBRESERV_CI_MEM_BYTES for host tests
# (empty/unset means unlimited). The two Rust release builds share one lane to
# keep peak memory down. A failing lane's full log is printed below.
#
# Node otherwise sizes its heap from the cgroup, which is far too small for a
# vite build under a bounded job, so give it half the share.
LANES=3
if [ -n "${LIBRESERV_CI_MEM_BYTES:-}" ] && [ "$LIBRESERV_CI_MEM_BYTES" -gt 0 ]; then
	if [ "$LIBRESERV_CI_MEM_BYTES" -lt 6000000000 ]; then
		LANES=2
	fi
	heap=$((LIBRESERV_CI_MEM_BYTES / 2 / 1024 / 1024))
	[ "$heap" -lt 1024 ] && heap=1024
	export NODE_OPTIONS="--max-old-space-size=$heap ${NODE_OPTIONS:-}"
fi

lane_rust() {
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
	  cd "$ROOT/desktop"
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
}

lane_mobile() {
	echo "==> mobile unit tests"
	(
	  cd "$ROOT/mobile"
	  if [ ! -w "${GRADLE_USER_HOME:-$HOME/.gradle}" ]; then
	    export GRADLE_USER_HOME="${GRADLE_USER_HOME:-/tmp/luna-gradle}"
	  fi
	  if [ ! -w "${ANDROID_USER_HOME:-$HOME/.config/.android}" ]; then
	    export ANDROID_USER_HOME="${ANDROID_USER_HOME:-/tmp/luna-android}"
	  fi
	  ./gradlew testDebugUnitTest --no-daemon
	)
}

lane_web() {
	echo "==> web build"
	(
	  cd "$ROOT/../shared/ui"
	  npm install --no-audit --no-fund --cache /tmp/luna-npm-cache
	  cd "$ROOT/web"
	  npm install --no-audit --no-fund --cache /tmp/luna-npm-cache
	  npm run scan:colors
	  cd "$ROOT/../shared/ui"
	  npm test
	  npm run typecheck
	  cd "$ROOT/web"
	  npm run build
	  npm run lint
	  npm run typecheck
	  npm test -- --run
	)

	echo "==> connect web"
	(
	  cd "$ROOT/connect/web"
	  npm install --no-audit --no-fund --cache /tmp/luna-npm-cache
	  npm run build
	  npm test
	  npm run lint
	  npm run typecheck
	)

	echo "==> quick-start print layout"
	(
	  cd "$ROOT/quick-start"
	  npm install --no-audit --no-fund --cache /tmp/luna-npm-cache
	  npm run build
	  npm run lint
	  npm run typecheck
	)
}

echo "==> parallel lanes ($LANES): rust builds, mobile, web"
LANE_DIR="$(mktemp -d)"
pids=""

lane_rust >"$LANE_DIR/rust.log" 2>&1 &
pids="$pids $!"
if [ "$LANES" -ge 3 ]; then
	lane_mobile >"$LANE_DIR/mobile.log" 2>&1 &
	pids="$pids $!"
	lane_web >"$LANE_DIR/web.log" 2>&1 &
	pids="$pids $!"
else
	( lane_mobile && lane_web ) >"$LANE_DIR/mobile-web.log" 2>&1 &
	pids="$pids $!"
fi

lane_fail=0
for pid in $pids; do
	wait "$pid" || lane_fail=1
done
if [ "$lane_fail" -ne 0 ]; then
	echo "==> a parallel lane failed; its log follows" >&2
	for f in "$LANE_DIR"/*.log; do
		echo "----- $f -----"
		cat "$f"
	done
	exit 1
fi
rm -rf "$LANE_DIR"

echo "==> ci ok"

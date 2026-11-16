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

# Cloud Agent / CI host shells often skip /etc/profile.d. Find the SDK in the
# install.sh location or the standard Android Studio location so mobile tests
# do not depend on a login shell exporting it. A configured ANDROID_SDK_ROOT
# counts too, and either name covers for the other.
if [ -z "${ANDROID_HOME:-}" ] && [ -n "${ANDROID_SDK_ROOT:-}" ]; then
  export ANDROID_HOME="$ANDROID_SDK_ROOT"
fi
if [ -z "${ANDROID_HOME:-}" ] && [ -d /usr/local/android-sdk ]; then
  export ANDROID_HOME=/usr/local/android-sdk
fi
if [ -z "${ANDROID_HOME:-}" ] && [ -d "$HOME/Android/Sdk" ]; then
  export ANDROID_HOME="$HOME/Android/Sdk"
fi
if [ -n "${ANDROID_HOME:-}" ]; then
  export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$ANDROID_HOME}"
  export PATH="${ANDROID_HOME}/cmdline-tools/latest/bin:${ANDROID_HOME}/platform-tools:${PATH}"
fi
if [ -n "${ANDROID_HOME:-}" ] && [ ! -f mobile/local.properties ]; then
  echo "sdk.dir=${ANDROID_HOME}" > mobile/local.properties
fi

# Every block below is a lane: its own toolchain and directory, run in
# parallel by the launcher at the end of this file.

# Rust workspace: format, lints, tests. Owns luna/target.
lane_check() {
	echo "==> cargo fmt"
	cargo fmt --all --check

	echo "==> cargo clippy"
	cargo clippy --workspace --all-targets -- -D warnings

	echo "==> cargo test"
	LUNA_CONTRACT_RECORD=1 cargo test --workspace

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
}

# OS image shell tests and build-script rules. Seconds; no toolchain.
lane_os() {
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
}

# Static musl build + smoke, then the GTK desktop app. Release-only work stays
# in ./release: it builds the shipped LTO lunad and the Flatpak, and its
# lunad-smoke.sh checks that exact binary. This lane builds the same binaries
# with the ci-smoke profile (no LTO): the same musl static-pie link in a
# fraction of the time. A separate target dir keeps it from queueing behind
# lane_check on cargo's build-directory lock.
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
		export CARGO_TARGET_DIR="$ROOT/target/ci-musl"
		cargo build --profile ci-smoke -p lunad --bin lunad --bin luna-console --target "$MUSL_TARGET"
		luna_musl_smoke_lunad "$CARGO_TARGET_DIR/${MUSL_TARGET}/ci-smoke/lunad"
		luna_musl_smoke_console "$CARGO_TARGET_DIR/${MUSL_TARGET}/ci-smoke/luna-console"
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
	  # cargo test compiles the whole app. The shipped release build is the
	  # Flatpak step of ./release, so there is no second release compile here.
	  "$cargo" test
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


# How many lanes run at once follows the job's memory share: the ci runner
# exports LIBRESERV_CI_MEM_BYTES for host tests (empty/unset means unlimited).
# rustc, gradle and vite are each memory-hungry. Node otherwise sizes its heap
# from the cgroup, which is far too small for a vite build under a bounded job,
# so give it half the share.
LANES=4
if [ -n "${LIBRESERV_CI_MEM_BYTES:-}" ] && [ "$LIBRESERV_CI_MEM_BYTES" -gt 0 ]; then
	if [ "$LIBRESERV_CI_MEM_BYTES" -lt 6000000000 ]; then
		LANES=2
	elif [ "$LIBRESERV_CI_MEM_BYTES" -lt 10000000000 ]; then
		LANES=3
	fi
	heap=$((LIBRESERV_CI_MEM_BYTES / 2 / 1024 / 1024))
	[ "$heap" -lt 1024 ] && heap=1024
	export NODE_OPTIONS="--max-old-space-size=$heap ${NODE_OPTIONS:-}"
fi

# timed NAME CMD...: run CMD, then report NAME's wall time and exit status, so
# a slow lane shows up in a green run and not only in a red one.
timed() {
	_name="$1"
	shift
	_t0=$(date +%s)
	_rc=0
	"$@" || _rc=$?
	echo "==> lane $_name: $(($(date +%s) - _t0))s (exit $_rc)"
	return "$_rc"
}

LANE_DIR="$(mktemp -d)"
pids=""

# start LOGNAME LANE...: run the named lane functions one after another in the
# background, logging to LANE_DIR/LOGNAME.log.
start() {
	_log="$LANE_DIR/$1.log"
	shift
	(
		for _lane in "$@"; do
			timed "$_lane" "$_lane" || exit 1
		done
	) >"$_log" 2>&1 &
	pids="$pids $!"
}

# lane_check owns luna/target (fmt, clippy, tests) and is the long pole, so it
# always runs alone in its lane; the rest are grouped to fit the memory share.
echo "==> parallel lanes ($LANES): rust checks, musl+desktop, mobile, web, os scripts"
case "$LANES" in
4)
	start check lane_check
	start rust lane_rust
	start mobile lane_mobile lane_os
	start web lane_web
	;;
3)
	start check lane_check
	start rust lane_rust lane_os
	start mobileweb lane_mobile lane_web
	;;
*)
	start check lane_check
	start rest lane_rust lane_mobile lane_web lane_os
	;;
esac

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
grep -h '^==> lane ' "$LANE_DIR"/*.log
rm -rf "$LANE_DIR"

echo "==> ci ok"

#!/bin/sh
# Luna CI — runs everything a Luna commit must pass. Read-only except build artifacts.
set -eu

# Select lanes before any SDK/cache setup. --list-lanes is read-only and is
# also used by the CI scope regression tests.
list_lanes=0
if [ "${1:-}" = --list-lanes ]; then
	list_lanes=1
	shift
fi
SCOPE=${1:-all}
check_lanes= clippy_lanes= rest_lanes= web_lanes= final_lanes=
case "$SCOPE" in
all)
	check_lanes=lane_check
	clippy_lanes="lane_clippy lane_rust"
	rest_lanes="lane_mobile lane_os"
	web_lanes=lane_web
	final_lanes=lane_web_unit
	;;
os)
	check_lanes=lane_check
	clippy_lanes=lane_clippy
	rest_lanes=lane_os
	web_lanes=lane_web
	final_lanes=lane_web_unit
	;;
desktop) rest_lanes="lane_rust lane_feed" ;;
android) rest_lanes=lane_mobile ;;
*) echo "Usage: luna/ci.sh [--list-lanes] [all|os|desktop|android]" >&2; exit 2 ;;
esac
if [ "$list_lanes" -eq 1 ]; then
	# Intentional splitting: these are lists of function names, not paths.
	printf '%s\n' $check_lanes $clippy_lanes $rest_lanes $web_lanes $final_lanes
	exit 0
fi

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

if [ "$SCOPE" != android ]; then
	# The container/host maps ~/.cargo and ~/.npm read-only in this environment;
	# point caches at /tmp when the defaults are unwritable.
	if [ ! -w "${CARGO_HOME:-$HOME/.cargo}" ]; then
	  export CARGO_HOME="${CARGO_HOME:-/tmp/luna-cargo-home}"
	else
	  export CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"
	fi
	mkdir -p "$CARGO_HOME"
fi

# Desktop and OS cuts never initialize or write Android configuration.
if [ "$SCOPE" = all ] || [ "$SCOPE" = android ]; then
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
fi

# Every block below is a lane: its own toolchain and directory, run in
# parallel by the launcher at the end of this file.

# Rust workspace: format, lints, tests. Owns luna/target.
lane_check() {
	echo "==> cargo fmt"
	_t=$(date +%s)
	if [ "$SCOPE" = all ]; then
		cargo fmt --all --check
	else
		cargo fmt -p lunad -p luna-core -p luna-feed --check
	fi
	lap fmt "$_t"

	
	echo "==> cargo test"
	_t=$(date +%s)
	# Output goes to a file so the lunad suite's own "finished in" time can be
	# logged next to the step's total: the difference is compile time. Shown in
	# full here, since the step's log is the only evidence when it fails.
	mkdir -p "$ROOT/target"
	_rc=0
	if [ "$SCOPE" = all ]; then
		set -- --workspace
	else
		set -- -p lunad -p luna-core -p luna-feed
	fi
	LUNA_CONTRACT_RECORD=1 cargo test "$@" >"$ROOT/target/ci-cargo-test.log" 2>&1 || _rc=$?
	cat "$ROOT/target/ci-cargo-test.log"
	_run=$(grep -o 'test result: .* [1-9][0-9][0-9][0-9]* passed.*finished in [0-9.]*s' "$ROOT/target/ci-cargo-test.log" | sed 's/.*finished in //' | head -1)
	echo "$(date +%FT%T) cargo-test: lunad tests ran ${_run:-?} of the step's $(($(date +%s) - _t))s" >>"$ROOT/target/ci-lane-times.log"
	[ "$_rc" -eq 0 ] || exit "$_rc"
	lap cargo-test "$_t"

	# Coverage is a report, not a gate, and re-running the whole workspace test
	# suite just for it doubles the CI time — so it is opt-in (LUNA_COVERAGE=1).
	echo "==> coverage (report only)"
	if [ "${LUNA_COVERAGE:-0}" != "1" ]; then
		echo "    skipped (set LUNA_COVERAGE=1 to re-run the suite for a coverage report)"
	elif cargo llvm-cov --version >/dev/null 2>&1; then
		cargo llvm-cov "$@" --summary-only || echo "    coverage run failed (not gating)"
	else
		echo "    cargo-llvm-cov is not installed; skipping (cargo install cargo-llvm-cov)"
	fi
	sh scripts/test-presence.sh
}

# clippy has its own lane and target dir: it only type-checks, so it needs
# none of lane_check's build output, and a separate dir keeps the two from
# queueing on cargo's build-directory lock.
lane_clippy() {
	echo "==> cargo clippy"
	export CARGO_TARGET_DIR="$ROOT/target/ci-clippy"
	_t=$(date +%s)
	if [ "$SCOPE" = all ]; then
		set -- --workspace
	else
		set -- -p lunad -p luna-core -p luna-feed
	fi
	cargo clippy "$@" --all-targets -- -D warnings
	lap clippy "$_t"
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
	python3 scripts/dedupe-office-fonts_test.py
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

# The GTK desktop app: format and tests (cargo test compiles the whole app).
# Left out on purpose, because ./release already does them on the real artifact
# and a gate run would only repeat minutes of compile: the static musl lunad
# build and smoke (release builds it first, with LTO, and lunad-smoke.sh checks
# that exact binary) and the desktop release build (the Flatpak step).
lane_rust() {
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
	)
}

# Desktop's only path dependency: do not test the daemon workspace here.
lane_feed() {
	cargo fmt -p luna-feed --check
	cargo clippy -p luna-feed --all-targets -- -D warnings
	cargo test -p luna-feed
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
	echo "==> web dependencies and shared UI checks"
	(
	  cd "$ROOT/../shared/ui"
	  npm install --no-audit --no-fund --cache /tmp/luna-npm-cache
	  cd "$ROOT/web"
	  npm install --no-audit --no-fund --cache /tmp/luna-npm-cache
	  # scan:colors, lint and typecheck for luna/web are their own steps in the
	  # luna profile (luna-web-colors, -lint, -typecheck); not repeated here.
	  cd "$ROOT/../shared/ui"
	  npm test
	  npm run typecheck
	  cd "$ROOT/web"
	  if [ "$SCOPE" = all ]; then npm run build; fi
	)

	# Luna Connect's web app and the quick-start leaflet are tested by the
	# connect profile (luna-connect-web-*, luna-quick-start-check), not here.
}


# The luna/web unit tests run last, after every lane, for two reasons: they read
# the lunad response contract that lane_check records (reading it mid-write
# fails the contract tests), and they are the suite that times out when a Rust
# compile is starving them, so they get the whole machine.
lane_web_unit() {
	echo "==> web unit tests"
	(
	  cd "$ROOT/web"
	  npm test -- --run
	)
}

# How many lanes run at once. Measured on an 8-core, 11 GB box: with four lanes
# the rust checks took 974s instead of ~540s alone and the web lane 796s instead
# of ~330s, because a lunad test compile, vite and gradle together exceed RAM and
# the starved tests time out. So two lanes by default: the Rust checks alone
# (they own luna/target and are the long pole) and everything else in the
# other. A job with 16 GB or more may run four.
# The ci runner exports LIBRESERV_CI_MEM_BYTES for host tests (empty/unset means
# unlimited). Node otherwise sizes its heap from the cgroup, which is far too
# small for a vite build under a bounded job, so give it half the share.
LANES=2
if [ -n "${LIBRESERV_CI_MEM_BYTES:-}" ] && [ "$LIBRESERV_CI_MEM_BYTES" -gt 0 ]; then
	if [ "$LIBRESERV_CI_MEM_BYTES" -ge 16000000000 ]; then
		LANES=4
	fi
	heap=$((LIBRESERV_CI_MEM_BYTES / 2 / 1024 / 1024))
	[ "$heap" -lt 1024 ] && heap=1024
	export NODE_OPTIONS="--max-old-space-size=$heap ${NODE_OPTIONS:-}"
fi

# Failure handling: `set -e` is silently switched off inside any function that
# is called from an `||` / `&&` / `if` list, so a lane must never be run that
# way (an earlier version did, and a failing `cargo fmt` let its lane carry on).
# Each lane runs as a plain command in its own `set -e` subshell; an EXIT trap
# reports its wall time and status whether it passed or failed.
lap() { # lap NAME START_EPOCH [STATUS]
	_el=$(( $(date +%s) - $2 ))
	echo "==> lane $1: ${_el}s (exit ${3:-0})"
	mkdir -p "$ROOT/target"
	echo "$(date +%FT%T) lane $1: ${_el}s (exit ${3:-0})" >>"$ROOT/target/ci-lane-times.log"
}

LANE_DIR="$(mktemp -d)"
pids=""

# start LOGNAME LANE...: run the named lane functions one after another in the
# background, logging to LANE_DIR/LOGNAME.log.
start() {
	_log="$LANE_DIR/$1.log"
	shift
	(
		set -e
		for _lane in "$@"; do
			_t0=$(date +%s)
			trap 'lap "$_lane" "$_t0" "$?"' EXIT
			"$_lane"
			trap - EXIT
			lap "$_lane" "$_t0"
		done
	) >"$_log" 2>&1 &
	pids="$pids $!"
}

# lane_check owns luna/target (fmt, tests) and is the long pole, so it
# always runs alone in its lane; the rest are grouped to fit the memory share.
echo "==> $SCOPE checks ($LANES lanes)"
if [ -n "$check_lanes" ]; then start check $check_lanes; fi
case "$LANES" in
4)
	if [ -n "$clippy_lanes" ]; then start clippy $clippy_lanes; fi
	if [ -n "$rest_lanes" ]; then start rest $rest_lanes; fi
	if [ -n "$web_lanes" ]; then start web $web_lanes; fi
	;;
*)
	if [ -n "$clippy_lanes" ]; then start clippy $clippy_lanes; fi
	if [ -n "$rest_lanes$web_lanes" ]; then start rest $rest_lanes $web_lanes; fi
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

for _lane in $final_lanes; do
	_t0=$(date +%s)
	"$_lane"
	lap "$_lane" "$_t0"
done

echo "==> ci ok"

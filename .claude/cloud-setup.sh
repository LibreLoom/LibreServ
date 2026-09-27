#!/bin/bash
# Claude Code cloud environment setup script for LibreServ + Luna.
#
# This file is the reference copy of what goes in the environment's
# "Setup script" box (claude.ai/code → environment menu → Edit). Keep them in
# sync. It runs as root on Ubuntu 24.04 before Claude Code starts, and the
# resulting filesystem is snapshotted and reused by later sessions — but only
# if it finishes in roughly five minutes. So it installs machine-level
# toolchains only (apt packages, Go, Rust, Android SDK, fj) and runs the
# independent downloads in parallel. Everything that depends on the checkout
# (npm ci, builds, mock drives, Podman socket, fj auth) lives in the
# SessionStart hook (.claude/session-start.sh), which runs every session.
#
# Needs network access "Full" (go.dev, codeberg.org, dl.google.com, flathub).
# Must exit 0 or the session will not start, so failures are logged instead.
set -uo pipefail
export DEBIAN_FRONTEND=noninteractive

GO_VERSION=1.26.6
RUST_VERSION=1.96.0
FJ_VERSION=0.6.0
ANDROID_SDK=/usr/local/android-sdk
LOG_DIR=/var/log/libreserv-setup
mkdir -p "$LOG_DIR"
rm -f "$LOG_DIR/failed"

# Run a step with its output in its own log; record failures without aborting.
# The subshell runs with errexit on so a step stops at its first failing
# command. (It must not sit directly in an `if`, which would disable errexit.)
step() {
  local name="$1"; shift
  ( set -e; "$@" ) >"$LOG_DIR/$name.log" 2>&1
  if [ $? -eq 0 ]; then
    echo ">> $name ok"
  else
    echo ">> $name FAILED (see $LOG_DIR/$name.log)" | tee -a "$LOG_DIR/failed"
  fi
}

APT_PACKAGES=(
  # Podman for ./ci and app runtime tests
  podman podman-compose uidmap slirp4netns fuse-overlayfs catatonit
  # Build basics
  build-essential pkg-config libssl-dev sqlite3 unzip bzip2
  # Luna desktop (GTK 4 + libadwaita) plus the GTK 3/WebKit deps install.sh carries
  libgtk-4-dev libadwaita-1-dev
  libgtk-3-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev patchelf libxdo-dev
  # Android unit tests
  openjdk-17-jdk-headless
  # ./release.sh --luna: musl lunad, ISO, Flatpak, Windows installer, signing
  musl-tools xorriso xz-utils live-build debootstrap flatpak flatpak-builder
  nsis gcc-mingw-w64-x86-64 g++-mingw-w64-x86-64 minisign
)

apt_packages() {
  apt-get update -qq
  apt-get -o Dpkg::Options::=--force-confold -o Dpkg::Options::=--force-confdef \
    install -y -qq --no-install-recommends "${APT_PACKAGES[@]}"
}

add_flathub() {
  flatpak remote-add --user --if-not-exists flathub https://flathub.org/repo/flathub.flatpakrepo
}

install_go() {
  # /usr/local/go/bin is first on the image's PATH, so replacing it in place
  # is enough. (GOTOOLCHAIN=auto would also fetch go.mod's toolchain lazily.)
  [ "$(GOTOOLCHAIN=local /usr/local/go/bin/go env GOVERSION 2>/dev/null)" = "go${GO_VERSION}" ] && return 0
  curl -fsSL -o /tmp/go.tgz "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz"
  rm -rf /usr/local/go
  tar -C /usr/local -xzf /tmp/go.tgz
  rm -f /tmp/go.tgz
  ln -sf /usr/local/go/bin/go /usr/local/bin/go
  ln -sf /usr/local/go/bin/gofmt /usr/local/bin/gofmt
}

install_rust() {
  # The image ships rustup under /root/.cargo; luna/ needs 1.96 (edition 2024),
  # clippy + rustfmt for luna/ci.sh, and the musl target for the ISO lunad.
  rustup toolchain install "$RUST_VERSION" --profile minimal \
    --component clippy,rustfmt --target x86_64-unknown-linux-musl
  rustup default "$RUST_VERSION"
}

install_fj() {
  # Forgejo CLI. The session hook puts the repo's wrapper at /usr/local/bin/fj.
  [ -x /usr/local/libexec/fj ] && return 0
  local tmp; tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/fj.tgz" \
    "https://codeberg.org/forgejo-contrib/forgejo-cli/releases/download/v${FJ_VERSION}/forgejo-cli-x86_64-linux.tar.gz"
  tar -xzf "$tmp/fj.tgz" -C "$tmp"
  install -D -m 0755 "$tmp/fj" /usr/local/libexec/fj
  rm -rf "$tmp"
}

install_android_sdk() {
  # Unit tests only (./gradlew testDebugUnitTest): platform + build-tools 34.
  if [ ! -x "$ANDROID_SDK/cmdline-tools/latest/bin/sdkmanager" ]; then
    local tmp; tmp="$(mktemp -d)"
    curl -fsSL -o "$tmp/tools.zip" \
      https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip
    mkdir -p "$ANDROID_SDK/cmdline-tools"
    unzip -q "$tmp/tools.zip" -d "$tmp"
    rm -rf "$ANDROID_SDK/cmdline-tools/latest"
    mv "$tmp/cmdline-tools" "$ANDROID_SDK/cmdline-tools/latest"
    rm -rf "$tmp"
  fi
  yes | "$ANDROID_SDK/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$ANDROID_SDK" --licenses >/dev/null || true
  "$ANDROID_SDK/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$ANDROID_SDK" \
    "platform-tools" "platforms;android-34" "build-tools;34.0.0"
}

# Downloads that don't need apt run alongside it; the Android SDK needs unzip.
step go install_go &
step rust install_rust &
step fj install_fj &
step apt apt_packages
step android install_android_sdk &
step flathub add_flathub &
wait

cat >/etc/profile.d/libreserv.sh <<EOF
export ANDROID_HOME=$ANDROID_SDK
export ANDROID_SDK_ROOT=$ANDROID_SDK
export XDG_RUNTIME_DIR=/run/user/0
export DOCKER_HOST=unix:///run/user/0/podman/podman.sock
EOF

if [ -f "$LOG_DIR/failed" ]; then
  echo ">> Setup finished with failures:"; cat "$LOG_DIR/failed"
else
  echo ">> Setup complete"
fi
exit 0

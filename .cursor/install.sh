#!/usr/bin/env bash
# Cloud Agent install step for LibreServ + Luna.
#
# Idempotent: safe to run repeatedly and against a cached/partially prepared
# checkout. Prepares the backend (Go 1.26 + config + modules), LibreServ
# frontend (Node deps + build), Luna (Rust 1.96 + lunad build + web deps),
# and Podman (CI + app-runtime tests; the API socket is started in start.sh).
# No long-running processes are started here — the dev servers live in the
# environment's `terminals` (LibreServ :8080/:3000, Luna :8090/:3001).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GO_VERSION="1.26.6"
RUST_VERSION="1.96.0"

# Run a command with root privileges whether or not we already are root.
as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    sudo "$@"
  fi
}

# ── 1. Go toolchain ──────────────────────────────────────────────────────────
# The repo requires Go 1.26 (see server/backend/go.mod). The default image ships
# an older Go, so install 1.26 to /usr/local/go and expose it on PATH via
# /usr/local/bin (which precedes /usr/bin) so every future shell picks it up.
install_go() {
  local want="go${GO_VERSION}"
  if [ -x /usr/local/go/bin/go ] && [ "$(/usr/local/go/bin/go env GOVERSION 2>/dev/null)" = "$want" ]; then
    echo ">> Go ${GO_VERSION} already installed"
  else
    echo ">> Installing Go ${GO_VERSION}"
    local tarball="go${GO_VERSION}.linux-amd64.tar.gz"
    curl -fsSL -o "/tmp/${tarball}" "https://go.dev/dl/${tarball}"
    as_root rm -rf /usr/local/go
    as_root tar -C /usr/local -xzf "/tmp/${tarball}"
    rm -f "/tmp/${tarball}"
  fi
  as_root ln -sf /usr/local/go/bin/go /usr/local/bin/go
  as_root ln -sf /usr/local/go/bin/gofmt /usr/local/bin/gofmt
  go version
}
install_go

# ── 2. Forgejo CLI (fj) ──────────────────────────────────────────────────────
# LibreServ is developed on Forgejo (gt.plainskill.net); fj is the Forgejo CLI
# used for issues and comments. Installing the binary here bakes it into the
# baseline; the per-boot .cursor/start.sh authenticates it from the FORGEJO_TOKEN
# secret. Git remotes are left as Cursor provisioned them.
FJ_VERSION="0.6.0"
install_fj() {
  local real="/usr/local/libexec/fj"
  local wrapper="${REPO_ROOT}/.cursor/fj-wrapper.sh"
  if [ -x "${real}" ] && [ -x /usr/local/bin/fj ]; then
    echo ">> fj already installed"
    as_root install -m 0755 "${wrapper}" /usr/local/bin/fj
    return
  fi
  echo ">> Installing fj (Forgejo CLI) ${FJ_VERSION}"
  local tmp; tmp="$(mktemp -d)"
  curl -fsSL -o "${tmp}/fj.tar.gz" \
    "https://codeberg.org/forgejo-contrib/forgejo-cli/releases/download/v${FJ_VERSION}/forgejo-cli-x86_64-linux.tar.gz"
  tar -xzf "${tmp}/fj.tar.gz" -C "${tmp}"
  as_root mkdir -p /usr/local/libexec
  if [ -x /usr/local/bin/fj ] && [ ! -x "${real}" ]; then
    as_root mv /usr/local/bin/fj "${real}"
  fi
  as_root install -m 0755 "${tmp}/fj" "${real}"
  rm -rf "${tmp}"
  as_root install -m 0755 "${wrapper}" /usr/local/bin/fj
  echo ">> fj installed"
}
install_fj

# ── 3. Podman ────────────────────────────────────────────────────────────────
# LibreServ CI (`./ci`) and app runtime tests need Podman, not Docker. The
# default Cloud Agent image does not ship it. Install the CLI + compose helper
# and rootless extras; the per-boot start.sh brings up the API socket.
install_podman() {
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  as_root mkdir -p "${XDG_RUNTIME_DIR}"
  as_root chown "$(id -u):$(id -g)" "${XDG_RUNTIME_DIR}" || true

  if command -v podman >/dev/null 2>&1; then
    echo ">> Podman already installed: $(podman --version)"
  else
    echo ">> Installing Podman"
    as_root apt-get update -qq
    # force-confold: fuse3 asks about /etc/fuse.conf on Cloud Agent images.
    as_root env DEBIAN_FRONTEND=noninteractive \
      apt-get -o Dpkg::Options::=--force-confold -o Dpkg::Options::=--force-confdef \
      install -y -qq podman podman-compose uidmap slirp4netns fuse-overlayfs catatonit
  fi

  # So later shells (and ./ci) find the Docker-compatible API socket.
  as_root tee /etc/profile.d/libreserv-podman.sh >/dev/null <<'EOF'
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DOCKER_HOST="unix://${XDG_RUNTIME_DIR}/podman/podman.sock"
EOF
  as_root chmod 0644 /etc/profile.d/libreserv-podman.sh
  # shellcheck disable=SC1091
  . /etc/profile.d/libreserv-podman.sh

  podman --version
  podman compose version 2>/dev/null || podman-compose --version 2>/dev/null || true
}
install_podman

# ── 4. Rust toolchain (Luna) ─────────────────────────────────────────────────
# Luna requires Rust 1.96 with edition 2024 (see luna/Cargo.toml). The default
# Cloud Agent image ships an older toolchain, so install 1.96 via rustup and
# expose cargo/rustc on PATH for every future shell.
install_rust() {
  export RUSTUP_HOME="${RUSTUP_HOME:-/usr/local/rustup}"
  export CARGO_HOME="${CARGO_HOME:-/usr/local/cargo}"

  if ! command -v rustup >/dev/null 2>&1; then
    echo ">> Installing rustup (default toolchain ${RUST_VERSION})"
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --no-modify-path --default-toolchain "${RUST_VERSION}"
  fi

  # shellcheck disable=SC1091
  [ -f "${CARGO_HOME}/env" ] && source "${CARGO_HOME}/env"

  echo ">> Ensuring Rust ${RUST_VERSION}"
  rustup install "${RUST_VERSION}"
  rustup default "${RUST_VERSION}"

  as_root ln -sf "${CARGO_HOME}/bin/cargo" /usr/local/bin/cargo
  as_root ln -sf "${CARGO_HOME}/bin/rustc" /usr/local/bin/rustc
  as_root ln -sf "${CARGO_HOME}/bin/rustup" /usr/local/bin/rustup

  rustc --version
  cargo --version
}
install_rust

# ── 5. Backend (Go) ──────────────────────────────────────────────────────────
echo ">> Preparing backend"
cd "${REPO_ROOT}/server/backend"
# The server refuses to run without a config file; seed it from the example on
# first setup and leave any existing local config untouched.
if [ ! -f configs/libreserv.yaml ]; then
  cp configs/libreserv.yaml.example configs/libreserv.yaml
  echo ">> Created configs/libreserv.yaml from example"
fi
go mod download
# Fetch the restic binary used by the backup subsystem. Best-effort: the backend
# falls back to a tar-based backup path when restic is absent.
make restic-fetch || echo ">> restic fetch skipped (backups will use the tar fallback)"

# ── 6. Frontend (Node) ───────────────────────────────────────────────────────
echo ">> Preparing frontend"
cd "${REPO_ROOT}/server/frontend"
npm ci
# Build once so server/backend/OS/dist exists (the backend can serve the built
# UI directly, and the embedfront release build expects it). Day-to-day dev uses
# the Vite dev server from the `terminals` config.
npm run build

# ── 7. Tauri Linux deps (Luna desktop CI) ─────────────────────────────────────
# luna/ci.sh builds desktop/src-tauri (GTK + WebKit). Without these, gdk-sys
# fails at pkg-config time on a stock Cloud Agent image.
install_tauri_linux_deps() {
  if pkg-config --exists gdk-3.0 webkit2gtk-4.1 2>/dev/null; then
    echo ">> Tauri Linux deps already present (gdk-3.0 + webkit2gtk-4.1)"
    return
  fi
  echo ">> Installing Tauri Linux build dependencies"
  as_root apt-get update -qq
  as_root env DEBIAN_FRONTEND=noninteractive \
    apt-get -o Dpkg::Options::=--force-confold -o Dpkg::Options::=--force-confdef \
    install -y -qq \
      build-essential \
      pkg-config \
      libgtk-3-dev \
      libwebkit2gtk-4.1-dev \
      libayatana-appindicator3-dev \
      librsvg2-dev \
      patchelf \
      libssl-dev \
      libxdo-dev
}
install_tauri_linux_deps

# ── 8. Android SDK (Luna mobile unit tests) ───────────────────────────────────
# luna/ci.sh runs ./gradlew testDebugUnitTest. Unit tests need platform +
# build-tools; no emulator.
install_android_sdk() {
  local sdk_root="/usr/local/android-sdk"
  local tools_zip="commandlinetools-linux-11076708_latest.zip"
  local tools_url="https://dl.google.com/android/repository/${tools_zip}"

  if [ -x "${sdk_root}/cmdline-tools/latest/bin/sdkmanager" ] \
    && [ -d "${sdk_root}/platforms/android-34" ] \
    && [ -d "${sdk_root}/build-tools/34.0.0" ]; then
    echo ">> Android SDK already installed at ${sdk_root}"
  else
    echo ">> Installing Android SDK cmdline-tools + platform 34"
    as_root apt-get update -qq
    as_root env DEBIAN_FRONTEND=noninteractive \
      apt-get -o Dpkg::Options::=--force-confold -o Dpkg::Options::=--force-confdef \
      install -y -qq unzip openjdk-17-jdk-headless
    local tmp; tmp="$(mktemp -d)"
    curl -fsSL -o "${tmp}/${tools_zip}" "${tools_url}"
    as_root mkdir -p "${sdk_root}/cmdline-tools"
    as_root unzip -q "${tmp}/${tools_zip}" -d "${sdk_root}/cmdline-tools"
    if [ -d "${sdk_root}/cmdline-tools/cmdline-tools" ]; then
      as_root rm -rf "${sdk_root}/cmdline-tools/latest"
      as_root mv "${sdk_root}/cmdline-tools/cmdline-tools" "${sdk_root}/cmdline-tools/latest"
    fi
    rm -rf "${tmp}"
    yes | as_root env JAVA_HOME="${JAVA_HOME:-}" \
      "${sdk_root}/cmdline-tools/latest/bin/sdkmanager" --sdk_root="${sdk_root}" --licenses \
      >/tmp/android-sdk-licenses.log 2>&1 || true
    as_root "${sdk_root}/cmdline-tools/latest/bin/sdkmanager" --sdk_root="${sdk_root}" \
      "platform-tools" "platforms;android-34" "build-tools;34.0.0"
    as_root chmod -R a+rX "${sdk_root}"
  fi

  as_root tee /etc/profile.d/android-sdk.sh >/dev/null <<EOF
export ANDROID_HOME=${sdk_root}
export ANDROID_SDK_ROOT=${sdk_root}
export PATH="\${ANDROID_HOME}/cmdline-tools/latest/bin:\${ANDROID_HOME}/platform-tools:\${PATH}"
EOF
  as_root chmod 0644 /etc/profile.d/android-sdk.sh
  # shellcheck disable=SC1091
  . /etc/profile.d/android-sdk.sh

  mkdir -p "${REPO_ROOT}/luna/mobile"
  echo "sdk.dir=${sdk_root}" > "${REPO_ROOT}/luna/mobile/local.properties"
}
install_android_sdk

# ── 9. Luna (Rust daemon + web) ───────────────────────────────────────────────
# lunad embeds crates/lunad/web/dist at compile time (include_dir). build.rs
# writes a stub "build the web app first" page when dist is missing — so we MUST
# run the Vite production build before cargo, or :8090 serves that stub forever.
echo ">> Preparing Luna"
cd "${REPO_ROOT}/luna/web"
npm ci
npm run build
cd "${REPO_ROOT}/luna"
make build-daemon
make mock-pssd

echo ">> LibreServ + Luna install complete"

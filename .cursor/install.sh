#!/usr/bin/env bash
# Cloud Agent install step for LibreServ.
#
# Idempotent: safe to run repeatedly and against a cached/partially prepared
# checkout. Prepares the backend (Go 1.26 + config + modules) and frontend
# (Node deps + build). No long-running processes are started here — the dev
# servers live in the environment's `terminals`.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GO_VERSION="1.26.6"

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
# used for issues and pull requests. Installing the binary here bakes it into the
# baseline; the per-boot .cursor/start.sh authenticates it from the FORGEJO_TOKEN
# secret.
FJ_VERSION="0.6.0"
install_fj() {
  if command -v fj >/dev/null 2>&1; then
    echo ">> fj already installed"
    return
  fi
  echo ">> Installing fj (Forgejo CLI) ${FJ_VERSION}"
  local tmp; tmp="$(mktemp -d)"
  curl -fsSL -o "${tmp}/fj.tar.gz" \
    "https://codeberg.org/forgejo-contrib/forgejo-cli/releases/download/v${FJ_VERSION}/forgejo-cli-x86_64-linux.tar.gz"
  tar -xzf "${tmp}/fj.tar.gz" -C "${tmp}"
  as_root install -m 0755 "${tmp}/fj" /usr/local/bin/fj
  rm -rf "${tmp}"
  echo ">> fj installed"
}
install_fj

# ── 3. Backend (Go) ──────────────────────────────────────────────────────────
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

# ── 4. Frontend (Node) ───────────────────────────────────────────────────────
echo ">> Preparing frontend"
cd "${REPO_ROOT}/server/frontend"
npm ci
# Build once so server/backend/OS/dist exists (the backend can serve the built
# UI directly, and the embedfront release build expects it). Day-to-day dev uses
# the Vite dev server from the `terminals` config.
npm run build

echo ">> LibreServ install complete"

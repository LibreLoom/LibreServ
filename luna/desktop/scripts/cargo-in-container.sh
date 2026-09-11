#!/usr/bin/env bash
# Run cargo for luna/desktop inside an ubuntu:24.04 image (GTK 4.14 / libadwaita 1.5).
# Used when the host GTK is too old (< 4.14). Build output lands in
# target/container so it never mixes with host builds.
set -euo pipefail

DESKTOP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${LUNA_DESKTOP_BUILD_IMAGE:-localhost/luna-desktop-build:24.04}"

if ! podman image exists "$IMAGE"; then
  podman build -t "$IMAGE" -f "$DESKTOP_DIR/Containerfile.build" "$DESKTOP_DIR"
fi

tty_args=()
if [ -t 1 ]; then
  tty_args=(-t)
fi

exec podman run --rm -i "${tty_args[@]}" \
  --userns=keep-id \
  -v "$DESKTOP_DIR:/src" \
  -v luna-desktop-cargo-registry:/usr/local/cargo/registry \
  -e CARGO_TARGET_DIR=/src/target/container \
  -e CARGO_HOME=/usr/local/cargo \
  -w /src \
  "$IMAGE" cargo "$@"

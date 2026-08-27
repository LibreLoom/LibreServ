#!/bin/sh
# Full rapidinstall ISO: web UI → musl lunad → Alpine rootfs → hybrid ISO.
# Needs: rustup + musl target, npm, Podman, network for apk.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
ARCH="${ARCH:-x86_64}"
MUSL_TARGET="${MUSL_TARGET:-${ARCH}-unknown-linux-musl}"

echo "==> Luna web UI"
make web

if ! rustup target list --installed | grep -qx "$MUSL_TARGET"; then
	echo "==> rustup target add $MUSL_TARGET"
	rustup target add "$MUSL_TARGET"
fi

if command -v musl-gcc >/dev/null 2>&1; then
	export CC_x86_64_unknown_linux_musl=musl-gcc
	export CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER=musl-gcc
fi

echo "==> lunad ($MUSL_TARGET release)"
cargo build --release -p lunad --target "$MUSL_TARGET"
export LUNAD_BIN="$ROOT/target/${MUSL_TARGET}/release/lunad"
if [ ! -x "$LUNAD_BIN" ]; then
	echo "missing $LUNAD_BIN" >&2
	exit 1
fi

echo "==> rootfs"
"$ROOT/os/build-rootfs.sh"

echo "==> OS slot image (OTA + factory)"
"$ROOT/os/make-image.sh"

echo "==> ISO"
"$ROOT/os/make-iso.sh"

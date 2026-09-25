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

# shellcheck source=lib/musl-link.sh
. "$ROOT/os/lib/musl-link.sh"
# Drop a host RUSTFLAGS that could add -static-pie to rust-lld.
# luna_musl_export scopes crt-static to the musl triple only.
unset RUSTFLAGS
luna_musl_export "$MUSL_TARGET"

echo "==> lunad ($MUSL_TARGET static-pie release)"
cargo build --release -p lunad --bin lunad --bin luna-console --target "$MUSL_TARGET"
export LUNA_CONSOLE_BIN="$ROOT/target/${MUSL_TARGET}/release/luna-console"
export LUNAD_BIN="$ROOT/target/${MUSL_TARGET}/release/lunad"
if [ ! -x "$LUNAD_BIN" ]; then
	echo "missing $LUNAD_BIN" >&2
	exit 1
fi
if [ ! -x "$LUNA_CONSOLE_BIN" ]; then
	echo "missing $LUNA_CONSOLE_BIN" >&2
	exit 1
fi
echo "==> musl static-pie smoke (Alpine)"
luna_musl_smoke_lunad "$LUNAD_BIN"
luna_musl_smoke_console "$LUNA_CONSOLE_BIN"

echo "==> EuroOffice pack (baked into the ISO, lands on LUNA_DATA)"
if [ ! -f "$ROOT/os/dist/eurooffice-pack.tar.zst" ]; then
	"$ROOT/scripts/build-eurooffice-pack.sh"
fi

echo "==> draw.io pack (baked into the ISO, lands on LUNA_DATA)"
if [ ! -f "$ROOT/os/dist/drawio-pack.tar.zst" ]; then
	"$ROOT/scripts/build-drawio-pack.sh"
fi

echo "==> rootfs"
"$ROOT/os/build-rootfs.sh"

echo "==> OS slot image (OTA + factory)"
"$ROOT/os/make-image.sh"

echo "==> ISO"
"$ROOT/os/make-iso.sh"

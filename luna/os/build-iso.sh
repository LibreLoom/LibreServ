#!/bin/sh
# Full rapidinstall ISO: web UI → musl lunad → Alpine rootfs → slot image
# (.img.xz) → hybrid ISO. Dev wrapper; the release tool runs the in-container
# steps under os/build/ directly.
# Needs: rustup + musl target, npm, rootless Podman (no sudo), network.
# When the OS inputs have not changed since the last image (see
# os/build/input-hash.sh), web, lunad, rootfs and image are skipped and the
# ISO just embeds the image already in os/dist/. LUNA_OS_FORCE=1 rebuilds.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
ARCH="${ARCH:-x86_64}"
MUSL_TARGET="${MUSL_TARGET:-${ARCH}-unknown-linux-musl}"

# shellcheck source=lib/host-podman.sh
. "$ROOT/os/lib/host-podman.sh"
luna_need_podman

if luna_os_image_current "$ROOT/os/dist"; then
	echo "==> OS image is up to date for these inputs: skipping web, lunad, rootfs and image"
else
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

	echo "==> rootfs"
	"$ROOT/os/build-rootfs.sh"

	echo "==> OS slot image (OTA + factory, .img.xz)"
	"$ROOT/os/make-image.sh"
fi

echo "==> EuroOffice pack (baked into the ISO, lands on LUNA_DATA)"
if [ ! -f "$ROOT/os/dist/eurooffice-pack.tar.zst" ]; then
	"$ROOT/scripts/build-eurooffice-pack.sh"
fi

echo "==> draw.io pack (baked into the ISO, lands on LUNA_DATA)"
if [ ! -f "$ROOT/os/dist/drawio-pack.tar.zst" ]; then
	"$ROOT/scripts/build-drawio-pack.sh"
fi

echo "==> ISO"
"$ROOT/os/make-iso.sh"

#!/usr/bin/env bash
# Build a Linux AppImage for Luna Desktop (demo / CI convenience).
# Product distribution on Linux is Flatpak — see packaging/flatpak/.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT_DIR="${OUT_DIR:-$ROOT/release}"
TOOLS_DIR="${TOOLS_DIR:-/tmp/luna-appimage-tools}"
VERSION="${VERSION:-0.1.0}"
APPIMAGE_NAME="Luna-Desktop-${VERSION}-amd64.AppImage"

mkdir -p "$TOOLS_DIR" "$OUT_DIR"
cd "$TOOLS_DIR"

if [ ! -x linuxdeploy-x86_64.AppImage ]; then
  curl -fsSL -o linuxdeploy-x86_64.AppImage \
    https://github.com/linuxdeploy/linuxdeploy/releases/download/continuous/linuxdeploy-x86_64.AppImage
  chmod +x linuxdeploy-x86_64.AppImage
fi
if [ ! -x linuxdeploy-plugin-gtk.sh ]; then
  curl -fsSL -o linuxdeploy-plugin-gtk.sh \
    https://raw.githubusercontent.com/linuxdeploy/linuxdeploy-plugin-gtk/master/linuxdeploy-plugin-gtk.sh
  chmod +x linuxdeploy-plugin-gtk.sh
fi

cd "$ROOT"
cargo build --release

APPDIR="$TOOLS_DIR/AppDir"
rm -rf "$APPDIR"
mkdir -p "$APPDIR/usr/bin" "$APPDIR/usr/share/applications" "$APPDIR/usr/share/icons/hicolor/256x256/apps"

cp target/release/luna-desktop "$APPDIR/usr/bin/luna-desktop"
cp resources/org.libreloom.LunaDesktop.desktop "$APPDIR/usr/share/applications/"
# linuxdeploy expects the icon basename to match Icon= in the desktop file.
cp resources/icon.png "$APPDIR/usr/share/icons/hicolor/256x256/apps/org.libreloom.LunaDesktop.png"
# Also place at AppDir root for older toolchains.
cp resources/icon.png "$APPDIR/org.libreloom.LunaDesktop.png"
cp resources/org.libreloom.LunaDesktop.desktop "$APPDIR/"

export APPIMAGE_EXTRACT_AND_RUN=1
export LINUXDEPLOY_OUTPUT_VERSION="$VERSION"
export LDAI_OUTPUT="$OUT_DIR/$APPIMAGE_NAME"
export PATH="$TOOLS_DIR:$PATH"

cd "$TOOLS_DIR"
./linuxdeploy-x86_64.AppImage \
  --appdir "$APPDIR" \
  --executable "$APPDIR/usr/bin/luna-desktop" \
  --desktop-file "$APPDIR/org.libreloom.LunaDesktop.desktop" \
  --icon-file "$APPDIR/org.libreloom.LunaDesktop.png" \
  --plugin gtk \
  --output appimage

# linuxdeploy may write next to AppDir; normalize into OUT_DIR.
if [ ! -f "$OUT_DIR/$APPIMAGE_NAME" ]; then
  newest="$(ls -t "$TOOLS_DIR"/*.AppImage 2>/dev/null | head -1 || true)"
  if [ -n "$newest" ]; then
    mv -f "$newest" "$OUT_DIR/$APPIMAGE_NAME"
  fi
fi

if [ ! -f "$OUT_DIR/$APPIMAGE_NAME" ]; then
  echo "AppImage was not produced" >&2
  exit 1
fi

chmod +x "$OUT_DIR/$APPIMAGE_NAME"
sha256sum "$OUT_DIR/$APPIMAGE_NAME" | tee "$OUT_DIR/$APPIMAGE_NAME.sha256"
echo "Built $OUT_DIR/$APPIMAGE_NAME"

#!/usr/bin/env bash
# Build Luna Desktop for macOS as a .app bundle + .dmg installer.
#
# Runs ON a Mac (no cross-compile from Linux — GTK needs the macOS SDK).
#   brew install gtk4 libadwaita dylibbundler
#   bash packaging/macos/build.sh
#
# Output: desktop/release/Luna-Desktop-<version>-macos-<arch>.dmg
#
# Options (env):
#   UNIVERSAL=1            build arm64+x86_64 and lipo into a universal binary
#   CODESIGN_IDENTITY      e.g. "Developer ID Application: …" (default: ad-hoc
#                          sign, which Apple Silicon requires at minimum)
#   NOTARYTOOL_PROFILE     keychain profile for `xcrun notarytool` — when set,
#                          the dmg is submitted for notarization and stapled
#   LUNA_DESKTOP_VERSION   version string (default: 0.0.21)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"   # luna/
DESKTOP="$ROOT/desktop"
OUT_DIR="${OUT_DIR:-$DESKTOP/release}"
VERSION="${LUNA_DESKTOP_VERSION:-0.0.21}"
APP_NAME="Luna Desktop"
BUNDLE_ID="org.libreloom.LunaDesktop"
BIN_NAME="luna-desktop"
ARCH="$(uname -m)" # arm64 or x86_64
if [ "${UNIVERSAL:-0}" = "1" ]; then
	ARCH="universal"
fi
DMG_NAME="Luna-Desktop-${VERSION}-macos-${ARCH}.dmg"

[ "$(uname -s)" = "Darwin" ] || { echo "ERROR: this script must run on macOS" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || { echo "ERROR: missing $1${2:+ (brew install $2)}" >&2; exit 1; }; }
need brew
need cargo rustup
need pkg-config pkgconf
need dylibbundler dylibbundler
need iconutil
need sips
need hdiutil
need codesign
need otool
need glib-compile-schemas glib
pkg-config --exists gtk4 libadwaita-1 || {
	echo "ERROR: GTK4/libadwaita not found (brew install gtk4 libadwaita)" >&2
	exit 1
}
BREW_PREFIX="$(brew --prefix)"

STAGE="$OUT_DIR/macos-stage"
APP="$STAGE/$APP_NAME.app"
rm -rf "$STAGE"
mkdir -p "$OUT_DIR" "$APP/Contents/MacOS" "$APP/Contents/Resources" "$APP/Contents/Resources/lib" "$APP/Contents/Resources/share"

# --- Build ---
cd "$DESKTOP"
if [ "${UNIVERSAL:-0}" = "1" ]; then
	# Both-arch builds need GTK/libadwaita for each arch — i.e. an arm64 brew
	# prefix AND a Rosetta x86_64 prefix (usually /opt/homebrew + /usr/local).
	rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null
	cargo build --release --target aarch64-apple-darwin
	cargo build --release --target x86_64-apple-darwin
	lipo -create \
		"target/aarch64-apple-darwin/release/$BIN_NAME" \
		"target/x86_64-apple-darwin/release/$BIN_NAME" \
		-output "$APP/Contents/MacOS/$BIN_NAME"
else
	cargo build --release
	cp "target/release/$BIN_NAME" "$APP/Contents/MacOS/$BIN_NAME"
fi

# --- Icon ---
ICONSET="$STAGE/icon.iconset"
mkdir -p "$ICONSET"
SRC_ICON="$DESKTOP/resources/icon.png"
for spec in "16 icon_16x16.png" "32 icon_16x16@2x.png" "32 icon_32x32.png" \
	"64 icon_32x32@2x.png" "128 icon_128x128.png" "256 icon_128x128@2x.png" \
	"256 icon_256x256.png" "512 icon_256x256@2x.png" "512 icon_512x512.png" \
	"1024 icon_512x512@2x.png"; do
	set -- $spec
	sips -z "$1" "$1" "$SRC_ICON" --out "$ICONSET/$2" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/LunaDesktop.icns"

# --- Info.plist ---
cat >"$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleName</key><string>${APP_NAME}</string>
	<key>CFBundleDisplayName</key><string>${APP_NAME}</string>
	<key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
	<key>CFBundleExecutable</key><string>${BIN_NAME}</string>
	<key>CFBundleIconFile</key><string>LunaDesktop.icns</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleShortVersionString</key><string>${VERSION}</string>
	<key>CFBundleVersion</key><string>${VERSION}</string>
	<key>LSMinimumSystemVersion</key><string>12.0</string>
	<key>NSHighResolutionCapable</key><true/>
	<key>NSSupportsAutomaticGraphicsSwitching</key><true/>
	<key>NSLocalNetworkUsageDescription</key>
	<string>Luna Desktop connects to your Luna on your local network to back up and sync files.</string>
</dict>
</plist>
PLIST

# --- Bundle GTK/libadwaita dylibs ---
# dylibbundler rewrites every brew-linked dylib to @executable_path/../Resources/lib.
# gdk-pixbuf loaders are dlopen'd plugins — not link-time deps — so each is
# passed as an extra -x input to get copied and dep-fixed too.
BUNDLE_INPUTS=(-x "$APP/Contents/MacOS/$BIN_NAME")
PIXBUF_LOADERS_DIR="$(find "$BREW_PREFIX/lib/gdk-pixbuf-2.0" -type d -name loaders 2>/dev/null | head -1 || true)"
if [ -n "$PIXBUF_LOADERS_DIR" ]; then
	for loader in "$PIXBUF_LOADERS_DIR"/*.so; do
		BUNDLE_INPUTS+=(-x "$loader")
	done
fi
dylibbundler -od -of -b \
	"${BUNDLE_INPUTS[@]}" \
	-d "$APP/Contents/Resources/lib" \
	-p "@executable_path/../Resources/lib" \
	-s "$BREW_PREFIX/lib"

# Icon themes + GSettings schemas — GTK warns-and-continues without them, but
# named icons (folders, status) need a theme and adwaita settings need schemas.
for theme in Adwaita hicolor; do
	if [ -d "$BREW_PREFIX/share/icons/$theme" ]; then
		mkdir -p "$APP/Contents/Resources/share/icons"
		cp -R "$BREW_PREFIX/share/icons/$theme" "$APP/Contents/Resources/share/icons/"
	fi
done

# GSettings schemas — adwaita/glib warn-and-continue without them, but bundling
# keeps preference backends quiet.
SCHEMA_SRC="$BREW_PREFIX/share/glib-2.0/schemas"
if [ -d "$SCHEMA_SRC" ]; then
	mkdir -p "$APP/Contents/Resources/share/glib-2.0/schemas"
	cp "$SCHEMA_SRC"/*.xml "$APP/Contents/Resources/share/glib-2.0/schemas/" 2>/dev/null || true
	glib-compile-schemas "$APP/Contents/Resources/share/glib-2.0/schemas" 2>/dev/null || true
fi

# gdk-pixbuf loaders.cache — generated now against the staged loaders with the
# bundle path swapped for __RES__; the app resolves __RES__ to the real install
# location at startup (Contents/Resources may move with the .app).
QUERY_LOADERS="$(command -v gdk-pixbuf-query-loaders || true)"
STAGED_LOADERS=("$APP"/Contents/Resources/lib/libpixbufloader-*.so)
if [ -n "$QUERY_LOADERS" ] && [ -e "${STAGED_LOADERS[0]}" ]; then
	"$QUERY_LOADERS" "${STAGED_LOADERS[@]}" |
		sed "s|$APP/Contents/Resources|__RES__|g" \
			>"$APP/Contents/Resources/lib/gdk-pixbuf-loaders.cache.tmpl"
fi

# --- Verify no Homebrew paths remain in the binary ---
LEFTOVER="$(otool -L "$APP/Contents/MacOS/$BIN_NAME" | grep -E "$BREW_PREFIX|/usr/local" || true)"
if [ -n "$LEFTOVER" ]; then
	echo "WARNING: binary still references host dylibs:" >&2
	echo "$LEFTOVER" >&2
fi

# --- Sign (ad-hoc by default; real identity via CODESIGN_IDENTITY) ---
SIGN_ID="${CODESIGN_IDENTITY:--}"
codesign --force --deep --sign "$SIGN_ID" "$APP"

# --- DMG ---
DMG_STAGE="$STAGE/dmg"
mkdir -p "$DMG_STAGE"
cp -R "$APP" "$DMG_STAGE/"
ln -s /Applications "$DMG_STAGE/Applications"
hdiutil create -volname "$APP_NAME" -srcfolder "$DMG_STAGE" -ov -format UDZO "$OUT_DIR/$DMG_NAME"

# --- Notarize (optional) ---
if [ -n "${NOTARYTOOL_PROFILE:-}" ]; then
	xcrun notarytool submit "$OUT_DIR/$DMG_NAME" --keychain-profile "$NOTARYTOOL_PROFILE" --wait
	xcrun stapler staple "$OUT_DIR/$DMG_NAME"
fi

echo "==> $OUT_DIR/$DMG_NAME"

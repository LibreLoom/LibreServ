# Luna Desktop Windows installer (mingw-nsis image). /src is read-only;
# target/ and the MSYS2 sysroot/package cache are volumes.
# Needs: LUNA_DESKTOP_VERSION (equal to desktop/VERSION, which the release
# tool mounts with the build's version), INSTALLER.
set -eu
export OUT_DIR=/work/win
export LUNA_DESKTOP_INSTALLER_NAME="$INSTALLER"
export LUNA_MSYS2_SYSROOT=/msys2/sysroot
export LUNA_MSYS2_PKG_DIR=/msys2/pkgs
mkdir -p "$OUT_DIR"
bash /src/luna/desktop/packaging/windows/build-cross.sh
# The installer and the app inside it must carry this build's version: the
# installer's script says so, and so must the compiled exe it packs.
want=$(tr -d '\r\n' < /src/luna/desktop/VERSION)
grep -qF "!define PRODUCT_VERSION \"$want\"" "$OUT_DIR/luna-desktop.nsi" \
	|| { echo "the installer script does not name version $want" >&2; exit 1; }
grep -aqF -- "$want" "$OUT_DIR/windows-stage/luna-desktop.exe" \
	|| { echo "the built luna-desktop.exe does not contain version $want" >&2; exit 1; }
cp "$OUT_DIR/$INSTALLER" "/out/$INSTALLER"

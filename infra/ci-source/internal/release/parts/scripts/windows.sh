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
cp "$OUT_DIR/$INSTALLER" "/out/$INSTALLER"

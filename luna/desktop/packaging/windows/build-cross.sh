#!/usr/bin/env bash
# Cross-build Luna Desktop for Windows (MinGW) from Linux using an MSYS2 sysroot,
# collect GTK/libadwaita runtime files, and produce an NSIS installer.
#
# Output: desktop/release/Luna-Desktop-Setup-<version>-x86_64.exe
#
# Requires: rustup target x86_64-pc-windows-gnu, mingw-w64 gcc + windres,
# makensis, curl, zstd/tar, glib-compile-schemas
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"   # luna/
DESKTOP="$ROOT/desktop"
OUT_DIR="${OUT_DIR:-$DESKTOP/release}"
VERSION="${LUNA_DESKTOP_VERSION:-0.0.21}"
SYSROOT="${LUNA_MSYS2_SYSROOT:-/tmp/msys2-sysroot}"
PKG_DIR="${LUNA_MSYS2_PKG_DIR:-/tmp/msys2-pkgs}"
STAGE="$OUT_DIR/windows-stage"
INSTALLER_NAME="Luna-Desktop-Setup-${VERSION}-x86_64.exe"

die() { echo "ERROR: $*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "missing $1"; }

need cargo
need rustup
need x86_64-w64-mingw32-gcc
need makensis
need curl
need pkg-config
need python3
need glib-compile-schemas
need x86_64-w64-mingw32-windres

# The caller may run us from the repo root, outside any rustup override —
# install the target for the toolchain luna/ actually builds with.
(cd "$DESKTOP" && rustup target add x86_64-pc-windows-gnu >/dev/null)

mkdir -p "$PKG_DIR" "$OUT_DIR" "$STAGE"

# --- MSYS2 packages needed for gtk4 + libadwaita ---
MSYS2_PKGS=(
  mingw-w64-x86_64-gtk4
  mingw-w64-x86_64-libadwaita
  mingw-w64-x86_64-glib2
  mingw-w64-x86_64-cairo
  mingw-w64-x86_64-pango
  mingw-w64-x86_64-gdk-pixbuf2
  mingw-w64-x86_64-graphene
  mingw-w64-x86_64-harfbuzz
  mingw-w64-x86_64-fribidi
  mingw-w64-x86_64-freetype
  mingw-w64-x86_64-fontconfig
  mingw-w64-x86_64-pixman
  mingw-w64-x86_64-libpng
  mingw-w64-x86_64-libjpeg-turbo
  mingw-w64-x86_64-libtiff
  mingw-w64-x86_64-zlib
  mingw-w64-x86_64-pcre2
  mingw-w64-x86_64-gettext-runtime
  mingw-w64-x86_64-libepoxy
  mingw-w64-x86_64-expat
  mingw-w64-x86_64-libffi
  mingw-w64-x86_64-vulkan-loader
  mingw-w64-x86_64-vulkan-headers
  mingw-w64-x86_64-shaderc
  mingw-w64-x86_64-lcms2
  mingw-w64-x86_64-libcloudproviders
  mingw-w64-x86_64-shared-mime-info
  mingw-w64-x86_64-librsvg
  mingw-w64-x86_64-libxml2
  mingw-w64-x86_64-libiconv
  mingw-w64-x86_64-brotli
  mingw-w64-x86_64-bzip2
  mingw-w64-x86_64-xz
  mingw-w64-x86_64-zstd
  mingw-w64-x86_64-lzo2
  mingw-w64-x86_64-libdeflate
  mingw-w64-x86_64-jbigkit
  mingw-w64-x86_64-lerc
  mingw-w64-x86_64-libwebp
  mingw-w64-x86_64-appstream-glib
  mingw-w64-x86_64-appstream
  mingw-w64-x86_64-gobject-introspection-runtime
  mingw-w64-x86_64-graphite2
  mingw-w64-x86_64-libxmlb
  mingw-w64-x86_64-libstemmer
  mingw-w64-x86_64-libdatrie
  mingw-w64-x86_64-libthai
  mingw-w64-x86_64-json-glib
  mingw-w64-x86_64-libsoup3
  mingw-w64-x86_64-sqlite3
  mingw-w64-x86_64-nghttp2
  mingw-w64-x86_64-libpsl
  mingw-w64-x86_64-openssl
  mingw-w64-x86_64-adwaita-icon-theme
  mingw-w64-x86_64-hicolor-icon-theme
  # gtk4 hard-imports the gstreamer media stack — without these the app
  # cannot even launch (B1). Only the linked libs are needed: gst runtime
  # plugins are dlopen'd on demand and the UI does not play media.
  mingw-w64-x86_64-gstreamer
  mingw-w64-x86_64-gst-plugins-base
  # the -libs split holds libgstd3d12 / libgstplay — the plugins themselves
  # are dlopen'd at runtime and not needed for launch
  mingw-w64-x86_64-gst-plugins-bad-libs
  mingw-w64-x86_64-orc
  mingw-w64-x86_64-libnice
  mingw-w64-x86_64-gnutls
  mingw-w64-x86_64-nettle
  mingw-w64-x86_64-p11-kit
  mingw-w64-x86_64-libtasn1
  mingw-w64-x86_64-libidn2
  mingw-w64-x86_64-libunistring
)

ensure_sysroot() {
  if [ -f "$SYSROOT/mingw64/lib/pkgconfig/gtk4.pc" ] \
    && [ -f "$SYSROOT/mingw64/lib/pkgconfig/libadwaita-1.pc" ] \
    && [ -f "$SYSROOT/mingw64/lib/pkgconfig/gstreamer-1.0.pc" ] \
    && [ -f "$SYSROOT/mingw64/bin/libgstplay-1.0-0.dll" ]; then
    echo "==> reusing MSYS2 sysroot at $SYSROOT"
    return 0
  fi
  echo "==> fetching MSYS2 mingw64 packages into $SYSROOT"
  mkdir -p "$SYSROOT" "$PKG_DIR"
  local INDEX
  INDEX="$(curl -fsS --proto '=https' --tlsv1.2 https://repo.msys2.org/mingw/mingw64/)"
  cd "$PKG_DIR"
  local name file
  for name in "${MSYS2_PKGS[@]}"; do
    file="$(printf '%s' "$INDEX" | grep -oE "${name}-[0-9][^\"<]*\.pkg\.tar\.(zst|xz)" | sort -V | tail -1 || true)"
    if [ -z "$file" ]; then
      file="$(printf '%s' "$INDEX" | grep -oE "${name}-[^\"<]*\.pkg\.tar\.(zst|xz)" | sort -V | tail -1 || true)"
    fi
    if [ -z "$file" ]; then
      echo "WARN: no package listing for $name (continuing)" >&2
      continue
    fi
    if [ ! -f "$file" ]; then
      echo "  fetch $file"
      curl -fL --proto '=https' --tlsv1.2 --retry 3 -o "$file" "https://repo.msys2.org/mingw/mingw64/$file"
    fi
  done
  for file in *.pkg.tar.zst *.pkg.tar.xz; do
    [ -f "$file" ] || continue
    tar -C "$SYSROOT" --use-compress-program=unzstd -xf "$file" 2>/dev/null \
      || tar -C "$SYSROOT" -xf "$file"
  done
}

write_pkg_config_wrapper() {
  cat > /tmp/luna-mingw64-pkg-config <<EOF
#!/bin/sh
export PKG_CONFIG_PATH="$SYSROOT/mingw64/lib/pkgconfig"
export PKG_CONFIG_LIBDIR="$SYSROOT/mingw64/lib/pkgconfig"
export PKG_CONFIG_SYSROOT_DIR="$SYSROOT"
exec pkg-config --define-prefix --define-variable=prefix="$SYSROOT/mingw64" "\$@"
EOF
  chmod +x /tmp/luna-mingw64-pkg-config
}

build_exe() {
  echo "==> cargo build --release --target x86_64-pc-windows-gnu"
  cd "$DESKTOP"
  mkdir -p .cargo
  cat > .cargo/config.toml <<EOF
[target.x86_64-pc-windows-gnu]
linker = "x86_64-w64-mingw32-gcc"
rustflags = ["-L", "native=$SYSROOT/mingw64/lib"]
EOF
  export PKG_CONFIG=/tmp/luna-mingw64-pkg-config
  export PKG_CONFIG_ALLOW_CROSS=1
  export PKG_CONFIG_PATH="$SYSROOT/mingw64/lib/pkgconfig"
  cargo build --release --target x86_64-pc-windows-gnu
  local exe="$DESKTOP/target/x86_64-pc-windows-gnu/release/luna-desktop.exe"
  [ -f "$exe" ] || die "missing $exe"
}

# Recursively collect DLLs imported by the PE, staying inside mingw64/bin (+ host mingw runtime).
collect_dlls() {
  echo "==> collecting MinGW DLLs"
  local exe="$DESKTOP/target/x86_64-pc-windows-gnu/release/luna-desktop.exe"
  local bindir="$SYSROOT/mingw64/bin"
  local gccdir
  gccdir="$(dirname "$(x86_64-w64-mingw32-gcc -print-file-name=libgcc_s_seh-1.dll)")"
  local pthread
  pthread="$(x86_64-w64-mingw32-gcc -print-file-name=libwinpthread-1.dll 2>/dev/null || true)"
  python3 - "$exe" "$bindir" "$STAGE" "$gccdir" "${pthread:-}" <<'PY'
import re, subprocess, sys
from pathlib import Path

exe, bindir, stage, gccdir = map(Path, sys.argv[1:5])
extra_pthread = Path(sys.argv[5]) if len(sys.argv) > 5 and sys.argv[5] else None
search_dirs = [bindir.resolve()]
if gccdir.is_dir():
    search_dirs.append(gccdir.resolve())
if extra_pthread and extra_pthread.is_file():
    search_dirs.append(extra_pthread.parent.resolve())
# Common Ubuntu mingw locations; Arch keeps the runtime DLLs in bin/ and
# `gcc -print-file-name` does not see them there.
for p in [
    Path("/usr/x86_64-w64-mingw32/lib"),
    Path("/usr/x86_64-w64-mingw32/bin"),
    Path("/usr/lib/gcc/x86_64-w64-mingw32/13-posix"),
    Path("/usr/lib/gcc/x86_64-w64-mingw32/13-win32"),
]:
    if p.is_dir():
        search_dirs.append(p)

stage.mkdir(parents=True, exist_ok=True)
(stage / "luna-desktop.exe").write_bytes(exe.read_bytes())

sys_dlls = {
    "advapi32.dll", "kernel32.dll", "ntdll.dll", "user32.dll", "gdi32.dll",
    "shell32.dll", "ole32.dll", "oleaut32.dll", "comdlg32.dll", "comctl32.dll",
    "winmm.dll", "ws2_32.dll", "wsock32.dll", "bcrypt.dll", "bcryptprimitives.dll",
    "crypt32.dll", "secur32.dll", "iphlpapi.dll", "userenv.dll", "msvcrt.dll",
    "ucrtbase.dll", "sechost.dll", "rpcrt4.dll", "shlwapi.dll", "imm32.dll",
    "dwmapi.dll", "uxtheme.dll", "setupapi.dll", "cfgmgr32.dll", "hid.dll",
    "winspool.drv", "opengl32.dll", "gdiplus.dll", "dnsapi.dll", "nsi.dll",
    "dwrite.dll", "usp10.dll", "d3d11.dll", "d3d12.dll", "dxgi.dll", "dcomp.dll",
    "d2d1.dll", "dxcore.dll", "shcore.dll", "msimg32.dll", "dbghelp.dll",
    "version.dll", "winhttp.dll", "wlanapi.dll", "wtsapi32.dll", "psapi.dll",
    "api-ms-win-core-synch-l1-2-0.dll", "api-ms-win-crt-runtime-l1-1-0.dll",
}

pat = re.compile(r"DLL Name:\s+(\S+)", re.I)
copied = {"luna-desktop.exe"}
missing = []
to_scan = [stage / "luna-desktop.exe"]

# gdk-pixbuf loaders are dlopen'd, so nothing imports them — seed the scan
# with them anyway so THEIR dependencies (librsvg etc.) get collected.
loaders_root = bindir.parent / "lib/gdk-pixbuf-2.0"
if loaders_root.is_dir():
    for dll in loaders_root.rglob("*.dll"):
        to_scan.append(dll)

def find_dll(name: str):
    for d in search_dirs:
        for candidate in (d / name, d / name.lower()):
            if candidate.is_file():
                return candidate
        matches = list(d.glob(name)) + list(d.glob(name.lower()))
        if matches:
            return matches[0]
    return None

while to_scan:
    pe = to_scan.pop()
    out = subprocess.check_output(["x86_64-w64-mingw32-objdump", "-p", str(pe)], text=True, errors="replace")
    for name in pat.findall(out):
        low = name.lower()
        # api-ms-win-crt-* are UCRT stubs Windows 10+ ships in System32 —
        # not redistributable files, so they are never bundled.
        if low in sys_dlls or low in copied or low.startswith("api-ms-win-crt-"):
            continue
        src = find_dll(name)
        if src is None:
            missing.append(name)
            print(f"  MISSING {name} (needed by {pe.name})", file=sys.stderr)
            continue
        dest = stage / src.name
        if not dest.exists():
            dest.write_bytes(src.read_bytes())
            print(f"  + {src.name}")
            to_scan.append(dest)
        copied.add(low)

# Always ship mingw runtime if present
for must in ("libgcc_s_seh-1.dll", "libstdc++-6.dll", "libwinpthread-1.dll"):
    if must.lower() in {c.lower() for c in copied}:
        continue
    src = find_dll(must)
    if src:
        dest = stage / src.name
        dest.write_bytes(src.read_bytes())
        print(f"  + {src.name} (runtime)")
        copied.add(must.lower())

if missing:
    print(f"FATAL: unresolved DLL imports: {sorted(set(missing))}", file=sys.stderr)
    sys.exit(1)

print(f"collected {len(copied)} binaries into {stage}")
PY
}

copy_runtime_data() {
  echo "==> copying GTK runtime data"
  local m="$SYSROOT/mingw64"
  # gdk-pixbuf loaders
  mkdir -p "$STAGE/lib/gdk-pixbuf-2.0"
  if [ -d "$m/lib/gdk-pixbuf-2.0" ]; then
    cp -a "$m/lib/gdk-pixbuf-2.0/." "$STAGE/lib/gdk-pixbuf-2.0/"
  fi
  # glib schemas — must be compiled or the first GSettings-backed widget
  # (folder picker) crashes the app with "No GSettings schemas are installed".
  mkdir -p "$STAGE/share/glib-2.0/schemas"
  if [ -d "$m/share/glib-2.0/schemas" ]; then
    cp -a "$m/share/glib-2.0/schemas/." "$STAGE/share/glib-2.0/schemas/"
  fi
  # gschemas.compiled is platform-independent; the host tool produces it fine.
  glib-compile-schemas "$STAGE/share/glib-2.0/schemas"
  [ -f "$STAGE/share/glib-2.0/schemas/gschemas.compiled" ] || die "gschemas.compiled was not produced"
  # icons (adwaita + hicolor) — keep size reasonable: scalable + 16/24/32/48
  for theme in Adwaita hicolor; do
    if [ -d "$m/share/icons/$theme" ]; then
      mkdir -p "$STAGE/share/icons/$theme"
      cp -a "$m/share/icons/$theme/." "$STAGE/share/icons/$theme/" 2>/dev/null || true
    fi
  done
  # App icon
  if [ -f "$DESKTOP/resources/icon.png" ]; then
    mkdir -p "$STAGE/share/icons/hicolor/256x256/apps"
    cp "$DESKTOP/resources/icon.png" "$STAGE/share/icons/hicolor/256x256/apps/org.libreloom.LunaDesktop.png"
  fi
  # mime
  if [ -d "$m/share/mime" ]; then
    mkdir -p "$STAGE/share/mime"
    cp -a "$m/share/mime/." "$STAGE/share/mime/" 2>/dev/null || true
  fi
}

write_launcher_and_nsi() {
  # No .bat wrapper: luna-desktop.exe sets its own runtime env at startup
  # (ensure_runtime_env in the app) and carries the icon resource, so
  # shortcuts can point straight at the exe — no stray console window.

  cat > "$OUT_DIR/luna-desktop.nsi" <<EOF
!include "MUI2.nsh"
!include "FileFunc.nsh"

Name "Luna Desktop"
OutFile "$OUT_DIR/$INSTALLER_NAME"
InstallDir "\$LOCALAPPDATA\\Programs\\Luna Desktop"
RequestExecutionLevel user
Unicode true
SetCompressor /SOLID lzma

!define MUI_ABORTWARNING
!define PRODUCT_NAME "Luna Desktop"
!define PRODUCT_VERSION "$VERSION"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

Section "Install"
  SetOutPath "\$INSTDIR"
  File /r "${STAGE}/*.*"

  CreateDirectory "\$SMPROGRAMS\\Luna Desktop"
  CreateShortCut "\$SMPROGRAMS\\Luna Desktop\\Luna Desktop.lnk" "\$INSTDIR\\luna-desktop.exe" "" "\$INSTDIR\\luna-desktop.exe" 0
  CreateShortCut "\$DESKTOP\\Luna Desktop.lnk" "\$INSTDIR\\luna-desktop.exe" "" "\$INSTDIR\\luna-desktop.exe" 0

  WriteUninstaller "\$INSTDIR\\Uninstall.exe"

  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\LunaDesktop" "DisplayName" "Luna Desktop"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\LunaDesktop" "UninstallString" "\$INSTDIR\\Uninstall.exe"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\LunaDesktop" "InstallLocation" "\$INSTDIR"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\LunaDesktop" "DisplayVersion" "$VERSION"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\LunaDesktop" "Publisher" "LibreLoom"
  WriteRegDWORD HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\LunaDesktop" "NoModify" 1
  WriteRegDWORD HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\LunaDesktop" "NoRepair" 1
SectionEnd

Section "Uninstall"
  Delete "\$SMPROGRAMS\\Luna Desktop\\Luna Desktop.lnk"
  RMDir "\$SMPROGRAMS\\Luna Desktop"
  Delete "\$DESKTOP\\Luna Desktop.lnk"
  DeleteRegKey HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\LunaDesktop"
  DeleteRegValue HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Run" "Luna Desktop"
  RMDir /r "\$INSTDIR"
SectionEnd
EOF
}

# Fail the build if the staged tree cannot actually launch on a clean box:
# re-walk the PE import closure of EVERY shipped exe/dll (exe, top-level DLLs,
# gdk-pixbuf loaders) and require each import to resolve inside the stage or
# be a known system DLL. Also assert gschemas.compiled exists.
verify_stage() {
  echo "==> verifying staged runtime"
  python3 - "$STAGE" <<'PY'
import re, subprocess, sys
from pathlib import Path

stage = Path(sys.argv[1])

sys_dlls = {
    "advapi32.dll", "kernel32.dll", "ntdll.dll", "user32.dll", "gdi32.dll",
    "shell32.dll", "ole32.dll", "oleaut32.dll", "comdlg32.dll", "comctl32.dll",
    "winmm.dll", "ws2_32.dll", "wsock32.dll", "bcrypt.dll", "bcryptprimitives.dll",
    "crypt32.dll", "secur32.dll", "iphlpapi.dll", "userenv.dll", "msvcrt.dll",
    "ucrtbase.dll", "sechost.dll", "rpcrt4.dll", "shlwapi.dll", "imm32.dll",
    "dwmapi.dll", "uxtheme.dll", "setupapi.dll", "cfgmgr32.dll", "hid.dll",
    "winspool.drv", "opengl32.dll", "gdiplus.dll", "dnsapi.dll", "nsi.dll",
    "dwrite.dll", "usp10.dll", "d3d11.dll", "d3d12.dll", "dxgi.dll", "dcomp.dll",
    "d2d1.dll", "dxcore.dll", "shcore.dll", "msimg32.dll", "dbghelp.dll",
    "version.dll", "winhttp.dll", "wlanapi.dll", "wtsapi32.dll", "psapi.dll",
    "avicap32.dll", "msvfw32.dll", "ksuser.dll", "powrprof.dll",
    "api-ms-win-core-synch-l1-2-0.dll", "api-ms-win-crt-runtime-l1-1-0.dll",
}

pat = re.compile(r"DLL Name:\s+(\S+)", re.I)
staged = {p.name.lower() for p in stage.rglob("*.dll")}
staged |= {p.name.lower() for p in stage.rglob("*.exe")}

missing = {}
for pe in stage.rglob("*"):
    if pe.suffix.lower() not in (".exe", ".dll"):
        continue
    try:
        out = subprocess.check_output(
            ["x86_64-w64-mingw32-objdump", "-p", str(pe)], text=True, errors="replace")
    except subprocess.CalledProcessError:
        continue
    for name in pat.findall(out):
        low = name.lower()
        # api-ms-win-crt-* are UCRT stubs Windows 10+ ships in System32.
        if low in sys_dlls or low in staged or low.startswith("api-ms-win-crt-"):
            continue
        missing.setdefault(low, []).append(str(pe.relative_to(stage)))

if missing:
    for dll, users in sorted(missing.items()):
        print(f"  MISSING {dll}  (imported by {', '.join(sorted(set(users)))})", file=sys.stderr)
    print("FATAL: staged runtime has unresolved DLL imports", file=sys.stderr)
    sys.exit(1)

schemas = stage / "share/glib-2.0/schemas/gschemas.compiled"
if not schemas.is_file():
    print("FATAL: share/glib-2.0/schemas/gschemas.compiled missing", file=sys.stderr)
    sys.exit(1)

exe = stage / "luna-desktop.exe"
hdr = subprocess.check_output(
    ["x86_64-w64-mingw32-objdump", "-h", str(exe)], text=True, errors="replace")
if ".rsrc" not in hdr:
    print("WARN: luna-desktop.exe has no .rsrc section — icon not embedded", file=sys.stderr)

sub = subprocess.check_output(
    ["x86_64-w64-mingw32-objdump", "-x", str(exe)], text=True, errors="replace")
if "subsystem" in sub.lower() and not re.search(r"Subsystem\s+.*Windows GUI", sub):
    m = re.search(r"Subsystem\s+\S+.*", sub)
    print(f"WARN: unexpected subsystem line: {m.group(0) if m else '?'}", file=sys.stderr)

print(f"stage OK: {len(staged)} PE files, all imports resolved, schemas compiled")
PY
}

build_installer() {
  echo "==> NSIS $INSTALLER_NAME"
  # Fix loaders.cache: gdk often records absolute MSYS paths; MODULEDIR is set at runtime.
  if [ -f "$STAGE/lib/gdk-pixbuf-2.0/2.10.0/loaders.cache" ]; then
    python3 - "$STAGE" <<'PY'
import re, sys
from pathlib import Path
cache = Path(sys.argv[1]) / "lib/gdk-pixbuf-2.0/2.10.0/loaders.cache"
if cache.is_file():
    text = cache.read_text(errors="replace")
    text = re.sub(r'"[^"]+/loaders/([^"]+)"', r'"\1"', text)
    cache.write_text(text)
    print("rewrote loaders.cache")
PY
  fi
  makensis -V2 "$OUT_DIR/luna-desktop.nsi"
  [ -f "$OUT_DIR/$INSTALLER_NAME" ] || die "installer missing"
  ls -lh "$OUT_DIR/$INSTALLER_NAME"
}

rm -rf "$STAGE"
mkdir -p "$STAGE"
ensure_sysroot
write_pkg_config_wrapper
/tmp/luna-mingw64-pkg-config --exists gtk4 || die "gtk4 pkg-config failed in sysroot"
/tmp/luna-mingw64-pkg-config --exists libadwaita-1 || die "libadwaita pkg-config failed in sysroot"
build_exe
collect_dlls
copy_runtime_data
write_launcher_and_nsi
verify_stage
build_installer

echo "built $OUT_DIR/$INSTALLER_NAME"

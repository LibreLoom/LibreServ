# Windows installer (.exe)

Official Windows distribution for Luna Desktop is a **single `.exe` installer**
(NSIS) that ships the GTK 4 + libadwaita runtime alongside `luna-desktop.exe`.

## Cross-build from Linux (preferred for CI / Cloud Agents)

```sh
# deps: mingw-w64 gcc, nsis, pkg-config, curl, zstd
sudo apt install gcc-mingw-w64-x86-64 nsis pkg-config curl zstd
rustup target add x86_64-pc-windows-gnu

cd luna
LUNA_DESKTOP_VERSION=0.0.21 ./desktop/packaging/windows/build-cross.sh
# → desktop/release/Luna-Desktop-Setup-0.0.21-x86_64.exe
```

The script:

1. Fetches an MSYS2 mingw64 sysroot (GTK 4 + libadwaita + deps)
2. Cross-compiles `luna-desktop.exe` (`x86_64-pc-windows-gnu`)
3. Collects PE-imported DLLs + GTK runtime data (schemas, pixbuf loaders, icons)
4. Builds a **per-user** NSIS installer (no admin)

Install location: `%LocalAppData%\Programs\Luna Desktop\`

SmartScreen will warn on unsigned builds. That is expected for prereleases
until Authenticode signing is wired up. For testing, choose “More info → Run anyway”.

## Native Windows build (optional)

Use a Windows machine with:

1. [gvsbuild](https://github.com/wingtk/gvsbuild) or MSYS2 for GTK 4 + libadwaita
2. Rust MSVC toolchain (`x86_64-pc-windows-msvc`)
3. NSIS

## Layout

```
packaging/windows/
  build-cross.sh     # Linux → Windows cross + NSIS (release path)
  README.md
```

Installer should (and the cross script does):

- Install under `%LocalAppData%\Programs\Luna Desktop\`
- Offer Start Menu + desktop shortcut
- Offer “Start Luna Desktop when I sign in” from the app Settings (HKCU Run)
- Not require admin for a per-user install

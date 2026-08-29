# Windows installer (.exe)

Official Windows distribution for Luna Desktop is a **single `.exe` installer**
(NSIS or Inno Setup) that ships the GTK 4 + libadwaita runtime alongside
`luna-desktop.exe`.

## Status

Cross-building GTK/libadwaita for Windows is not automated in this repo yet.
Use a Windows machine (or CI runner) with:

1. [gvsbuild](https://github.com/wingtk/gvsbuild) or MSYS2 to build GTK 4 +
   libadwaita
2. Rust MSVC toolchain (`x86_64-pc-windows-msvc`)
3. NSIS or Inno Setup to produce `Luna-Desktop-Setup-<version>.exe`

## Suggested layout

```
packaging/windows/
  build.ps1          # cargo build --release + collect GTK DLLs
  luna-desktop.iss   # Inno Setup script (or .nsi for NSIS)
```

Installer should:

- Install under `%LocalAppData%\Programs\Luna Desktop\`
- Offer Start Menu + optional desktop shortcut
- Offer “Start Luna Desktop when I sign in” (HKCU Run key)
- Not require admin for a per-user install

Until the Windows pipeline lands, use the Linux Flatpak (or the demo AppImage
on the GitHub prerelease) for day-to-day builds.

# Luna Desktop

Tauri 2 app for **Backup** (one-way copy of folders onto Luna) and **Sync**
(two-way keep a Luna folder and a local folder up to date).

## What it does

1. **Sign in** once. Luna Desktop mints a device access token and remembers it
   on this computer. Your Luna password is not stored.
2. **Backup** — pick folders on this computer and a folder on Luna (create one
   if you need). You can run several backup jobs to different destinations.
3. **Sync** — pick a folder on Luna, then a parent folder on this computer.
   Desktop creates a child folder there and keeps both sides in sync. If both
   sides change the same file, both copies are kept with a clear conflict name.

## Linux package (this repo's supported path)

```sh
# From luna/
make desktop          # tests + unbundled binary
make desktop-bundle   # .deb + AppImage
```

Or from `luna/desktop`:

```sh
npm install
npm run tauri -- build --bundles deb,appimage
```

System packages (Fedora/Debian names vary): `webkit2gtk4.1` /
`libwebkit2gtk-4.1-dev`, `librsvg2`, `openssl-devel`, a C compiler, and
`patchelf` for AppImage. If AppImage tooling cannot use FUSE, set
`APPIMAGE_EXTRACT_AND_RUN=1`.

Outputs land in `desktop/src-tauri/target/release/bundle/`.

## Soak / unit tests

```sh
cd desktop/src-tauri && cargo test
```

Fake Luna HTTP coverage includes login, drive list, folder list, and mkdir.

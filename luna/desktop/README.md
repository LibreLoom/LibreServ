# Luna Desktop

Tauri 2 app: folder backup and one-click WebDAV mounts.

- Backup uses Luna's resumable chunked upload API, watches the chosen folder,
  and retries changed files.
- "Open as folder" mounts `/dav/{drive_id}` with the OS-native WebDAV client.
  Sign in once; Luna mints an access token. Use that token as the WebDAV
  password — never the Luna password.

## Linux package (this repo's supported path)

Apple and Windows installers are **not** required here and need platform
certs if you ever build them yourself. On Linux:

```sh
# From luna/
make desktop          # tests + unbundled binary
make desktop-bundle   # .deb + AppImage (one command)
```

Or from `luna/desktop`:

```sh
npm install
npm run tauri -- build --bundles deb,appimage
```

System packages (Fedora/Debian names vary): `webkit2gtk4.1` / `libwebkit2gtk-4.1-dev`,
`librsvg2`, `openssl-devel`, a C compiler, and `patchelf` for AppImage.

Outputs land in `desktop/src-tauri/target/release/bundle/`.

## Soak test (fake Luna API)

`cargo test` in `desktop/src-tauri` hits a local fake Luna HTTP API (login +
drive list, repeated). No running lunad required.

```sh
cd desktop/src-tauri && cargo test
```

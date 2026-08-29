# Luna Desktop

Native **GTK 4 + libadwaita** app for **Backup** (one-way copy of folders onto
Luna) and **Sync** (two-way keep a Luna folder and a local folder up to date).

## What it does

1. **Sign in** once. Luna Desktop mints a device access token and remembers it
   on this computer. Your Luna password is not stored.
2. **Backup** — pick folders on this computer and a folder on Luna (create one
   if you need). You can run several backup jobs to different destinations.
3. **Sync** — pick a folder on Luna, then a parent folder on this computer.
   Desktop creates a child folder there and keeps both sides in sync. If both
   sides change the same file, both copies are kept with a clear conflict name.
4. **Settings** — optional start on boot (XDG autostart on Linux).

## Distribution

| Platform | Ship as |
|----------|---------|
| Linux | **Flatpak** (`packaging/flatpak/`) — preferred |
| Windows | **`.exe` installer** (`packaging/windows/`) — preferred |
| Linux (demo / CI) | AppImage (`packaging/appimage/build.sh`) |

## Build from source (Linux)

Needs GTK 4 and libadwaita development packages, for example:

```sh
# Debian / Ubuntu
sudo apt install libgtk-4-dev libadwaita-1-dev pkg-config

# Fedora
sudo dnf install gtk4-devel libadwaita-devel pkgconf-pkg-config
```

```sh
# From luna/
make desktop-dev    # cargo run
make desktop        # tests + release binary → desktop/target/release/luna-desktop
make desktop-appimage   # demo AppImage → desktop/release/
make desktop-flatpak    # Flatpak (needs flatpak-builder + GNOME SDK)
```

Or from `luna/desktop`:

```sh
cargo test
cargo run
cargo build --release
bash packaging/appimage/build.sh
```

## Soak / unit tests

```sh
cd desktop && cargo test
```

Fake Luna HTTP coverage includes login, drive list, folder list, and mkdir.
Autostart writes an XDG `.desktop` file under `$XDG_CONFIG_HOME/autostart`.

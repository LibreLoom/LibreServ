# Luna for Linux

Native **GTK 4 + libadwaita** app for **Backup** (one-way copy of folders onto
Luna) and **Sync** (two-way keep a Luna folder and a local folder up to date).

## What it does

1. **Sign in** once with an **access token** from Luna (Settings → Security → Create access token). Luna for Linux remembers it on this computer.
   Your Luna password is not stored.
2. **Backup** — pick folders on this computer and a folder on Luna (create one
   if you need). You can run several backup jobs to different destinations.
3. **Sync** — pick a folder on Luna, then a parent folder on this computer.
   Desktop creates a child folder there and keeps both sides in sync. If both
   sides change the same file, both copies are kept with a clear conflict name.
4. **Settings** — start on boot (enabled by default; XDG autostart on Linux).

## Distribution

| Platform | Ship as |
|----------|---------|
| Linux | **Flatpak** (`packaging/flatpak/`) — preferred; builds for the host CPU (`x86_64`, `aarch64`, …) |
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

## Rapid development (GTK)

Two terminals:

```sh
# Terminal A — Luna API (restarts on Rust save)
cd luna && make daemon-dev          # http://127.0.0.1:8090
# (or: make dev-daemon for a one-shot process without cargo-watch)

# Terminal B — Desktop app (watch + inspector + auto sign-in)
cd luna && make desktop-dev
```

What `make desktop-dev` does:

1. Checks Luna is up on `:8090`
2. Mints (or reuses) an access token for user `desktop` / `hunter22hunter1`
3. Prefills login and **auto-signs in** so you land on Backup
4. Runs `cargo watch -x run` — save a file under `desktop/src/` to rebuild/restart
5. Opens **GTK Inspector** (`GTK_DEBUG=interactive`)

Useful env vars:

| Variable | Default | Meaning |
|----------|---------|---------|
| `LUNA_DESKTOP_AUTO_LOGIN` | `1` | Set `0` to exercise the login UI |
| `LUNA_DESKTOP_URL` | `http://127.0.0.1:8090` | Luna address |
| `LUNA_DESKTOP_DEV_USER` | `desktop` | User used to mint the token |
| `LUNA_DESKTOP_DEV_PASS` | `hunter22hunter1` | Password for that user |
| `GTK_DEBUG` | `interactive` | Set empty to hide the inspector |

```sh
# Test the login form without auto sign-in
make desktop-dev-login
```

Token cache lives in `desktop/.dev/` (gitignored).

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
Autostart writes an XDG `.desktop` file under `$XDG_CONFIG_HOME/autostart` (enabled by default on first run).

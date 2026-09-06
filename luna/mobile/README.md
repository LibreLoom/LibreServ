# Luna Mobile (Android)

Photo backup for Luna. Sign in with an **access token** (paste, or scan the
QR code from Luna → Settings → Security). Photos then back up
in the background through Luna's resumable chunked upload API.

This app is photo backup over the home network. First-time Luna setup uses
the Ethernet cable and the address on the screen (or luna.local).

## Sign-in

Create an access token in Luna (browser) → Settings → Security.
Paste it into the phone app, or tap **Show as QR code** on Luna and **Scan QR
code** on the phone. That fills the Luna address and the token.

## Background backup

Android's battery saver pauses apps. That stops photo backup. After sign-in,
Luna asks Android to leave this app **Unrestricted** (Don't optimize). If that
prompt is dismissed, open Backup or Settings and tap **Allow background
backup**.

The backup worker also runs as a short **foreground data-sync** job while
photos are uploading, so Android does not kill the transfer.

When and where photos save (Wi-Fi, charging, drive, folder) is in Settings.


## Rapid development

Needs Luna on `:8090` and an emulator/device on `adb`.

```sh
# Terminal A — Luna API (restarts on Rust save)
cd luna && make daemon-dev

# Terminal B — Android app (installDebug + relaunch on save)
cd luna && make mobile-dev
```

What `make mobile-dev` does:

1. Checks `adb` for an emulator or phone
2. Mints (or reuses) an access token for user `desktop` / `hunter22hunter1`
3. `installDebug`, then opens `luna://pair` so DEBUG builds **auto-sign in**
4. Watches `app/src` — save a file to rebuild, reinstall, and relaunch

Useful env vars:

| Variable | Default | Meaning |
|----------|---------|---------|
| `LUNA_MOBILE_URL` | emulator `http://10.0.2.2:8090`, else LAN IP | Luna address **inside** the app |
| `LUNA_MOBILE_HOST_URL` | `http://127.0.0.1:8090` | Luna address used to mint the token on the host |
| `LUNA_MOBILE_REPAIR` | `0` | Set `1` (or `make mobile-dev-repair`) to force a fresh pair/sign-in |
| `LUNA_DESKTOP_DEV_USER` | `desktop` | User used to mint the token |
| `LUNA_DESKTOP_DEV_PASS` | `hunter22hunter1` | Password for that user |

Token cache lives in `mobile/.dev/` (gitignored). Emulators reach the host as `10.0.2.2`. Physical phones need a LAN URL, e.g. `LUNA_MOBILE_URL=http://192.168.1.20:8090`.

## Build
```sh
export ANDROID_HOME=$HOME/Android/Sdk   # or edit local.properties
./gradlew testDebugUnitTest             # host JVM tests
./gradlew assembleDebug                 # app-debug.apk
```

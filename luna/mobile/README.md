# Luna Mobile (Android)

Photo backup for Luna. Sign in with an **access token** (paste, or scan the
QR code from Luna → Settings → Security). Photos then back up
in the background through Luna's resumable chunked upload API.

This app backs up photos to your Luna. First-time Luna setup uses
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

## Release signing

Release APKs are signed with a keystore that lives **outside** this repo
(`*.jks`/`*.keystore` are gitignored). Generate it once:

```sh
keytool -genkeypair -v -keystore luna-release.jks -alias luna \
  -keyalg RSA -keysize 4096 -validity 36500
```

Keep the keystore and its passwords in the password manager plus one offline
backup. Whoever holds this key controls the app identity — a lost key means
installed copies can never update, a leaked key means anyone can ship updates
as Luna.

`assembleRelease` signs when these env vars are set (see
`app/build.gradle.kts`); without them it produces an unsigned APK:

| Variable | Meaning |
|----------|---------|
| `LUNA_ANDROID_KEYSTORE` | Path to the `.jks` file |
| `LUNA_ANDROID_KEYSTORE_B64` | Alternative for CI: `base64 -w0 luna-release.jks` output; `release.sh` decodes it to a temp file |
| `LUNA_ANDROID_STORE_PASSWORD` | Keystore password |
| `LUNA_ANDROID_KEY_ALIAS` | Key alias (default `luna`) |
| `LUNA_ANDROID_KEY_PASSWORD` | Key password |

`release.sh` picks this up automatically and runs `apksigner verify` on the
result.

## Distribution (F-Droid + direct APK)

Two channels, **different signatures** — a user must pick one; switching means
uninstalling first:

- **F-Droid** (primary): F-Droid builds from source at our git tags and signs
  with their key. Their update checker reads `versionCode` from
  `app/build.gradle.kts` at each `luna-v*` release tag and publishes a new
  build automatically whenever it increases. Metadata for the fdroiddata
  merge request lives in `fdroid/net.plainskill.luna.yml`; the store listing
  text lives in `fastlane/metadata/android/`.
- **Direct APK** on Forgejo releases: signed with our keystore (above).

Versioning rules:

- `versionCode` and `versionName` in `app/build.gradle.kts` are **plain
  literals on purpose** — F-Droid's update checker parses the file at each
  tag. Bump both before every release that ships the app (`versionCode` must
  strictly increase).
- `release.sh` warns if `versionCode` hasn't moved since the last `luna-v*`
  tag — that's the bump reminder.

Google Play is intentionally not used; Google's developer-verification
requirement (rolling out globally in 2027) is one reason the F-Droid +
direct-APK path was chosen.

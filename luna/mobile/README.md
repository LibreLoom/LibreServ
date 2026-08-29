# Luna Mobile (Android)

Photo backup for Luna. Sign in with an **access token** (paste, or scan the
QR code from Luna → Settings → Apps and access tokens). Photos then back up
in the background through Luna's resumable chunked upload API.

This app is photo backup over the home network. First-time Luna setup uses
the Ethernet cable and the address on the screen (or luna.local).

## Sign-in

Create an access token in Luna (browser) → Settings → Apps and access tokens.
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

## Build
```sh
export ANDROID_HOME=$HOME/Android/Sdk   # or edit local.properties
./gradlew testDebugUnitTest             # host JVM tests
./gradlew assembleDebug                 # app-debug.apk
```

# LibreServ BLE Companion — Android

An Android app that connects to LibreServ over Bluetooth LE and displays the full Web UI in an embedded WebView through a local proxy.

## How it works

1. Open the app — you see a minimal connection helper.
2. Enter the 6-character setup code from your LibreServ device.
3. Tap **Connect** — the app scans, connects, and authenticates over BLE.
4. A local HTTP proxy starts inside the app and the LibreServ Web UI loads in a WebView.
5. If the Bluetooth connection drops, a "Connection lost" banner appears and reconnects automatically.

## Build

Requires Android Studio or Gradle command line with Android SDK 34.

```bash
cd companion/android
./gradlew assembleDebug
```

The APK is output to `app/build/outputs/apk/debug/app-debug.apk`.

### Prerequisites

- Android 8.0+ (API 26+) with BLE support
- The LibreServ server must be built with the `libreserv_ble` build tag

## Usage

1. Open the app.
2. Enter the 6-character setup code from your LibreServ device.
3. Tap **Connect**.
4. The app connects and opens the LibreServ Web UI.

# LibreServ BLE Companion — Android

An Android app that connects to LibreServ over Bluetooth LE and forwards all web traffic through a local HTTP proxy, letting you access the full LibreServ Web UI from your phone even when normal network access is unavailable.

## Architecture

1. **BLE Connection** — Scans for the `LibreServ-*` peripheral, connects, authenticates with the setup code, and subscribes to proxy response notifications.
2. **NanoHTTPD Proxy** — Runs a tiny embedded HTTP server on `127.0.0.1:18080` inside the app.
3. **WebView** — Loads `http://127.0.0.1:18080/`. Every HTTP request (including API POSTs with bodies) is captured by the proxy and forwarded over BLE.

## Build

Requires Android Studio or Gradle command line with Android SDK 34 installed.

```bash
cd companion/android
./gradlew assembleDebug
```

The APK is output to `app/build/outputs/apk/debug/app-debug.apk`.

## Prerequisites

- Android 8.0+ (API 26+) with BLE support.
- The LibreServ server must be built with the `libreserv_ble` build tag so it advertises the BLE service.

## Usage

1. Open the app.
2. Enter the 6-character setup code from your LibreServ device.
3. Tap **Connect**.
4. The app will scan, connect, authenticate, and then open the LibreServ Web UI.

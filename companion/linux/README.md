# LibreServ BLE Companion — Linux

A Libadwaita GTK4 app that connects to LibreServ over Bluetooth LE and opens the Web UI in your browser through a local proxy.

## How it works

1. Open the app — you see a clean connection helper with the LibreServ logo.
2. Enter the 6-character setup code printed on your LibreServ device.
3. Tap **Connect** — the app scans, connects, and authenticates over BLE.
4. A local HTTP proxy starts on `127.0.0.1:18080` and your browser opens automatically.

## Build

```bash
cd companion/linux
go mod tidy
go build -o libreserv-ble-companion
```

### Prerequisites

- Linux with BlueZ running (standard on Fedora, Ubuntu, etc.)
- Bluetooth 4.0+ adapter supporting BLE
- GTK4 and libadwaita (standard on GNOME 42+)
- Your LibreServ server must be built with the `libreserv_ble` build tag:
  ```bash
  cd server/backend && make ble-run
  ```

## Run

```bash
./libreserv-ble-companion
```

The setup code is the same 6-character code printed on your LibreServ device.

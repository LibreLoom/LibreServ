# LibreServ BLE Companion — Linux

A small local HTTP proxy that connects to LibreServ over Bluetooth LE and forwards all web traffic, letting you access the LibreServ Web UI from any browser even when normal network routing is unavailable.

## How it works

1. The companion scans for a BLE peripheral advertising the LibreServ UUID.
2. It connects, authenticates with your setup code, and subscribes to the proxy response characteristic.
3. It starts an HTTP proxy on `127.0.0.1:18080`.
4. Open any browser to `http://127.0.0.1:18080/` — every request is forwarded through the BLE connection.

## Build

```bash
cd companion/linux
go mod tidy
go build -o libreserv-ble-companion
```

## Run

```bash
./libreserv-ble-companion -code=ABCDEF
```

The setup code is the same 6-character code printed on your LibreServ device.

## Prerequisites

- A Linux system with BlueZ running (standard on Fedora, Ubuntu, etc.).
- Bluetooth 4.0+ adapter supporting BLE.
- Your LibreServ server must be built with the `libreserv_ble` build tag:
  ```bash
  BUILD_TAGS=libreserv_ble make build
  ```

## Flags

| Flag | Default | Description |
|------|---------|-------------|
| `-code` | *(required)* | 6-character setup code from your LibreServ device |
| `-addr` | `127.0.0.1:18080` | Local proxy listen address |
| `-no-browser` | `false` | Don't automatically open a browser |

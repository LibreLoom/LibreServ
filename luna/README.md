# Luna

Luna is the $49 LibreServ file box. Local-first, no subscription, drives served as-is.

Setup is Ethernet-only: plug the included RJ45 (ethernet) cable into a router or modem. There is no setup Wi-Fi access point.

**Remote setup** (phone on the LAN, or later over the tunnel) requires the first eight characters (`****-****`) of the permanent device code when that code is on disk. Loopback / on-box setup is always allowed. If install skipped the code (local-only / air-gap), remote setup is refused — never left open. Add a device code later in Settings (or re-install with a code) to unlock remote setup and Luna Connect.

Luna Connect bind is offline on the website with the full device code. Luna pulls status on boot and every 5 minutes and auto-applies tunnel/domain/backup. Factory reset keeps the device-code file so a still-bound account can re-join.

## Layout
- `crates/luna-core` — storage model: drive states, `.luna` marker, safe paths
- `crates/lunad` — the daemon (axum + tokio + SQLite)
- `web/` — React 19 + Vite frontend, embedded into `lunad`

## Build
```sh
make web        # build frontend into crates/lunad/web/dist
make build      # build lunad (debug)
make test       # cargo test + web tests
make run        # build and run on :8090
```

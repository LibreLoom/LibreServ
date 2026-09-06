# Luna

Luna is the $49 LibreServ file box. Local-first, no subscription, drives served as-is.

Setup is Ethernet-only: plug the included RJ45 (ethernet) cable into a router or modem. There is no setup Wi-Fi access point.

**Setup** is open on the local network (loopback, `luna.local`, private IPs). **First registration over the public hostname** (the Connect name) asks for the **full device token** in the account-creation step — matched case-insensitively against `{data_dir}/device-token` (or Connect's `first_user_secret` in `connect.json`) and refused with plain-language copy when missing or wrong: remote first login never fail-opens. There is no `X-Setup-Token` header or 8-char prefix gate anymore; Connect's onboarding links to `/setup?token=` to prefill the token. Add or replace the token later in Settings → About → Advanced.

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

## Companion rapid-dev (desktop + mobile)

```sh
make companion-dev   # prints the three-terminal recipe
make daemon-dev      # lunad with cargo-watch on :8090
make desktop-dev     # GTK app: cargo-watch + auto sign-in
make mobile-dev      # Android: installDebug + relaunch on save (needs adb)
```

See `desktop/README.md` and `mobile/README.md` for env vars and details.

## Luna Connect Mock

For local development and testing without connecting to the real Luna Connect cloud service (`connect.luna.libreloom.org`), Luna includes a complete mock server in `scripts/mock-connect.py` and `scripts/mock-connect.sh`.

### Quick Start

Start the mock server on `http://127.0.0.1:18765`:
```sh
make mock-connect
# or: bash scripts/mock-connect.sh
```

Run `lunad` against the mock server:
```sh
LUNA_CONNECT_URL=http://127.0.0.1:18765 make dev-daemon
```

### CLI Control & Inspection

Inspect and control mock status while the server is running (or configure state ahead of time when stopped):

```sh
# View current status, domain, active mode, and cloud backup usage
make mock-connect ARGS="status"

# Generate a valid Crockford device token and save it to dev/device-token
make mock-connect ARGS="mint-token --write"

# Change subdomain (e.g. photos -> photos.luna.servers.libreloom.org)
make mock-connect ARGS="domain set photos"

# Toggle cloud backup status ($8/TB/month)
make mock-connect ARGS="backup unlock"
make mock-connect ARGS="backup lock"

# Inspect stored backup objects and simulated monthly storage cost
make mock-connect ARGS="backup stats"

# Clear stored cloud backup objects
make mock-connect ARGS="backup clean"

# Switch response modes and error simulations
make mock-connect ARGS="mode set bound"         # normal connected state
make mock-connect ARGS="mode set unbound"       # HTTP 403 unbound JSON (device not linked)
make mock-connect ARGS="mode set challenge"     # Cloudflare Bot Fight Mode HTML challenge
make mock-connect ARGS="mode set 401"           # HTTP 401 unauthorized / invalid token
make mock-connect ARGS="mode set storage_full"  # HTTP 413 cloud backup quota exceeded
```

### Mock Endpoints

- `GET /healthz` and `GET /api/v1/healthz`: Health checks
- `GET /api/v1/status`: Device status, tunnel token, and pairing state
- `POST /api/v1/domain`: Sets domain/subdomain
- `GET /api/v1/domain/available`: Subdomain availability check
- `PUT /api/v1/backup/objects/*`: Stores cloud backup chunks into `dev/mock-cloud-storage/`
- `GET /api/v1/backup/objects/*`: Restores stored backup chunks and tracks egress bandwidth
- `DELETE /api/v1/backup/objects/*`: Deletes stored backup chunks
- `GET /api/v1/backup/status`: Reports stored object count, total bytes, egress, and simulated cost
- `POST /_debug/mode` and `POST /_mock/mode`: Runtime mode switching



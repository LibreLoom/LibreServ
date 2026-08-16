# Luna

Luna is the $49 LibreServ file box. Local-first, no subscription, drives served as-is.

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

# Luna build progress

## M0 — Skeleton + CI + hardware qualification (IN PROGRESS)
- [x] Rust workspace: `luna-core` (storage model) + `lunad` (daemon)
- [x] `lunad` boots on axum+tokio, serves `/health`, `/api/v1/health`, `/api/v1/drives`
- [x] SQLite (WAL) metadata DB with `meta` + `drives` tables, rebuilt-from-drives design
- [x] React 19 + Vite frontend with copied LibreServ UI primitives (Button, Page, Card,
      HeaderCard, ModalCard, Pill, LayeredPill, IconCircle, TextLink, ThemeContext,
      useAnimatedHeight, useSmoothResize, haptics, theme tokens, FreeMono)
- [x] Frontend builds to `crates/lunad/web/dist`, embedded into the binary, SPA fallback,
      immutable cache headers for hashed assets
- [x] `ci.sh`: cargo fmt/clippy/test + web install/build/test/lint/typecheck (all green)
- [x] Hardware qualification checklist written (`hardware/QUALIFICATION.md`)
- [ ] Physically qualify Wi-Fi + BLE dongles on a Wyse 5020 and lock the BOM
- [ ] Wire `ci.sh` into the repo's `./ci` runner

## M1 — Safe drive handling (IN PROGRESS)
- [x] Drive lifecycle states in `luna-core` (`unknown/foreign/as_is/readonly/missing/ejected/failed`)
- [x] `.luna` marker read/write: atomic, one file, never touches drive contents
- [x] Path jail: canonicalized resolution rejects `..` and symlink escapes
- [x] Read-only top-level scan for the "here's what's on this drive" summary
- [x] sysfs + /proc/mounts detection (read-only), exposed at `/api/v1/drives/detected`
- [x] Mount manager: read-only inspection mounts, adoption mounts, eject; Luna only
      unmounts mounts it created; pre-existing OS mounts adopted in place
- [x] Adoption API: `/api/v1/drives/{name}/inspect|adopt|dismiss`, `/api/v1/drives/{id}/eject`
- [x] Adoption UI: /drives page with detected drives, read-only inspect modal,
      marker warning, label + adopt flow
- [x] Reconcile missing/ejected drives on startup and on each detection poll
- [ ] Read-only/failed transitions from I/O errors and full-disk detection

## M2 — Write path + WebDAV (COMPLETE except index listings, deferred to M7)
- [x] Path-jailed directory listing (`GET /api/v1/drives/{id}/files?path=`)
- [x] Streaming downloads with ETag/304, Range/206, content disposition
      (`GET /api/v1/drives/{id}/files/content`)
- [x] Multipart uploads with temp + fsync + atomic rename, overwrite protection
      (`POST /api/v1/drives/{id}/files/upload`)
- [x] WebDAV per adopted drive at `/dav/{id}` (dav-server LocalFs, FakeLs locks);
      PROPFIND/GET/PUT/MKCOL verified live
- [x] FilesPage: breadcrumbs, folder navigation, drag-and-drop upload, downloads
- [x] Chunked/resumable large uploads (SQLite-persisted sessions, out-of-order
      chunks, restart recovery, verify + atomic install)
- [x] Rename (never overwrites) + trash-first delete (`.luna-trash` same-drive
      atomic rename)
- [x] Copy/move job queue: SQLite-persisted progress, background thread pool,
      cancellation, conflict rejection, move = verified copy then trash source
- [ ] Index-backed listings (SQLite) — moved to M7 performance hardening

## M3 — Setup wizard + Wi-Fi (IN PROGRESS)
- [x] Network status from sysfs + /proc/net/route (`/api/v1/network/status`):
      Ethernet carrier, Wi-Fi interface/carrier, default route, no external commands
- [x] Wi-Fi provider abstraction: `WpaCliProvider` (scan/connect/verify/forget,
      save_config, never logs passphrases), `NoopProvider` fallback, mock for tests
- [x] Wi-Fi API: GET /network/wifi, GET /network/wifi/scan, POST connect, POST forget
- [x] Setup state API: GET/POST /api/v1/setup (name + setup_completed, SQLite-persisted)
- [x] Setup wizard UI (/setup): welcome with the four discovery paths, connection
      check (Ethernet optional/required logic), Wi-Fi scan + password + connect,
      name Luna, done → drives
- [x] BLE protocol core (byte-compatible with LibreServ's HTTP-over-GATT): same
      UUIDs, JSON shapes, auth-code flow, 300-byte base64 chunking, pending
      reassembly + timeout sweep; executes against Luna's own router
- [ ] BlueZ (bluer) GATT peripheral transport on Luna OS (trait is in place;
      NoopTransport used where no radio exists)
- [ ] LibreServ: Wi-Fi wizard step after Welcome/Preflight + shipped BLE default

## M4..M11 — Not started
See the final plan in the project memory / chat. Next: BLE bootstrap or M4 auth/users.

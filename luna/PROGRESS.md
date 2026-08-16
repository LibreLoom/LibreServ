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

## M2 — Write path + WebDAV (IN PROGRESS)
- [x] Path-jailed directory listing (`GET /api/v1/drives/{id}/files?path=`)
- [x] Streaming downloads with ETag/304, Range/206, content disposition
      (`GET /api/v1/drives/{id}/files/content`)
- [x] Multipart uploads with temp + fsync + atomic rename, overwrite protection
      (`POST /api/v1/drives/{id}/files/upload`)
- [x] WebDAV per adopted drive at `/dav/{id}` (dav-server LocalFs, FakeLs locks);
      PROPFIND/GET/PUT/MKCOL verified live
- [x] FilesPage: breadcrumbs, folder navigation, drag-and-drop upload, downloads
- [ ] Chunked/resumable large uploads
- [ ] Copy/move jobs, rename, trash-first delete, cross-drive operations
- [ ] Index-backed listings (SQLite) for >50ms-scale performance

## M3..M11 — Not started
See the final plan in the project memory / chat. Next: chunked uploads + jobs.

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
- [ ] Physically qualify a Wi-Fi dongle (AP + station) on a Wyse 3040 and lock the BOM
- [x] Wire `ci.sh` into the repo's `./ci` runner (`./ci run -profile luna`; also in full/nightly/nofuzz)

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
- [x] Read-only/failed transitions from I/O errors and full-disk detection (done in M7)

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
- [x] Index-backed listings (SQLite) — delivered in M7 (10k files ~22ms)

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
- [x] LibreServ: Wi-Fi wizard step after Welcome/Preflight; offline setup uses an open "LibreServ Setup" access point

## M4 — Users, grants, shares (IN PROGRESS)
- [x] Argon2 password hashing, JWT sessions (HttpOnly cookie + Bearer), first
      user is always admin, case-insensitive unique usernames
- [x] Global auth guard: health/auth/setup/SPA/public-share paths public;
      every other /api route requires a session
- [x] Auth API: register (open only while no users exist, then admin-only),
      login/logout/me/status
- [x] Users API: list/create/delete (admin-only, can't delete self)
- [x] Grants API: drive/folder scoped read|write grants; can_access enforces
      scope in files, uploads, and jobs (live-verified: user read=ok, write=403)
- [x] Shares API: password-hashed + expiring public links at /s/{token};
      file streaming + folder listing (live-verified with password)
- [x] Web UI: AuthProvider + ProtectedRoute, LoginPage, admin-account step in
      the setup wizard, UsersPage (create/remove users + drive/folder grants),
      SharesPage (create password/expiry links, copy, revoke)
- [x] "Shared with me" view for non-admin users (done in M11, /shared)

## M5 — Remote access (IN PROGRESS)
- [x] Connect client (ureq + rustls): activate key, provision tunnel, status,
      deactivate; state in 0600 root-only connect.json; key masked in API
- [x] Connect API: GET status, POST activate, POST tunnel/enable, POST deactivate
- [x] Remote access UI (/settings/remote): Luna Connect on/off + key entry,
      tunnel enable, port-forward + Tailscale/WireGuard plain-language paths
- [x] Auto-issue free Luna Connect keys (done in M11: POST /api/v1/luna/free-key)

## M6 — Luna Mobile (IN PROGRESS)
- [x] Android project at `luna/mobile` (photo backup over the home network)
- [x] Photo backup: native login screen stores a Luna JWT, WorkManager
      periodic worker (unmetered Wi-Fi + charging), MediaStore query since
      last backup, chunked uploads through Luna's resumable upload API to
      `Phone Backup/<year>/<month>` on the first drive
- [x] Backend login response now returns the bearer token for native clients
- [x] `./gradlew testDebugUnitTest` green; `assembleDebug` produces an APK
- [x] Device-token API (long-lived revocable app tokens): POST/GET/DELETE
      `/api/v1/device-tokens`, blake3-hashed storage, revoke
      without touching the password; auth guard accepts `Bearer <device-token>`
- [x] BackupActivity polish: switch + turn-off control, device name, one-time
      token mint (session JWT rolled into a device token, then discarded spooled),
      ANDROID POST_NOTIFICATIONS runtime permission, channel + progress/stopped/
      failure notifications; worker posts progress and self-clears on a revoked
      (401) token

## M7 — Reliability & performance hardening (IN PROGRESS)
- [x] Index-backed listings: `index_entries` + `indexed_dirs` tables; list_dir
      serves from SQLite when the directory mtime matches and refreshes from
      one read_dir otherwise — correctness for Luna/WebDAV/direct writes
- [x] Recursive background reindex (`POST /api/v1/system/reindex`) and scoped
      search (`GET /api/v1/search?q=`) respecting user grants
- [x] SMART drive health (`GET /api/v1/drives/{id}/health`): smartctl optional,
      parses overall status/model/serial/temperature/reallocated sectors
- [x] Periodic checksum scrub: blake3 file hashes in SQLite, hash-on-first-run,
      re-verify on demand (`POST /api/v1/system/scrub`), and a quiet-hours
      worker (local 01:00–05:00, skip if busy or already running, persist last run)
- [x] Automatic writability probe every 15 min: create/write/fsync/delete;
      failures transition the drive to `readonly`, never `failed`
- [x] Login/register rate limiting (10 per 5 min per IP, plain-language 429)
- [x] Listing benchmark: 10,000 files served from SQLite in ~22ms (<50ms target)
- [x] Full-disk/read-only detection in write paths: upload and chunked-upload failures transition the drive to `readonly`

## M8 — OS image + flash pipeline (DONE first pass)
- [x] `os/build-rootfs.sh`: Alpine 3.24 rootfs via podman/apk (alpine-base,
      openrc, avahi, wpa_supplicant, hostapd, e2fsprogs, exfatprogs,
      ntfs-3g-progs, smartmontools, syslinux, dhcpcd, util-linux), OpenRC
      services for sysinit/boot/default (lunad, avahi, wpa_supplicant),
      luna-net-fallback (169.254.42.42 direct-cable), musl release lunad
- [x] `os/make-image.sh`: raw 1.2 GB ext4 image labeled LUNA from the rootfs
      (verified: debugfs shows /usr/local/bin/lunad + hostname)
- [x] `os/flash.sh`: whole-disk-only, GPT bios_grub+ESP+root, GRUB BIOS+UEFI
- [x] Rapidinstall ISO: `os/make-iso.sh` UEFI+BIOS hybrid USB; flashed disk is
      GPT bios_grub+ESP+root with GRUB i386-pc and x86_64-efi so mini PCs,
      Wyse 3040, and other x86_64 boxes can boot. Secure Boot must be off.
- [x] `os/REHEARSAL.md`: 5-unit rehearsal checklist (materials, flash, first
      boot, setup, storage safety, links, remote, reliability, ship)
- [x] Built rootfs booted in a container: lunad served /health
- [ ] Flash a physical Wyse 3040 with the rapidinstall ISO and run the rehearsal

## M9 — Luna Desktop (DONE first pass)
- [x] Tauri 2 app at `luna/desktop` (Linux build verified; same code compiles
      for macOS/Windows via Tauri targets)
- [x] Native login → lists drives; folder picker via dialog plugin
- [x] Folder backup engine: inotify watcher + initial recursive scan, uploads
      through the same resumable chunked API as web/mobile, retry queue
- [x] One-click WebDAV mount: gio mount on Linux, open/Finder on macOS,
      Windows start/network-drive instructions
- [x] `cargo test` green (HTTP client integration against a fake Luna API);
      `npm run build` green; `tauri build --no-bundle` produced a 13MB binary
- [x] Tray icon/status + installer configuration (done in M11; Linux `make desktop-bundle` for deb/AppImage; macOS/Windows signing not required)
- [ ] Real-machine mount/backup soak test

## M10 — Photo gallery (DONE first pass)
- [x] Gallery scanner: walks adopted drives for jpg/jpeg/png/gif, records
      size/mtime/dimensions in the `photos` table (symlinks skipped)
- [x] Thumbnails: 400px JPEG generated once with the pure-Rust image crate,
      cached under the data dir, served immutable; originals untouched
- [x] API: POST /api/v1/gallery/scan (background), GET /api/v1/gallery
      (timeline, grant-checked), GET /api/v1/gallery/thumb (lazy + cached)
- [x] Photos page (/gallery): drive picker, masonry grid, lazy images, links
      to originals
- [x] HEIC/HEIF listing + EXIF capture dates for timeline sort (JPEG APP1 and
      HEIF `Exif` item). Thumbs: embedded JPEG when present, else Alpine
      `libheif-tools` (`heif-dec`). Originals untouched. Face search / albums not in this pass.

## M11 — Polish (IN PROGRESS)
- [x] "Shared with me" view (/shared): lists the current user's grants with
      drive labels and opens FilesPage at the granted path (`?path=`)
- [x] OS build uses the default lunad binary (no BLE feature); rootfs ships hostapd+dnsmasq for setup AP
- [x] AP-mode hotspot software: auto-starts open "Luna Setup" when no Ethernet/Wi-Fi and setup incomplete, stops when connected/setup done; hostapd+dnsmasq config; API start/stop/status; hardware qualification still pending
- [x] Desktop tray icon (show/quit menu, left-click opens, tray-enabled release binary built); installer targets configured (deb/appimage/msi/dmg) — final bundling runs per-platform
- [x] Full-disk/read-only detection in write paths: upload and chunked-upload failures transition the drive to `readonly`
- [x] Protect-a-folder redundancy: append-only second copy on another drive, 30-min background sync + manual run, `/settings/protect` UI
- [x] Free one-tap Connect keys: Connect endpoint `/api/v1/luna/free-key` mints a free-plan account+key per Luna (10/hour/IP); Luna Remote page is now one tap with no key entry
      TODO(luna-connect-rebuild): rate-limit must use real RemoteAddr when Connect is rebuilt — not X-Forwarded-For. Do not change the current limiter now.
- [x] Locked-out admin recovery: USB keyboard sequence (Esc, then type `luna`, then Enter) on the appliance; TTY password reset; rate-limited; documented on setup done + Settings
- [x] Software updates: Forgejo `luna-*` releases, SHA-256 verified `lunad-*` binary, tap-to-install in Settings (no silent apply)
- [ ] Physical 5-unit rehearsal on Wyse 3040 hardware

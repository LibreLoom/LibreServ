# AGENTS.md - luna

Luna is the file-box product: `lunad` (Rust daemon) + web UI + desktop/mobile
companion apps + its own OS image + Luna Connect cloud companion. Global rules
(plain language, design system, frontend conventions, git/forge rules) live in
the repo-root `AGENTS.md` — they apply here too.

## Layout

```
luna/
├── crates/
│   ├── lunad/            # the daemon — src/ is grouped by domain:
│   │                     #   api/ HTTP handlers; drives/ detect→mount→health;
│   │                     #   files/ index+WebDAV+uploads; gallery/ photos;
│   │                     #   office/ EuroOffice; net/ network+connect client;
│   │                     #   backup/ cloud+protect; system/ updates+recovery;
│   │                     #   top-level: auth, db, jobs, config plumbing
│   └── luna-core/        # shared lib (drive/path/scan/marker)
├── web/                  # Luna web UI — React/Vite (dev port 3001)
├── desktop/              # companion app — Rust + GTK 4/libadwaita
│   └── packaging/        # flatpak (ship), appimage (demo/CI), windows (NSIS),
│                         # macos/build.sh (.app + .dmg; runs on a Mac only —
│                         # GTK needs the macOS SDK; not part of CI)
├── mobile/               # companion app — native Android (Kotlin/Gradle)
│   ├── fdroid/           # fdroiddata metadata draft for F-Droid submission
│   └── fastlane/         # store listing text (F-Droid reads this)
├── connect/              # Luna Connect cloud companion (independent Go 1.27
│                         # module). Host: connect.luna.libreloom.org.
│                         # Device names: *.luna.servers.libreloom.org.
│                         # Stripe $8/TB/month backups.
├── quick-start/          # printable quick-start leaflet (React/Vite) — two guides per US Letter
│                         # sheet, one device token each; see quick-start/README.md
├── os/                   # Alpine OS: rootfs build, A/B updates, factory ISO
├── scripts/              # dev helpers; mocks/ holds the mock-connect/mock-drive cluster
├── docs/                 # eurooffice guide, THIRD_PARTY license, HW qualification
├── ci.sh                 # luna CI (invoked by ./ci -profile luna)
└── Makefile              # dev entry points (daemon-dev, desktop-dev, mobile-dev…)
```

## Build & Run

- `make daemon-dev` — lunad on :8090, restarts on save (cargo-watch)
- `make companion-dev` — prints the three-terminal recipe (daemon + desktop + mobile)
- `make desktop-dev` — GTK app, cargo-watch + auto sign-in
- `make mobile-dev` — Android `installDebug` + relaunch on save (needs `adb`)
- `make eurooffice` — extracts EuroOffice pack into `luna/dev/` + Document Server sidecar on :8088 (see `docs/eurooffice.md`)

### Verification

- Run `./ci run -p luna` from the repo root; it runs `luna/ci.sh` across the daemon, OS scripts, desktop, mobile, and web.
- Run permission-based read-only-drive tests as a non-root user. Root bypasses the Unix permission restrictions those tests use.

### Luna Connect web (`connect/web`)

`connect/web` is **not** on `@libreloom/ui`. It keeps its own shadcn base
(`src/components/ui/`) on purpose — do not migrate it or restyle it to match
`luna/web`. It still shares the repo tooling: `npm run scan:colors` (script lives
in `shared/ui/scripts/`), `npm run typecheck`, and the FreeMono fonts in
`shared/ui/fonts/` (served by `shared/ui/vite/sharedFonts.js`).

### Luna Connect
```bash
cd luna/connect
cp configs/luna-connect.yaml.example configs/luna-connect.yaml
make test
make build   # → bin/luna-connect
```
Env prefix: `LUNACONNECT_`. Admin → Connections stores Stripe, Resend, B2, and
Cloudflare (tunnel + DNS) in `service_providers`; yaml/env is the fallback when
no enabled DB provider exists (same overlay pattern as Stripe). Deploy scripts
live in `connect/deploy/` — note `deploy.sh` resolves repo root three levels up.

## Mobile release & distribution

- **Channels:** F-Droid (primary, they build+sign from `luna-android/v*` tags) and a
  self-signed APK on Forgejo releases. Two signatures — users can't switch
  channels without reinstalling.
- **Signing:** `assembleRelease` always builds an unsigned APK, which is what
  F-Droid needs; `./release` signs it afterwards in a separate offline container
  with the release passphrase (asked at the cut, never saved) and verifies the
  certificate against `keys/luna-android.cert.sha256`.
- **Versioning:** `versionCode`/`versionName` are plain literals — F-Droid's
  checker parses them at each `luna-android/v*` tag. Bump `versionCode` for every
  release that ships the app; `./release` warns when it hasn't moved.
- Details: `mobile/README.md`.

## Key Notes

- **Forms answers follow Read.** Reading answers — the Responses list, totals, CSV export, usage, and the SQLite download/editor — needs `CAP_VIEW`. Deleting, clearing, saving and schema edits need `CAP_EDIT`. Read means read the answers; `CAP_EDIT` gates changing them. Respond links never expose answers. That is decided — do not re-ask or "fix" it.
- **No terminal for users:** a Luna has no shell anyone is meant to use. Everything happens in the web UI and companion apps. Only modders, and occasionally support, touch a shell, so never write UI, errors, or user docs that send someone there.
- **Setup is Ethernet-only** — Luna has no setup AP. Never tell users to finish setup on an HDMI/on-device screen — Luna setup is browser-only.
- **Luna Connect opt-in:** Connect is **off by default**. `{data_dir}/device-token` holds the 20-character Crockford **device token** with mode `0600`; without it Luna never contacts Connect. The token identifies the device, pairs it to an account, and proves an off-LAN first-Admin setup. It survives pairing, unbind, and factory reset, is never rotated or re-minted (only Connect staff and the DIY $1 flow mint tokens), and is never the ongoing credential. While unbound, Luna polls `POST /api/v1/devices/pair/claim` with it; it does not start a tunnel or treat the token as local login proof. Set or replace it in the Device token section's Advanced area. The `device-uid`, `pairing-code`, `setup-token`, and `first_user_secret` files are removed. Design: `docs/connect-auth/DESIGN.md`.
- **Luna Connect authentication:** A verified Connect account starts pairing with `POST /api/v1/devices/pair` and polls the returned pairing ID. Luna's successful claim stores the hidden rolling credential in `{data_dir}/connect-credential` (`0600`) and marks Connect bound. Bound Luna uses that credential as Bearer auth for status, domain, storage, and other device routes, refreshes it every five minutes and after reconnect through `POST /api/v1/token/refresh`, and never displays it. Refreshing invalidates the old credential on normal routes, with a 60-second overlap only on refresh; unbind, reset-with-disconnect, and revocation invalidate it immediately. `connect.json` holds hostname, tunnel, and bound-state configuration. Failed revocation leaves `connect-unbind-pending`, stops remote access, and blocks pairing until retry succeeds. Replacing the local device token is local-only and makes no Connect request.
- **First-Admin setup:** Setup is Ethernet-only and browser-only. LAN first registration stays open under the existing Host, Origin, and client-IP checks (loopback/private/link-local/ULA client IPs; `luna.local` / `.local` hostnames also hint LAN — `is_lan_request` in `crates/lunad/src/api/auth.rs`, UI hints only). Forwarding headers (`CF-Connecting-IP` / `X-Real-IP` / `X-Forwarded-For`) are honored **only from a loopback peer** — `client_ip` in `crates/lunad/src/api/auth.rs`. **Off-LAN first registration requires the full device token**, which Luna compares locally (case-insensitive, grouping ignored) with `{data_dir}/device-token`; a missing or wrong token is refused in plain language and never fails open. Connect's onboarding links to `/setup#token=<token>` to prefill it (URL fragment, never the query string). There is no setup grant and no separate setup key, and the rolling credential is not accepted as first-Admin proof.
- **Luna Connect settings:** Settings → Luna Connect always shows for everyone; its **Device token** section holds the address, the device token (with Advanced to set or replace it), cloud backup, and the recovery phrase card. There is no separate Cloud backup entry and it is not Admin-only. Factory reset offers **Keep Connect** and **Disconnect**; Disconnect stops remote access and allows the device to be connected again later, and the device token survives both. The user-facing term is **device token**, not setup code, device code, Device ID, or Verification code.
- **Update signing:** lunad verifies release checksums with a minisign public key embedded at build time (`include_str!` → `keys/luna.minisign.pub` at repo root) and verifies the signed release feed (`infra/ci-source/internal/feed/README.md`) with it; Settings can override the feed address and keys. The `keys/` directory path is load-bearing — do not move it.

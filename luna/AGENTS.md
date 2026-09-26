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
│   └── packaging/        # flatpak (ship), appimage (demo/CI), windows (NSIS)
├── mobile/               # companion app — native Android (Kotlin/Gradle)
│   ├── fdroid/           # fdroiddata metadata draft for F-Droid submission
│   └── fastlane/         # store listing text (F-Droid reads this)
├── connect/              # Luna Connect cloud companion (independent Go 1.26
│                         # module). Host: connect.luna.libreloom.org.
│                         # Device names: *.luna.servers.libreloom.org.
│                         # Stripe $8/TB/month backups.
├── os/                   # Debian live OS: rootfs build, A/B updates, factory ISO
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

- **Channels:** F-Droid (primary, they build+sign from `luna-v*` tags) and a
  self-signed APK on Forgejo releases. Two signatures — users can't switch
  channels without reinstalling.
- **Signing:** env-gated `signingConfigs.release` in `app/build.gradle.kts`
  (`LUNA_ANDROID_KEYSTORE` / `_B64`, `_STORE_PASSWORD`, `_KEY_ALIAS`,
  `_KEY_PASSWORD`). Unset → unsigned release APK (what F-Droid needs).
- **Versioning:** `versionCode`/`versionName` are plain literals — F-Droid's
  checker parses them at each `luna-v*` tag. Bump `versionCode` for every
  release that ships the app; `release.sh` warns when it hasn't moved.
- Details: `mobile/README.md`.

## Key Notes

- **Setup is Ethernet-only** — Luna has no setup AP (`crates/lunad/src/net/hotspot.rs` is a stub that never starts). Never tell users to finish setup on an HDMI/on-device screen — Luna setup is browser-only.
- **Luna Connect opt-in (`device-token`):** Connect is **off by default**. Luna only polls connect.luna.libreloom.org when `{data_dir}/device-token` exists with a valid Crockford token. No `disable-connect` file — empty opt-out at install is success. **`connect.json`** holds cloud bind state (hostname, tunnel) plus an optional `first_user_secret`, and only matters when a device token is present. Setup is open on LAN (loopback/private/link-local/ULA client IPs; `luna.local` / `.local` hostnames also hint LAN — `is_lan_request` in `crates/lunad/src/api/setup.rs`, UI hints only). Forwarding headers (`CF-Connecting-IP` / `X-Real-IP` / `X-Forwarded-For`) are honored **only from a loopback peer** — `client_ip` in `crates/lunad/src/api/auth.rs`. **First registration from off-LAN requires the full device token** — `first_user_device_token` in `crates/lunad/src/api/auth.rs` matches it case-insensitively against `{data_dir}/device-token` or `first_user_secret` in `connect.json` (with an on-demand `poll_status()` refresh; plain-language refusal when missing or wrong). No 8-char `X-Setup-Token` prefix gate anymore (`setup_access.rs` is deleted); Connect onboarding links to `/setup?token=` to prefill the token. Add/remove tokens in Settings → About → Advanced; External Services UI shows only when `connect_active`. User-facing term is **device token**, not setup code or device code.
- **Update signing:** lunad verifies release checksums with a minisign public key embedded at build time (`include_str!` → `keys/lsluna.minisign.pub` at repo root) and can also fetch it over HTTP from `raw/branch/main/keys/…`. The `keys/` directory path is load-bearing — do not move it.

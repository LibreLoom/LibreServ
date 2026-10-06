# Release and update rework — plan

Status: planning. Replaces `release.sh`, Forgejo Releases, and the current
updaters once built. `RELEASE.md` describes the old flow until then.

Order: **receiving end first** (everything that installs or updates), then the
supplier (release tool).

## Release units

Each unit has its own version, tag, files, and feed. Releasing one never
touches another.

| Unit | Ships | Updated by |
|---|---|---|
| `sol` | Sol binaries (amd64, arm64) | Sol in-app updater, `sol/install.sh` |
| `sol-connect` | server binary + web bundle | shared Connect `deploy.sh` |
| `luna` | lunad (musl) + OS image when the OS changed + factory ISO | lunad updater |
| `luna-desktop` | Flatpak bundle, Windows installer | Flatpak repo (Linux), feed (Windows) |
| `luna-android` | APK | F-Droid; sideload |
| `luna-connect` | server binary + web bundle | shared Connect `deploy.sh` |

## Versions

- Semver per unit. Pre-1.0 is `0.x`. Betas are `X.Y.Z-beta.N`.
- One `VERSION` file per unit is the source of truth. The release tool bumps
  it, writes it where toolchains need it (`Cargo.toml`, `build.gradle.kts`),
  commits `chore(release): <unit> <version>`, and tags that commit.
- Android `versionCode` is derived from the version (`major*10000 +
  minor*100 + patch`); exact beta handling decided when building it.
- Compatibility between units is an **API version**, not a product version:
  lunad reports `api.version` and `api.oldest_supported` on `/api/v1/health`;
  Desktop and Android check it.

## Tags

- `<unit>/vX.Y.Z` (e.g. `luna/v0.4.0`), created last, only by the tool, on
  `main`, pushed to Forgejo. Records what code was built; F-Droid and Connect
  deploys key off them. Fallback naming if slashes misbehave anywhere:
  `<unit>-vX.Y.Z`.
- Old `v*`, `luna-v*`, `connect-v*`, `luna-connect-v*` stop being used.

## Files

Forgejo **generic package registry** — no Forgejo Releases.

```
https://gt.plainskill.net/api/packages/LibreLoom/generic/<unit>/<version>/<file>
```

Every package version also holds `SHA256SUMS.txt` + `SHA256SUMS.txt.minisig`,
so installing an exact older version stays verifiable without the feed.

## Feeds

Orphan branch `feeds`, holding only feed files (plus a README). One commit per
release. Never checked out for normal work.

```
https://gt.plainskill.net/LibreLoom/LibreServ/raw/branch/feeds/<unit>/<channel>.json
                                                                   + .json.minisig
```

Channels: `stable`, `beta`. Publish `stable` first; the format supports both.

### Format 1

```json
{
  "format": 1,
  "unit": "luna",
  "channel": "stable",
  "version": "0.4.0",
  "published": "2026-10-12T14:03:00Z",
  "notes": "markdown",
  "parts": [
    { "name": "lunad", "os": "linux", "arch": "amd64",
      "file": "lunad-linux-amd64-musl", "size": 27778648, "sha256": "…",
      "urls": ["…/generic/luna/0.4.0/lunad-linux-amd64-musl"] },
    { "name": "os", "arch": "amd64",
      "file": "luna-os-x86_64.img.xz", "size": 412000000, "sha256": "…",
      "urls": ["…/generic/luna/0.3.0/luna-os-x86_64.img.xz"] }
  ],
  "api": { "version": 3, "oldest_supported": 2 }
}
```

### Rules for every receiver

1. Verify the `.minisig` over the exact feed bytes with the pinned key before
   parsing.
2. `unit` and `channel` must match the request; unknown `format` → no update,
   plain message.
3. Never go backwards: reject a feed whose `published` is older than the newest
   seen (stops replay of an old signed feed), and never install a lower
   `version`. Bad releases are fixed forward with a higher version.
4. Pick parts by `name` + `arch`; try `urls` in order; check `size` and
   `sha256` before using anything.
5. Compare versions as semver, including `-beta.N`.

## Keys

| Key | Signs | Lives |
|---|---|---|
| Sol minisign (`keys/libreserv.minisign.pub`) | `sol`, `sol-connect` feeds + sums | pscB |
| Luna minisign (`keys/lsluna.minisign.pub`) | `luna*` feeds + sums | pscB |
| Luna Desktop Flatpak GPG (`keys/luna-desktop-flatpak.gpg`) | Flatpak repo commits + summary | Generated on the Luna Connect server as the watcher's own user, readable only by it; backup + revocation cert in Proton Pass |

## Receiving end — changes

### Sol box (`sol/server/backend/internal/system`, web)

- `UpdatesConfig{BaseURL, Owner, Repo}` → `{FeedURL, Channel}`.
- Replace the `releases?limit=50` listing, tag regex, string-compare fallback,
  and `fetchSignedChecksum` with feed fetch + verify + rules; pick `sol` part
  for `GOARCH`.
- Stage the download beside the binary, not in `/tmp` (rename across
  filesystems fails).
- Keep `/system/updates/check` response shape; drop `url`. Web: drop the
  release-page link, add a Stable/Beta choice.
- Tests on signed feed fixtures: bad signature, wrong unit, older
  `published`, missing arch.

### Sol installer (`sol/install.sh`)

- `latest`: feed + inline key → version + part for `ARCH`.
- Exact version: package version's `SHA256SUMS.txt` + `.minisig`.

### Luna box (lunad, web, OS)

- Version from `luna/VERSION` via `build.rs`; one constant replaces the three
  `CARGO_PKG_VERSION` uses.
- Feed code in `luna-core` (shared with Desktop). Remove `ForgejoRelease`,
  `pick_latest_luna`, release listing, `fetch_signed_sums`.
- `lunad` part: newer `version` → install (musl build). `os` part: `sha256` ≠
  `os-image.sha256` → stream-decompress `.img.xz` onto the inactive slot, then
  store the hash.
- Update source settings → `{feed_url, channel, keys}`; drop
  `fetch_repo_signing_keys`. Rewrite `UpdateSourceCard.jsx` copy and tests.
- `/api/v1/health` gains `api`.
- `luna-run`: run whichever of `/var/lib/luna/bin/lunad` and the baked lunad
  is newer (`lunad --version`), so a stale daemon-only update can't shadow a
  newer OS.

### Luna Desktop

- **Linux (Flatpak):** no in-app updater. Bundles are built with
  `--repo-url`, `--gpg-keys`, `--default-branch=<channel>`; installing one adds
  our repo as a source and the software center updates it. Optional: Flatpak
  portal "update ready, restart" prompt.
- **Windows:** feed check → download installer → verify → run.
- Compatibility check against lunad `api`.
- Runtime → current GNOME (manifest pins 47, end of life). Turn appstream
  compose back on; add a `<release>` entry per release.

### Luna Desktop Flatpak repo server (`infra/flatpak-repo/`, new)

Hosted on the **Luna Connect server**, as its own Caddy site
(`flatpak.luna.libreloom.org`) behind Cloudflare:

- Repo under `/srv/luna-flatpak/`, outside the checkout `deploy.sh` resets.
- Watcher runs as its own system user, the only one that can read the GPG key.
- Cache rules: `summary`, `summary.sig`, `config`, `refs/` fresh (≤ 1 min);
  `objects/` and `deltas/` cached forever.
- Traffic arrives through the server's `cloudflared` tunnel (dashboard-managed)
  at `localhost:80`, so add a public hostname for it in the tunnel. Don't copy
  the repo Caddyfile's Cloudflare-IP rule: tunnel traffic comes from loopback.

Script + systemd timer. Every few minutes:

1. Fetch `feeds/luna-desktop/{stable,beta}.json`, verify minisign.
2. Newer than the repo's branch → download the bundle, check `sha256`.
3. `flatpak build-import-bundle --gpg-sign=KEY` into the matching branch.
4. `flatpak build-update-repo --gpg-sign=KEY --generate-static-deltas --prune`.
5. Serve `repo/`, the bundle, and a `.flatpakref` over HTTPS.

### Luna Android

- Compatibility check against lunad `api`.
- Updates stay with F-Droid (no self-update in F-Droid builds).
- F-Droid metadata: `UpdateCheckMode: Tags ^luna-android/v…`, new
  `Changelog:` link (after the supplier side exists).

### Connect servers

- One shared deploy script for `sol-connect` and `luna-connect`: feed →
  verify → download binary + web bundle → blue/green. No building on the
  server. `--version X` via the package's signed sums; `--head` stays for dev.

### Bootstrapping

- Existing boxes can't read feeds; no users, so reflash/reinstall test boxes.
- A dev script builds signed test feeds with a throwaway key so receivers can
  be tested before the release tool exists.

## Build order (receiving end)

1. This spec + signed test feeds
2. Shared feed code (Go, Rust)
3. Sol box + `install.sh`
4. lunad + Luna web + `luna-run`
5. Desktop (Windows check, compat check, Flatpak manifest) + Flatpak repo server
6. Android compat check
7. Connect deploy

## Open

- GNOME runtime: 50 or 51 (51 is on Flathub; 50 ends around March 2027).
- Android self-update for sideloaded installs: default is no.
- Confirm slash tags work with Forgejo and F-Droid.

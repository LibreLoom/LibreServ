# Release and update rework — plan

Status: receiving end built (Sol, lunad, Desktop, Android, Connect deploy,
Flatpak repo server); release tool next. Replaces `release.sh` and Forgejo
Releases. `RELEASE.md` describes the old flow until then.

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
- Versions are strict semver 2.0: no leading `v`, no leading zeros. Go uses
  Masterminds `semver.StrictNewVersion` (or equivalent), Rust the `semver`
  crate. `0.3.0-beta.2 < 0.3.0-beta.10 < 0.3.0`.
- Compatibility between units is an **API version**, not a product version.
  lunad returns `"api": {"version": N, "oldest_supported": M}` on
  `/api/v1/health`, starting at version 1, oldest_supported 1. Each client
  (Desktop, Android) has a built-in `CLIENT_API` it was written against:
  - `CLIENT_API` > `api.version` (or `api` missing) → Luna is too old; tell the
    person to update Luna.
  - `CLIENT_API` < `api.oldest_supported` → this app is too old; tell them to
    update the app.
  - Otherwise compatible.
  lunad bumps `version` when it adds API a client may rely on, and raises
  `oldest_supported` only when it removes or breaks something.

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
    { "name": "os", "os": "linux", "arch": "amd64",
      "file": "luna-os-x86_64.img.xz", "size": 412000000, "sha256": "…",
      "urls": ["…/generic/luna/0.3.0/luna-os-x86_64.img.xz"] }
  ],
  "api": { "version": 3, "oldest_supported": 2 }
}
```

`published` is UTC, exactly `YYYY-MM-DDTHH:MM:SSZ`, so plain string
comparison orders it (bash receivers rely on that). Every part has `os` and
`arch`. File names carry no version; the version is in the URL path.
`os` ∈ {`linux`, `windows`, `android`, `any`}; `arch` ∈ {`amd64`, `arm64`, `any`}.

| Unit | Part | os | arch | File |
|---|---|---|---|---|
| `sol` | `sol` | linux | amd64, arm64 | `libreserv-linux-<arch>` |
| `sol-connect`, `luna-connect` | `server` | linux | amd64 | `<unit>-server-linux-amd64` |
| | `web` | any | any | `<unit>-web.tar.gz` |
| `luna` | `lunad` | linux | amd64 (musl) | `lunad-linux-amd64-musl` |
| | `os` | linux | amd64 | `luna-os-x86_64.img.xz` |
| | `installer` | linux | amd64 | `luna-rapidinstall-x86_64.iso.xz` |
| `luna-desktop` | `flatpak` | linux | amd64 | `luna-desktop-x86_64.flatpak` |
| | `windows` | windows | amd64 | `Luna-Desktop-Setup-x86_64.exe` |
| `luna-android` | `apk` | android | any | `luna-android.apk` |

### Rules for every receiver

1. Verify the `.minisig` over the exact feed bytes with the pinned key before
   parsing. Signatures are minisign's prehashed `ED` form (the CLI default;
   in Go, `aead.dev/minisign` `Reader.Sign`); receivers may refuse legacy `Ed`.
2. `unit` and `channel` must match the request; unknown `format` → no update,
   plain message. Unknown JSON fields are ignored (format 1 can gain optional
   fields).
3. Never go backwards: reject a feed whose `published` is older than the newest
   seen (stops replay of an old signed feed; equal is fine). Receivers store
   the newest `published` **per unit + channel**, so switching channel never
   trips this. Never install a lower `version`; bad releases are fixed forward
   with a higher version.
4. Pick the part whose `name` equals the request, whose `os` is the request's
   or `any`, and whose `arch` is the request's or `any`. Try `urls` in order;
   check `size` and `sha256` before using anything.
5. Compare versions as strict semver, including `-beta.N`. Same version as
   installed → no update; lower → no update (never install it).
6. In a package's `SHA256SUMS.txt`, match the file name field exactly, never as
   a substring.

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
- The factory installer and flasher must write `os-image.sha256` as the
  sha256 of the exact `luna-os-x86_64.img.xz` the feed lists (today
  `flash-disk.sh` hashes the rootfs tarball), or a fresh box offers an OS
  reflash on its first check. Fix with the release tool.
- `luna-run`: run whichever of `/var/lib/luna/bin/lunad` and the baked lunad
  is newer (`lunad --version`), so a stale daemon-only update can't shadow a
  newer OS.

### Luna Desktop

- **Linux (Flatpak):** no in-app updater. CI builds a plain bundle (branch
  = channel) that is only the repo server's input. The server re-signs it into
  its repo and builds the bundle people download from that repo with
  `--repo-url` and `--gpg-keys`; installing it adds our repo (signature checks
  on) and the software center updates from there. A bundle that carries
  `--gpg-keys` but an unsigned commit fails to install, so the download must
  come from the server. Optional: Flatpak portal "update ready, restart" prompt.
- **Windows:** feed check → download installer → verify → run.
- Compatibility check against lunad `api`.
- Runtime → GNOME 51 (decided; manifest pins 47, end of life). Turn appstream
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
5. Build the download bundle from the signed repo (`--repo-url`,
   `--gpg-keys`), and serve `repo/`, that bundle, and a `.flatpakref`.

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

1. Spec + signed test feeds
2. Shared feed code (Go, Rust)
3. Sol box + `install.sh`
4. lunad + Luna web + `luna-run`
5. Desktop (Windows check, compat check, Flatpak manifest on GNOME 51)
6. Android compat check
7. Connect deploy script
8. Flatpak repo server

## Release tool must (found while building the receivers)

- Sign feeds and sums in minisign's prehashed `ED` form (lunad refuses `Ed`).
- Have the factory installer and flasher write `os-image.sha256` as the hash
  of the `.img.xz` the feed lists.
- Build the CI Flatpak bundle with branch = channel and no `--repo-url` or
  `--gpg-keys`: it is only the repo server's input.
- Pack `web` bundles with `admin/` and `customer/` at the top for
  `sol-connect`, and the site files (`index.html` …) at the top for
  `luna-connect` (`infra/connect-deploy` checks this).
- Bump `luna/desktop/VERSION` with the `luna-desktop` unit;
  `packaging/windows/build-cross.sh` refuses a version mismatch.
- Create `VERSION` for `sol`, `sol-connect`, `luna-android`, `luna-connect`
  (only `luna/VERSION` and `luna/desktop/VERSION` exist so far) and stamp Sol
  builds with it (an unstamped Sol reports `dev` and never updates).
- Retire `release.sh`: nothing reads Forgejo Releases any more.

## Test fixtures

`infra/feed-testdata/` holds signed feeds, payloads, and `cases.json` that
every receiver tests against; see its README. They are signed with a TEST-ONLY
key that must never go in `keys/` or be trusted by production builds; tests
inject it through the receiver's key-override hook. Regenerate (deterministic):
`cd infra/ci-source && go run ./cmd/feedgen`.

## Open

- Android self-update for sideloaded installs: default is no.
- Confirm slash tags work with Forgejo and F-Droid.

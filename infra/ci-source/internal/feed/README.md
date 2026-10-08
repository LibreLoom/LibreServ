# Release units, versions and signed feeds

The contract between the release tool (`cmd/release`) and everything that
installs or updates: Sol, lunad, Luna Desktop, Android, the Connect deploy
script and the Flatpak repo server. Test fixtures: `infra/feed-testdata/`.

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

- Strict semver 2.0 per unit: no leading `v`, no leading zeros. Pre-1.0 is
  `0.x`; betas are `X.Y.Z-beta.N`. `0.3.0-beta.2 < 0.3.0-beta.10 < 0.3.0`.
  Go uses Masterminds `semver.StrictNewVersion`, Rust the `semver` crate.
- One `VERSION` file per unit is the source of truth. The tool bumps it,
  writes it where toolchains need it (`Cargo.toml`, `build.gradle.kts`),
  commits `chore(release): <unit> <version>`, and tags that commit.
- Dev/HEAD builds are `<next patch>-0.dev.<commits since tag>` (e.g.
  `0.4.1-0.dev.12`): below every beta and release of that version. No `+build`
  metadata (the bash receivers' semver check rejects it); the commit is
  stamped separately.
- Android `versionCode = (major*10000 + minor*100 + patch) * 100 + n`, `n` =
  beta number (1–98) or 99 for a final. `versionName`/`versionCode` are
  literals in `app/build.gradle.kts` (F-Droid reads them at the tag).
- Compatibility between units is an **API version**, not a product version.
  lunad returns `"api": {"version": N, "oldest_supported": M}` on
  `/api/v1/health`. Each client (Desktop, Android) has a built-in `CLIENT_API`:
  - `CLIENT_API` > `api.version` (or `api` missing) → Luna is too old; tell the
    person to update Luna.
  - `CLIENT_API` < `api.oldest_supported` → this app is too old; tell them to
    update the app.
  - Otherwise compatible.

  lunad bumps `version` when it adds API a client may rely on, and raises
  `oldest_supported` only when it removes or breaks something.

## Tags

`<unit>/vX.Y.Z` (e.g. `luna/v0.4.0`), created last, only by the tool, on
`main`, pushed to Forgejo. F-Droid (`UpdateCheckMode: Tags ^luna-android/v.*`)
and Connect deploys key off them. Forgejo's release API and URLs need `%2F` for
the slash; we only use generic packages, so nothing here does.

## Files

Forgejo **generic package registry** (no Forgejo Releases):

```
https://gt.plainskill.net/api/packages/LibreLoom/generic/<unit>/<version>/<file>
```

Every package version also holds `SHA256SUMS.txt` + `SHA256SUMS.txt.minisig`,
so an exact older version stays verifiable without the feed. File names carry
no version.

## Feeds

Orphan branch `feeds`, holding only feed files (plus a README), one commit per
release, written only by the release tool:

```
https://gt.plainskill.net/LibreLoom/LibreServ/raw/branch/feeds/<unit>/<channel>.json
                                                                   + .json.minisig
```

Channels: `stable`, `beta`. A stable release also updates the beta feed when
its version is newer than beta's current one (else beta users never leave
`-beta.N`).

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

`published` is UTC, exactly `YYYY-MM-DDTHH:MM:SSZ`, so plain string comparison
orders it (bash receivers rely on that). Every part has `os` ∈ {`linux`,
`windows`, `android`, `any`} and `arch` ∈ {`amd64`, `arm64`, `any`}. A part
may point at an earlier version's file when that part didn't change (the OS
image).

| Unit | Part | os | arch | File |
|---|---|---|---|---|
| `sol` | `sol` | linux | amd64, arm64 | `sol-linux-<arch>` |
| `sol-connect`, `luna-connect` | `server` | linux | amd64 | `<unit>-server-linux-amd64` |
| | `web` | any | any | `<unit>-web.tar.gz` |
| `luna` | `lunad` | linux | amd64 (musl) | `lunad-linux-amd64-musl` |
| | `os` | linux | amd64 | `luna-os-x86_64.img.xz` |
| | `installer` | linux | amd64 | `luna-rapidinstall-x86_64.iso.xz` |
| `luna-desktop` | `flatpak` | linux | amd64 | `luna-desktop-x86_64.flatpak` |
| | `windows` | windows | amd64 | `Luna-Desktop-Setup-x86_64.exe` |
| `luna-android` | `apk` | android | any | `luna-android.apk` |

Web bundle layout: `admin/` and `customer/` at the top for `sol-connect`; the
site files (`index.html` …) at the top for `luna-connect`
(`infra/connect-deploy` checks this). The beta Flatpak
(`luna-desktop-beta-x86_64.flatpak`) is listed only in the beta feed.

### Rules for every receiver

1. Verify the `.minisig` over the exact feed bytes with the pinned key before
   parsing. Signatures are minisign's prehashed `ED` form (the CLI default;
   in Go, `aead.dev/minisign` `Reader.Sign`); receivers may refuse legacy `Ed`.
2. `unit` and `channel` must match the request; unknown `format` → no update,
   plain message. Unknown JSON fields are ignored.
3. Never go backwards: reject a feed whose `published` is older than the newest
   seen (equal is fine). Receivers store the newest `published` **per unit +
   channel**. Never install a lower `version`; bad releases are fixed forward.
4. Pick the part whose `name` equals the request, whose `os` is the request's
   or `any`, and whose `arch` is the request's or `any`. Try `urls` in order;
   check `size` and `sha256` before using anything.
5. Compare versions as strict semver, including `-beta.N`. Same or lower than
   installed → no update.
6. In a package's `SHA256SUMS.txt`, match the file name field exactly, never as
   a substring.

## Keys

| Key | Signs | Lives |
|---|---|---|
| Sol minisign (`keys/sol.minisign.pub`) | `sol`, `sol-connect` feeds + sums | pscB |
| Luna minisign (`keys/lsluna.minisign.pub`) | `luna*` feeds + sums | pscB |
| Luna Desktop Flatpak GPG (`keys/luna-desktop-flatpak.gpg`) | Flatpak repo commits + summary | Generated on the Luna Connect server as the watcher's own user, readable only by it; backup + revocation cert in Proton Pass |

## Receiver notes

- **OS image:** the `os` part is installed when its `sha256` differs from
  `os-image.sha256` on the data partition (stream-decompress `.img.xz` onto
  the inactive slot, then store the hash). The factory installer and flasher
  must write `os-image.sha256` as the sha256 of the exact `.img.xz` the feed
  lists, or a fresh box offers a reflash on its first check.
- **`luna-run`** runs whichever of `/var/lib/luna/bin/lunad` and the baked lunad
  is newer (`lunad --version`).
- **Luna Desktop on Linux** has no in-app updater. CI builds a plain bundle
  (branch = channel, no `--repo-url`/`--gpg-keys`) that is only the Flatpak
  repo server's input (`infra/flatpak-repo/`); people install the bundle the
  server builds from its signed repo.
- **Connect servers** deploy from the signed feed (no building on the server);
  `--version X` goes through the package's signed sums, `--head` is for dev.
- **Sol** stamps `…/internal/api/handlers/system.Version`; Connect servers stamp
  `main.version`. Every build runs the binary and fails if it doesn't report
  the expected version (an unstamped Sol reports `dev` and never updates).

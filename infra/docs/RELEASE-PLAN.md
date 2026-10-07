# Release and update rework — plan

Status: receiving end built (Sol, lunad, Desktop, Android, Connect deploy,
Flatpak repo server); release tool designed (below), ready to build. Replaces `release.sh` and Forgejo
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
- Android `versionCode` is derived from the version; see release tool build
  order step 1.
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

## Release tool — design

One Go program, `./release`, replacing `release.sh`. **Podman is the only
dependency**: the launcher builds the tool in a pinned Go container (like
`./ci`), the tool runs on the host, and every build step runs in a container.
Everything runs **rootless** and that is not negotiable: when a step fights
it, work around the obstacle rather than falling back to sudo or rootful
podman. Speed matters equally (caches, parallel jobs, nothing rebuilt that
didn't change). Interactive TUI by default, plain CLI for scripts and agents.

### Outputs per release (unit + version)

1. Registry files `generic/<unit>/<version>/<file>`, one per part, names
   exactly as in the parts table (no version in the name).
2. `SHA256SUMS.txt` + `ED` `.minisig` in that package version.
3. `<unit>/<channel>.json` + `.minisig` on `feeds`. A stable release also
   updates the beta feed when its version is newer than beta's current one
  (else beta users never leave `-beta.N`); for
   `luna-desktop` that means a second bundle built for the `beta` branch,
   `luna-desktop-beta-x86_64.flatpak`, listed only in the beta feed.
4. `chore(release): <unit> <version>` commit bumping `VERSION` (+ the copies
   toolchains need), then tag `<unit>/vX.Y.Z` pushed to Forgejo.
5. Dev builds: the same layout in `dist/<unit>/<version>/`, optionally with a
   feed signed by the test key (`serve-dev`) so receivers update from a
   laptop.

Dev/HEAD builds are versioned `<next patch>-0.dev.<commits since tag>`
(e.g. `0.4.1-0.dev.12`): below every beta and release of that version, so a
dev box always takes the next real release. No `+build` metadata: the bash
receivers' semver check (`watch.sh`) rejects it; the commit is stamped
separately (`GitCommit`). Android dev builds keep the `versionCode` of the
last bump commit (debug APKs aren't published).

### Commands (all also reachable from the TUI)

```
./release                                  # TUI
./release build <unit>[:<part>…] [--head | --ref R] [--version V]
./release cut <unit> <V | patch | minor | major | beta> [--channel] [--dry-run]
./release verify <unit> <channel>          # feed sig, every URL, size, sha256
./release serve-dev                        # dist/ + test-key feed over http
./release secrets                          # secrets menu
./release doctor                           # podman, images, caches, secrets
./release images [--pull | --rebuild]
```

- `build` never needs a release secret and never publishes. `cut` = build +
  sign + publish.
- `cut` order (bots merge to `main` daily, and only the mirror may move
  commits to Forgejo):
  1. Preflight: secrets proven, clean tree, on `main`, tag free.
  2. Bump commit, pushed to origin **immediately** (fetch + rebase + retry if
     `main` moved; nothing is built yet). This SHA is the release.
  3. Build that exact SHA → sums + sign → upload → re-download and check
     hashes.
  4. Feed commit on `feeds` → push to origin (fetch + retry; only the tool
     writes there).
  5. Poll Forgejo until the mirror has both the bump SHA and the feed commit
     (raw feed URL serves the new `published`), then push the tag to Forgejo.
     Never push the tag earlier: it would carry the commit to Forgejo ahead of
     the mirror (dual-push race).
  Each step is idempotent and keyed by the bump SHA, so `cut --resume`
  continues a failed cut on the same commit.
- Release notes: edited in the TUI, or `--notes-file`; default draft from
  conventional commits since the unit's last tag, scoped to its paths.

### Containers

- One Containerfile per toolchain in `infra/release/images/`, base images
  pinned by digest: `go`, `node`, `rust-musl`, `rust-gtk` (desktop tests),
  `mingw-nsis`, `android`, `flatpak-builder`, `debian-live`, `alpine-os`.
  The tool tags them by content hash, so they rebuild only when they change.
- Caches as named podman volumes: cargo registry + git, per-target `target/`,
  Go modules + build cache, npm, gradle, flatpak-builder state + runtimes.
- Source: a writable per-build export of the chosen SHA (`git archive <sha> |
  tar x` into the cache dir), never a `git worktree` (npm in a worktree damages
  the main checkout) and never the checkout itself (Sol writes `OS/dist`,
  `OS/bin/restic`; Luna writes `os/dist`, `os/work`). `node_modules`,
  `target/`, and other build dirs are volumes. Outputs go to a per-part dir.
- Scripts that call podman themselves (`musl-link.sh` smoke tests,
  `make-image.sh`, `make-iso.sh`) can't run inside a job container: the
  engine runs those steps as their own jobs, and the scripts lose their podman
  calls.
- Parts form a graph (web → lunad → rootfs → OS image → installer; web
  shared by Sol arches) and run in parallel up to `--jobs` (default: CPU count,
  with memory-heavy jobs capped). Sol amd64/arm64 each get their own restic
  path.

### Rootless (no sudo anywhere)

- **ISO:** drop live-build. Build the live system with `mmdebstrap` (verified
  rootless in podman, bookworm minbase in ~15 s), `mksquashfs` it, and make a
  BIOS+UEFI hybrid ISO with `grub-mkrescue`/`xorriso`. This also replaces the
  `lb build` recovery path and the `add-uefi-boot.sh` remaster.
- **OS image:** `mkfs.ext4 -d` writes into a plain file; drop `--privileged`.
  The rootfs lives in a podman volume so file ownership stays correct inside
  the user namespace.
- **Flatpak:** flatpak-builder's bubblewrap needs nested user namespaces and a
  fresh `/proc`. Verified (podman 5.8, rootless): plain `podman run` fails
  (`devpts`/`proc` mount denied); `--security-opt seccomp=unconfined
  --security-opt label=disable --security-opt unmask=ALL` works, no
  `--privileged` needed. Use exactly those three options for the
  `flatpak-builder` job and nothing else.
- `.img.xz` is compressed once; the installer embeds those exact bytes and
  writes their hash as `os-image.sha256`.
- The OS image is rebuilt only when the rootfs inputs change (not lunad, which
  updates itself); otherwise the feed's `os`/`installer` parts point at the
  version that last built them.

### Secrets

Robust means **found and proven automatically**, not "configured with
fallbacks". Rules:

1. **Identify by contents, never by name or place.** A file is the Luna
   signing key only if its key ID matches `keys/lsluna.minisign.pub`; a token
   is the Forgejo token only if the forge accepts it with the right rights; a
   keystore only if it holds the pinned certificate. Swapped, renamed, or stale
   files are caught.
2. **Gather every candidate, test all, use the one that proves itself.** No
   "first wins". Two different valid candidates for one secret is a conflict
   the user resolves; rejected candidates stay visible with the reason.
3. **Discover.**
   - Signing keys: `~/.minisign/`, `$MINISIGN_CONFIG_DIR`,
     `~/.config/minisign/`, user-added files and folders, and a depth-capped
     home scan, recognising keys by their header (`untrusted comment: minisign
     … secret key`), not their file name.
   - Forgejo token: the `fj` CLI login
     (`$XDG_DATA_HOME/forgejo-cli/keys.json`, this host, `Application` type),
     `git credential fill` for the forge host (whatever helper is set up),
     `tea` config, `~/.netrc`, env (`FORGEJO_TOKEN`), keyring.
   - Android keystore: `~/.android/`, user-added files and folders, home scan
     for `.jks` / `.keystore` / `.p12`, env (`LUNA_ANDROID_KEYSTORE(_B64)`).
   - Env sources everywhere: `NAME`, `NAME_B64`, `NAME_FILE`, `NAME_CMD` (with
     timeout and one retry). Existing names keep working
     (`LSLUNA_RELEASE_MINISIG_PK/PW`, `LIBRESERV_RELEASE_MINISIG_PK/PW`).
   - Proton Pass: optional source, if its CLI reads items without a prompt
     (spike first).
4. **Pair keys and passwords automatically; remember what worked.** Our keys
   are scrypt-encrypted and a minisign key ID sits inside the encrypted part,
   so a file can't be identified without its password. The tool tries known
   passwords against candidate files (each try ~1 s, up to 1 GB RAM: run them
   one at a time), then caches non-secret facts — path, file hash, key ID — in
   `~/.cache/libreserv-release/`. Next run goes straight to the file, re-checks
   it every time, and searches again if it changed or moved.
5. **Ask only as a last resort, inline.** Passwords can't be discovered: they
   come from the keyring, Proton Pass, env, or an inline TUI prompt with
   "Remember in keyring". A missing secret is fixed on the preflight screen,
   not a failed run. Without a TTY, missing secrets fail preflight with the
   full candidate report.
6. **Prove, don't check presence.** Signing key: sign a test message and
   verify it against the public key in `keys/`. Forgejo token: `/api/v1/user`,
   push permission on the repo, and upload + delete a probe file in a scratch
   package. Keystore: opens, alias exists, certificate fingerprint matches.
   All in preflight, before any build.

**Storage** of pasted secrets: the system keyring (Secret Service: GNOME
Keyring / KWallet). Without one (SSH, cloud sessions): a passphrase-encrypted
file the tool owns. Library: `99designs/keyring` covers both.

**Never leaked:** resolved values are registered with an output filter that
redacts them from all logs and container output; they never enter a
container except the Android keystore (read-only mount, gradle job only);
signing happens in-process (`aead.dev/minisign` `Reader.Sign`, no CLI).

### TUI

Bubble Tea, reusing `infra/ci-source` styles and code; `./release` stays a
separate tool from `./ci`. Every screen has a CLI equivalent. Mockups (example
data):

```
 LibreServ release                                    main · fe58182 · clean
 ────────────────────────────────────────────────────────────────────────────
   Unit           Version   Since tag    Stable            Beta
 ▸ sol            0.9.2     14 commits   0.9.2       3d    0.9.3-beta.1  1d
   sol-connect    0.3.0      2 commits   0.3.0       9d    —
   luna           0.4.0     31 commits   0.4.0       5d    0.4.1-beta.2  2d
   …
   Secrets   5/6 ready · Android keystore not found            s to fix
   Podman    5.6 rootless · images 9/9 current · cache 38 GB
 ────────────────────────────────────────────────────────────────────────────
  b build  c cut  v verify  s secrets  d doctor  i images  ? help  q quit
```

```
 Build luna · HEAD fe58182 → 0.4.1-0.dev.31+fe58182                   03:12
 ────────────────────────────────────────────────────────────────────────────
   ✓ web           node          0:41   dist/                     4.1 MB
   ✓ lunad         rust-musl     1:58   lunad-linux-amd64-musl   27.8 MB
 ▸ ● rootfs        alpine-os     0:33   apk add  212/340
   ● live-system   debian-live   1:02   mmdebstrap: unpacking
   ◌ os-image      alpine-os            waits for rootfs
   ◌ installer     debian-live          waits for os-image, live-system
 ────────────────────────────────────────────────────────────────────────────
 rootfs
   (212/340) Installing chrony (4.7-r0)
 ────────────────────────────────────────────────────────────────────────────
  ↑↓ job  enter full log  x cancel job  X cancel all  esc back
```

```
 Cut luna 0.4.1         Version › Notes › Preflight › Run › Verify
 ────────────────────────────────────────────────────────────────────────────
   ✓ main, clean, up to date with origin
   ✓ tag luna/v0.4.1 free on Forgejo
   ✓ 0.4.1 is newer than stable 0.4.0 and beta 0.4.1-beta.2
   ✓ OS unchanged since 0.4.0 → os and installer reuse 0.4.0's files
   ✓ Forgejo token    from fj CLI · user plainskill · can push, can upload
 ▸ ? Luna signing key ~/.minisign/lsluna.key · needs its password
     Password  ••••••••••••     [x] Remember in keyring
 ────────────────────────────────────────────────────────────────────────────
  enter unlock  tab next  esc back
```

```
 Secrets                                                     r rescan all
 ────────────────────────────────────────────────────────────────────────────
   Secret              State      From                         Used by
 ▸ Sol signing key     ✓ ready    ~/.minisign/libreserv.key    sol, sol-connect
   Luna signing key    ✓ ready    ~/.minisign/lsluna.key       luna*
   Forgejo token       ✓ ready    fj CLI (plainskill)          every cut
   Android keystore    ✗ missing  searched 7 places            luna-android
 ────────────────────────────────────────────────────────────────────────────
  enter details  a add file  t test all  p sources  esc back
```

```
 Luna signing key                     must match keys/lsluna.minisign.pub
 ────────────────────────────────────────────────────────────────────────────
   ✓ ~/.minisign/lsluna.key         unlocked (keyring) · key ID matches   used
   ✗ ~/.minisign/libreserv.key      this is the Sol signing key
   ✗ ~/backup/old-luna.key          key ID 4C1F… matches no public key
   · LSLUNA_RELEASE_MINISIG_PK      not set
   · Proton Pass                    not set up
 ────────────────────────────────────────────────────────────────────────────
   Checked 2026-10-06 21:14 · signs and verifies against the public key
  a add file  d add folder to search  P change password  f forget  esc
```

### ISO rewrite (approved)

Replace live-build (`os/make-iso.sh`, `os/iso/build-debian-live.sh`,
`add-uefi-boot.sh`, `Containerfile.live-build`) with a rootless build that
keeps the boot contract:

- `mmdebstrap` bookworm, `main contrib non-free non-free-firmware`, no
  recommends, `linux-image-amd64` + the packages in
  `package-lists/live.list.chroot` and `luna.list.chroot` (unchanged: the
  live system installs GRUB onto the target, so its grub packages stay) +
  `xz-utils`; copy `includes.chroot`; run `0100-luna-installer.hook.chroot`.
- Dropped on purpose: `luna.list.binary` (syslinux-utils, genisoimage) and
  `0110-isolinux-paths.hook.chroot` only served live-build's bootloader
  stage.
- `mksquashfs` → `live/filesystem.squashfs`; kernel + initrd → `live/`; the
  Luna payload (staged as `stage-debian-live.sh` does today) at `/luna/`.
- **Payload change:** the ISO carries the released `luna-os-x86_64.img.xz`
  (exact bytes the feed lists), not the raw `.img` and not the rootfs
  tarball. `rapidinstall.sh` / `flash-disk.sh` stream `xz -dc` onto both
  slots and write `os-image.sha256` = sha256 of that `.img.xz` (staged beside
  it as `luna-os-x86_64.img.xz.sha256`). The tarball install path is removed.
  EuroOffice and draw.io packs unchanged. Update `flash-disk_test.sh`,
  `factory-assets_test.sh`, `rootfs_test.sh` accordingly.
- `grub-mkrescue` (BIOS + UEFI hybrid), volume ID `LUNAINST`, kernel line
  `boot=live text nomodeset console=tty0 net.ifnames=0 biosdevname=0
  init=/usr/lib/luna-installer/init.sh` (what `find-media.sh` and the
  installer rely on today).
- Must pass the existing ISO tests and a boot on real hardware (user) in both
  BIOS and UEFI before `release.sh` is retired.

## Release tool — build order

Code: `infra/ci-source/cmd/release` + `internal/release/…` (same module as
`./ci`, to reuse `internal/feed`, the container client, and TUI styles);
launcher `./release` at the repo root. Each step lands tested and committed.

0. **Spikes** (answers change how, never whether, a step is rootless):
   flatpak-builder inside rootless podman (done, see Rootless); Proton Pass CLI non-interactive read; Forgejo generic package
   upload/delete probe and slash tags (`luna/v0.4.0`) on Forgejo and F-Droid.
1. **Versions in the repo:** create `sol/VERSION`, `sol/connect/VERSION`,
   `luna/mobile/VERSION` (starts at its current `0.1.6`),
   `luna/connect/VERSION`.
   - Sol stamps `gt.plainskill.net/LibreLoom/LibreServ/internal/api/handlers/system.Version`
     (`release.sh` targets `…/handlers.Version`, which doesn't exist; Go
     ignores `-X` on a missing symbol, so today's binaries report `dev`).
     Connect servers stamp `main.version`. Every build then runs the binary
     (`--version` or the health handler) and fails if it doesn't report the
     expected version.
   - Android: the bump commit writes literal `versionName` and `versionCode`
     into `app/build.gradle.kts` (F-Droid's checkupdates reads literals at the
     tag). `versionCode = (major*10000 + minor*100 + patch) * 100 + n`, `n` =
     beta number (1–98) or 99 for a final, so betas sort below their release
     and every code is above today's 7.
   - `luna-desktop` bump also adds a `<release version date>` entry to the
     metainfo.
   - The Windows installer stamps only `PRODUCT_VERSION` /
     `DisplayVersion` (no `VIProductVersion`), so pre-release strings are
     fine.
2. **Engine:** toolchain images, rootless runner (named-volume caches, `git
   archive` export of the SHA, per-part output dirs), job graph with `--jobs` and
   memory caps, log streaming, redaction hook, dev version scheme.
3. **Parts:** every part in the parts table as a containerised builder,
   ported from `release.sh`, the Makefiles and `luna/os`; Sol arches with
   separate restic paths; web bundle layouts for Connect; desktop bundle per
   channel (branch = channel, no repo URL/keys); Windows installer; APK.
   `./release build` works end to end into `dist/`.
4. **Rootless OS:** `make-image.sh` without `--privileged`, rootfs in a
   volume, ISO rewrite, `.img.xz` compressed once and embedded with its hash as
   `os-image.sha256`, OS input hash for reuse.
5. **Secrets:** discovery, proving, pairing cache, keyring / encrypted file,
   `./release secrets` (CLI).
6. **Publish:** sums + sign, upload, re-download check, feed commit on
   `feeds` (stable also writes beta), tag, push, mirror poll, `--resume`;
   `verify`, `serve-dev`. Tested against a fake registry (httptest) and a temp
   git remote; optional preflight step runs `./ci` for the unit's profile.
7. **TUI:** all screens above.
8. **Cut over:** first real cuts on `beta` per unit; F-Droid metadata
   (`luna/mobile/fdroid/net.plainskill.luna.yml`: `UpdateCheckMode: Tags
   ^luna-android/v.*`, `Changelog:` off Forgejo Releases); delete
   `release.sh` and `RELEASE.md`, update `AGENTS.md` layout and agent docs.

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

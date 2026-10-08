# ./release — the release tool

One Go program. **Podman is the only host dependency**: the root `./release`
launcher builds the tool in a pinned Go container, the tool runs on the host,
and every build step runs in a container. Everything is **rootless**; when a
step fights that, work around it rather than using sudo or rootful podman.
Interactive TUI by default, plain CLI for scripts and agents.

Units, versions, tags, feed format and receiver rules:
`internal/feed/README.md`.

## Commands

```
./release                                  # TUI
./release build <unit>[:<part>…] [--head | --ref R] [--version V]
./release cut <unit> --channel beta|stable [--bump patch|minor|major|beta | --version V] [--resume] [--rebuild] [--dry-run]
./release verify <unit> <channel>          # feed sig, every URL, size, sha256
./release serve-dev                        # dist/ + test-key feed over http
./release secrets                          # secrets menu
./release doctor                           # podman, images, caches, secrets
./release images [--pull | --rebuild]
```

`build` never needs a release secret and never publishes. `cut` = build + sign
+ publish. Release notes: edited in the TUI, or `--notes-file`; the default
draft is conventional commits since the unit's last tag, scoped to its paths.

## Outputs per release

1. Registry files `generic/<unit>/<version>/<file>`, one per part.
2. `SHA256SUMS.txt` + `ED` `.minisig` in that package version.
3. `<unit>/<channel>.json` + `.minisig` on the `feeds` branch.
4. `chore(release): <unit> <version>` commit bumping `VERSION` (+ the copies
   toolchains need), then tag `<unit>/vX.Y.Z` pushed to Forgejo.

Dev builds produce the same layout in `dist/<unit>/<version>/`, optionally
with a feed signed by the test key (`serve-dev`) so receivers can update from a
laptop.

## Cut order

Bots merge to `main` daily, and only the mirror may move commits to Forgejo:

1. Preflight: secrets proven, clean tree, on `main`, tag free.
2. Bump commit, pushed to origin **immediately** (fetch + rebase + retry if
   `main` moved; nothing is built yet). This SHA is the release.
3. Build that exact SHA → sums + sign → upload → re-download and check hashes.
4. Feed commit on `feeds` → push to origin (fetch + retry).
5. Poll Forgejo until the mirror has both the bump SHA and the feed commit,
   then push the tag to Forgejo. Never push the tag earlier: it would carry the
   commit to Forgejo ahead of the mirror (dual-push race).

Each step is idempotent and keyed by the bump SHA, so `cut --resume` continues
a failed cut on the same commit.

## Containers

- One Containerfile per toolchain in `infra/release/images/`, base images
  pinned by digest. The tool tags images by content hash, so they rebuild only
  when they change.
- Caches are named podman volumes: cargo, per-target `target/`, Go, npm,
  gradle, flatpak-builder. `LIBRESERV_RELEASE_VOLUME_PREFIX` selects a separate
  set.
- Source is a writable per-build export of the chosen SHA (`git archive`),
  never a `git worktree` (npm in a worktree damages the main checkout) and
  never the checkout itself.
- Scripts that call podman themselves can't run inside a job container; the
  engine runs those steps as their own jobs.
- Parts form a graph (web → lunad → rootfs → OS image → installer) and run in
  parallel up to `--jobs`, with memory-heavy jobs capped.

## Rootless notes

- **ISO:** `mmdebstrap` → `mksquashfs` → `grub-mkrescue` (BIOS + UEFI hybrid,
  volume ID `LUNAINST`, kernel line `boot=live text nomodeset console=tty0
  net.ifnames=0 biosdevname=0 init=/usr/lib/luna-installer/init.sh`, which
  `find-media.sh` and the installer rely on). The ISO carries the released
  `luna-os-x86_64.img.xz` (exact bytes the feed lists); `rapidinstall.sh` /
  `flash-disk.sh` stream `xz -dc` onto both slots and write `os-image.sha256`.
- **OS image:** `mkfs.ext4 -d` into a plain file; the rootfs lives in a podman
  volume so ownership stays correct. `.img.xz` is compressed once. It is rebuilt
  only when the rootfs inputs change (lunad updates itself); otherwise the
  feed's `os`/`installer` parts point at the version that last built them.
- **Flatpak:** flatpak-builder's bubblewrap needs nested user namespaces. Run
  with `--security-opt seccomp=unconfined --security-opt label=disable
  --security-opt unmask=ALL`, plus `--cap-add SYS_ADMIN --cap-add NET_ADMIN` for
  the export step (the caps live in the container's user namespace only). The
  options are in `infra/release/images/flatpak-builder/run-options`.

## Secrets

Found and proven automatically, not "configured with fallbacks":

1. **Identify by contents, never by name or place.** A file is the Luna signing
   key only if its key ID matches `keys/lsluna.minisign.pub`; a token is the
   Forgejo token only if the forge accepts it with the right rights; a keystore
   only if it holds the pinned certificate.
2. **Gather every candidate, test all, use the one that proves itself.** Two
   different valid candidates for one secret is a conflict the user resolves;
   rejected candidates stay visible with the reason.
3. **Discover.** Signing keys: `~/.minisign/`, `$MINISIGN_CONFIG_DIR`,
   `~/.config/minisign/`, user-added paths, depth-capped home scan (recognised
   by header, not file name). Forgejo token: `fj` login, `git credential fill`,
   `tea`, `~/.netrc`, `FORGEJO_TOKEN`, keyring. Android keystore: `~/.android/`,
   user-added paths, home scan for `.jks`/`.keystore`/`.p12`,
   `LUNA_ANDROID_KEYSTORE(_B64)`. Env sources accept `NAME`, `NAME_B64`,
   `NAME_FILE`, `NAME_CMD`; `LSLUNA_RELEASE_MINISIG_PK/PW`,
   `SOL_RELEASE_MINISIG_PK/PW` and `MINISIGN_SECRET_KEY` keep working. Proton
   Pass is an optional source (`pass-cli item view "pass://<vault>/<item>/<field>"`;
   needs a logged-in session, no TTY).
4. **Pair keys and passwords automatically; remember what worked.** Keys are
   scrypt-encrypted, so the tool tries known passwords against candidates (one
   at a time, ~1 s and up to 1 GB RAM each) and caches non-secret facts (path,
   file hash, key ID) in `~/.cache/libreserv-release/`.
5. **Ask only as a last resort, inline**, with "Remember in keyring". Without a
   TTY, missing secrets fail preflight with the full candidate report.
6. **Prove, don't check presence.** Signing key: sign and verify against the
   public key in `keys/`. Forgejo token: `/api/v1/user`, push permission, and
   upload + delete a probe file. Keystore: opens, alias exists, fingerprint
   matches. All in preflight, before any build.

Pasted secrets are stored in the system keyring, or a passphrase-encrypted file
the tool owns when there is none (`99designs/keyring`). Resolved values are
redacted from all logs and container output; they never enter a container
except the Android keystore (read-only mount, gradle job only). Signing happens
in-process.

## Forgejo registry facts

- `PUT /api/packages/LibreLoom/generic/<name>/<version>/<file>` → 201; the same
  file again → 409, so re-publishing means delete then upload. A path needs
  exactly name/version/file. Downloads are public.
- `DELETE` on a file or on `…/<name>/<version>` → 204.
- Uploads up to 2.2 GB work through Caddy.
- F-Droid `checkupdates` matches `Tags <regex>` against the plain tag name,
  anchored at the start; only the newest 5 matching tags are checked, and
  versionName/versionCode come from Gradle at the tag.

## Test fixtures

`infra/feed-testdata/` holds signed feeds, payloads and `cases.json` that every
receiver tests against. They use a TEST-ONLY key that must never go in `keys/`.
Regenerate: `cd infra/ci-source && go run ./cmd/feedgen`.

# Release Process Guide

## Overview

LibreServ, Luna, and Connect share one Forgejo repo (`LibreLoom/LibreServ`) and
**must not share tags**. LibreServ and Luna share **one release ritual**
(`./release.sh`) with product-specific CI profiles, assets, and **separate
minisign signing keys**.

Connect ships under `connect-v*` via its own deploy scripts and is out of scope
for this document’s signing model.

## One pipeline, two products

| | LibreServ | Luna |
|---|-----------|------|
| Command | `./release.sh` | `./release.sh --luna` |
| Tag / title | `vMAJOR.MINOR.PATCH` e.g. `v0.0.13` | `luna-vMAJOR.MINOR.PATCH` e.g. `luna-v0.0.13` |
| Default CI | `./ci run -profile libreserv` | `./ci run -profile luna` |
| Assets | `libreserv-linux-amd64`, `libreserv-linux-arm64`, `SHA256SUMS.txt`, `SHA256SUMS.txt.minisig` | `lunad-linux-amd64`, optional `lunad-linux-arm64`, OS cut: `luna-os-x86_64.img` + `luna-rapidinstall-x86_64.iso`, `luna-desktop-x86_64.flatpak`, `Luna-Desktop-Setup-*-x86_64.exe`, `luna-android.apk`, `SHA256SUMS.txt`, `SHA256SUMS.txt.minisig` |
| Public key | [`keys/libreserv.minisign.pub`](../keys/libreserv.minisign.pub) | [`keys/lsluna.minisign.pub`](../keys/lsluna.minisign.pub) |
| Secret env | `LIBRESERV_RELEASE_MINISIG_PK` + `_PW` | `LSLUNA_RELEASE_MINISIG_PK` + `_PW` |
| Local secret | `~/.minisign/libreserv.key` | `~/.minisign/lsluna.key` |
| Consumers | `install.sh`, in-app updater | lunad OTA (Settings → Software updates) |

The Forgejo **tag** and **release title** are the same string. Never prefix
titles with "Release" or "Luna".

`SHA256SUMS.txt` uses GNU `sha256sum` lines: `<hash><two spaces><filename>`.
`release.sh` signs that file with minisign (`SHA256SUMS.txt.minisig`) using the
**product** secret, then verifies against the product public key and **refuses
to publish unsigned checksums**.

See [`keys/README.md`](../keys/README.md) for key ownership (Luna =
`7AA9417DBF891F5E`, LibreServ = `48EB64CB69EA36CD`), Cursor secret names, and
how to recreate a public file from a password-protected secret.

### Luna daemon cut vs OS cut

- **Daemon cut** — ship `lunad-linux-*` (+ checksums). No `luna-os-*`, no ISO.
  Boxes install the binary under `/var/lib/luna/bin/`.
- **OS cut** — ship `lunad-linux-*`, `luna-os-x86_64.img` (raw A/B slot image),
  and `luna-rapidinstall-x86_64.iso`. Boxes detect OS need when the release image
  SHA256 differs from `/var/lib/luna/os-image.sha256` and apply it automatically
  inside the same Install update (inactive slot + reboot). Factory flash records
  that hash on `LUNA_DATA`.

Today `./release.sh --luna` always performs an OS cut.

## Happy paths

```bash
# LibreServ v* cut (CI profile: libreserv)
./release.sh --yes --version v0.0.13 --publish

# Luna luna-v* cut (CI profile: luna)
./release.sh --yes --version v0.0.13 --luna --publish

# Sign recovery on an existing release (no rebuild)
./release.sh --yes --sign-only --version v0.0.13
./release.sh --yes --sign-only --version luna-v0.0.19

# Monorepo gate instead of the product profile
./release.sh --yes --version v0.0.13 --ci-profile full --publish

# Build only, skip Forgejo
./release.sh --dry-run --skip-ci --version v0.0.13
```

Other flags: `--force`, `--pre-release`, `--keep-build`, `--notes-file`,
`--skip-ci`, `--with-iso` (implied by `--luna`).

Do not attach Luna files to a `v*` release or LibreServ binaries to a `luna-v*`
release. LibreServ `install.sh` and the in-app updater only consume **`v*`**
tags. Luna's updater only consumes **stable `luna-v*`** tags.

## Prerequisites

- Git repository on `main` with no uncommitted changes
- Forgejo account with write access to `LibreLoom/LibreServ`
- Go 1.26+ and Node.js 20+ (LibreServ cuts)
- Podman (CI; also required for Luna ISO builds)
- `minisign` in PATH, and the **product** secret that matches the committed pub
  (see [`keys/README.md`](../keys/README.md))
- `FORGEJO_TOKEN` for non-interactive cuts

## Release script flow

1. **Forgejo Token** — `write:repository` and `write:release` scopes
2. **Version Tag** — `vX.Y.Z` (script rewrites to `luna-vX.Y.Z` with `--luna`)
3. **Git Validation** — clean tree; prefer `main`
4. **CI Suite** — product profile (`libreserv` or `luna`), unless `--skip-ci` or
   `--ci-profile` override
5. **Build Assets** — product-specific binaries / ISO
6. **Checksums + sign** — `SHA256SUMS.txt` + `.minisig`
7. **Release Notes** — editor or auto-generated with `--yes`
8. **Draft + upload** — Forgejo draft, then assets (streaming for large ISO/img)
9. **Publish** — optional (`--publish` / prompt)

### Existing tags

If a release with the same tag already exists, the script offers delete &
recreate / different tag / cancel. Use `--force` to delete without prompting.

**Pre-releases:** `--pre-release` marks unstable. Installers and updaters skip
pre-releases unless explicitly requested (Luna skips drafts and prereleases).

### Verify release

After creation, verify:

- [ ] Tag equals the release title (`v0.0.13` or `luna-v0.0.13`)
- [ ] LibreServ `v*`: `libreserv-linux-amd64`, `libreserv-linux-arm64`,
      `SHA256SUMS.txt`, `SHA256SUMS.txt.minisig` only
- [ ] Luna `luna-v*`: `lunad-linux-*`, `luna-os-x86_64.img` + ISO when shipping
      OS, `luna-desktop-x86_64.flatpak`, `Luna-Desktop-Setup-*-x86_64.exe`,
      `luna-android.apk`, `SHA256SUMS.txt`, `SHA256SUMS.txt.minisig`
- [ ] `minisign -Vm SHA256SUMS.txt -p keys/<product>.minisign.pub` succeeds
- [ ] Release notes are formatted correctly

## Manual token creation

1. Go to `https://gt.plainskill.net/user/settings/applications`
2. Generate New Token with **repository** Read and Write, **user** Read
3. Copy the token immediately

## Binary format (LibreServ)

- `libreserv-linux-amd64` / `libreserv-linux-arm64`
- Embedded frontend (`embedfront`) and restic (`embedrestic`)
- Version / commit / build time via ldflags

Users install via:

```bash
curl -fsSL https://gt.plainskill.net/libreloom/libreserv/raw/branch/main/install.sh | sudo sh
```

Prefer a copy of `install.sh` you already trust, or clone the repo — the first
hop still trusts Forgejo for the script itself.

## Release notes template

```markdown
## What's Changed

## New Features

## Bug Fixes

## Breaking Changes

## Upgrade Notes

## Commits Since Last Release
```

Highlight breaking changes, include migration steps when needed, keep it
user-focused.

### Luna upgrade notes (keep in sync with `luna/os/README.md`)

The rapidinstall installer **does not** ask you to type `install luna`. It
auto-picks the smallest built-in (non-USB) disk and starts after a short
countdown; press any key during the countdown to choose a different disk.

Use this wording in Luna release **Upgrade Notes**:

```markdown
## Upgrade Notes

**Already running Luna:** Settings → Software updates → Install update. Luna applies
the new `lunad` binary and, when this release includes a newer OS slot image, writes
it to the inactive slot and reboots.

**Factory install or recovery USB:** Write `luna-rapidinstall-x86_64.iso` to a USB
stick, boot the PC from it (BIOS or UEFI; turn Secure Boot off). Luna picks the
smallest built-in disk and starts installing after a short countdown — press any key
during the countdown to choose a different disk.
```

`./release.sh --yes --luna` embeds the same text in its auto-generated notes. If
the installer flow changes, update **both** `luna/os/README.md` and the
`Upgrade Notes` block in `release.sh`.

## Draft vs published

Releases are created as **drafts** first. Publish from the Forgejo UI or with
`--publish`.

## Rollback

1. Delete the release on Forgejo (or mark draft)
2. Delete the tag: `git tag -d v1.0.0 && git push origin :refs/tags/v1.0.0`
3. Fix on `main`
4. Cut a new patch version

## Version numbering

Semantic versioning: `vMAJOR.MINOR.PATCH` (Luna: `luna-vMAJOR.MINOR.PATCH`).

Pre-release: `v1.0.0-beta.1`, `v1.0.0-rc.1`.

## Re-running the script

Safe to re-run: rebuilds `release-build/`, cleans frontend dist before build,
checks for existing tags, cleans temp files unless `--keep-build` / `--dry-run`.

## What gets created / cleaned

| Path | Created by | Cleaned when |
|------|------------|--------------|
| `release-build/` | Script | Always on exit (unless `--keep-build` / `--dry-run`) |
| `server/backend/OS/dist/` | Script (frontend) | Never |
| `server/backend/bin/` | Not by script | Never |
| Temp release notes | Script | Immediately after use |
| Draft release on Forgejo | Script | Never — delete manually if needed |

## Troubleshooting

### CI fails

Fix failing tests before releasing. Override with `--ci-profile full` only when
you intentionally want the monorepo gate.

### Token validation fails

Check scopes, Forgejo URL, and network.

### Build fails

- `cd server/backend && go mod download`
- `cd server/frontend && npm install`
- Podman running (CI / Luna ISO)

### Asset upload fails

Token expiry, Forgejo reachability, or file size limits. Large Luna ISO/img
uploads use the streaming path in `release.sh`.

### Signature does not match product pub

Wrong secret for the product (LibreServ vs Luna). Confirm env vars and
`keys/<product>.minisign.pub`. See [`keys/README.md`](../keys/README.md).

## Post-release

1. Update docs / README if needed
2. Announce
3. Watch issues for 24–48 hours
4. Check off items in [GOALS.md](../GOALS.md)

## Security

- **Checksums** — `SHA256SUMS.txt` required (GNU `sha256sum` lines).
- **Separate signatures** — each product verifies against its own committed pub.
  A compromised Forgejo token cannot ship a matching binary + checksum pair
  without the product secret.
- **First hop** — boxes still running unsigned code can apply one last unsigned
  update (the build that adds verification). Every hop after that must verify.
- **Supply chain** — binaries are built from source on your machine. Review
  before you sign.

```bash
minisign -Vm SHA256SUMS.txt -p keys/libreserv.minisign.pub
minisign -Vm SHA256SUMS.txt -p keys/lsluna.minisign.pub
```

## Automation (future)

Currently manual by design. Future work may include automated changelogs and
Forgejo Actions. The local ritual stays the source of truth.

---

**Questions?** Open an issue on Forgejo or contact the maintainers.

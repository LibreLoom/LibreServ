# Release Process Guide

## Overview

LibreServ, Luna, and Connect share one Forgejo repo (`LibreLoom/LibreServ`) and **must not share tags**.

## Tag, title, and asset conventions

The Forgejo **tag** and **release title** are the same string. Never prefix titles with "Release" or "Luna".

| Product | Tag / title | Stable? | Assets (only these) |
|---------|-------------|---------|---------------------|
| LibreServ | `vMAJOR.MINOR.PATCH` e.g. `v0.0.13` | yes (unless `--pre-release`) | `libreserv-linux-amd64`, `libreserv-linux-arm64`, `SHA256SUMS.txt`, `SHA256SUMS.txt.minisig` |
| Luna | `luna-vMAJOR.MINOR.PATCH` e.g. `luna-v0.0.13` | yes (updater skips prereleases) | `lunad-linux-amd64`, `lunad-linux-arm64` when built, `luna-rapidinstall-x86_64.iso` when this is an OS cut, `SHA256SUMS.txt`, `SHA256SUMS.txt.minisig` |
| Connect | `connect-vMAJOR.MINOR.PATCH` | separate module | Connect's own binaries |

`SHA256SUMS.txt` uses GNU `sha256sum` lines: `<hash><two spaces><filename>`. `release.sh` signs that file with minisign (`SHA256SUMS.txt.minisig`). The public key is [`keys/releases.minisign.pub`](../keys/releases.minisign.pub), baked into lunad, LibreServ, and `install.sh`.

The secret key stays off-repo. `release.sh` uses `MINISIGN_SECRET_KEY` if set, otherwise `~/.minisign/libreserv.key`. After signing it verifies against the committed public key and **refuses to publish unsigned checksums**.

See [`keys/README.md`](../keys/README.md) for key locations and how to recreate the public file from a password-protected secret.

LibreServ `install.sh` and the in-app updater only consume **`v*`** tags. Luna's updater only consumes **stable `luna-v*`** tags. Mixing assets across those tags breaks both.

## Creating a Release

Use `./release.sh`. Do not attach Luna files to a `v*` release or LibreServ binaries to a `luna-v*` release.

```bash
./release.sh              # Interactive LibreServ v* cut
./release.sh --dry-run    # Build binaries only, skip Forgejo API calls (keeps build dir)
./release.sh --keep-build # Keep release-build/ directory after completion
./release.sh --force      # Auto-delete existing release with same tag (no prompt)
./release.sh --pre-release # Mark as pre-release (install.sh and updaters skip these)
./release.sh --yes --version v0.0.13 --publish
# → tag + title v0.0.13, LibreServ linux amd64/arm64 + SHA256SUMS.txt + SHA256SUMS.txt.minisig
./release.sh --yes --version v0.0.13 --luna --publish
# → tag + title luna-v0.0.13, lunad + ISO + SHA256SUMS.txt + SHA256SUMS.txt.minisig
```

## Prerequisites

- Git repository on `main` branch with no uncommitted changes
- Forgejo account with write access to `LibreLoom/LibreServ`
- Go 1.26+ installed locally
- Node.js 20+ installed locally (for frontend build)
- Podman installed (for CI tests)
- `minisign` in PATH, and the secret key that matches [`keys/releases.minisign.pub`](../keys/releases.minisign.pub) (see [`keys/README.md`](../keys/README.md))

## Release script details

### 1. Existing tags

If a release with the same tag already exists, the script will:
1. Show the existing release URL
2. Prompt you to: delete & recreate / use different tag / cancel
3. Use `--force` to skip the prompt and always delete the old release

**Pre-releases:**
- Use `--pre-release` flag to mark as unstable, or answer "y" when prompted
- Pre-releases (beta, rc, alpha) won't be offered as the "latest" stable release
- Install script will skip pre-releases unless explicitly requested

### 2. Follow the Prompts

The script will guide you through:

1. **Forgejo Token** - Enter your API token (requires `write:repository` and `write:release` scopes)
2. **Version Tag** - Enter semantic version (e.g., `v1.0.0`, `v1.0.0-beta.1`)
3. **Git Validation** - Automatically checks for uncommitted changes
4. **CI Suite** - Runs full test profile (takes 5-15 minutes)
5. **Build Binaries** - Compiles Linux AMD64 and ARM64 binaries
6. **Release Notes** - Opens your editor to write changelog
7. **Create Draft** - Creates draft release on Forgejo
8. **Upload Assets** - Uploads binaries and checksums
9. **Publish** - Option to publish immediately or keep as draft

### 3. Verify Release

After creation, verify:
- [ ] Tag equals the release title (`v0.0.13` or `luna-v0.0.13`)
- [ ] LibreServ `v*`: `libreserv-linux-amd64`, `libreserv-linux-arm64`, `SHA256SUMS.txt`, `SHA256SUMS.txt.minisig` only
- [ ] Luna `luna-v*`: `lunad-linux-*`, ISO when shipping OS, `SHA256SUMS.txt`, `SHA256SUMS.txt.minisig` only
- [ ] Release notes are formatted correctly

## Manual Token Creation

To create a Forgejo API token:

1. Go to `https://gt.plainskill.net/user/settings/applications`
2. Click "Generate New Token"
3. Name: anything you want (e.g., `release-script`, `libreserv-releases`)
4. Select scopes:
   - **repository**: `Read and Write` - Required for creating releases and uploading assets
   - **user**: `Read` - Required for token validation
5. Click "Generate Token"
6. **Copy the token immediately** - it won't be shown again

## Binary Format

The release script builds binaries with these names:
- `libreserv-linux-amd64` - For x86_64 systems
- `libreserv-linux-arm64` - For ARM64 systems (Raspberry Pi 4+, etc.)

Binaries include:
- Embedded frontend (no separate deployment needed)
- Version info injected at build time
- Git commit hash for traceability

Users download via `install.sh`:
```bash
curl -fsSL https://gt.plainskill.net/libreloom/libreserv/raw/branch/main/install.sh | sudo sh
```

The install script fetches the latest release automatically.

## Release Notes Template

The script provides a template with these sections:

```markdown
## What's Changed

## New Features

## Bug Fixes

## Breaking Changes

## Upgrade Notes

## Commits Since Last Release
```

**Best practices:**
- Highlight breaking changes prominently
- Include migration steps if needed
- Thank contributors by name
- Keep it user-focused (what changed for them, not technical details)

## Draft vs Published

Releases are created as **drafts** first. This allows you to:
- Review all assets before publishing
- Fix any issues with release notes
- Test the install process with the draft release

To publish a draft:
1. Go to the release page on Forgejo
2. Click "Edit"
3. Uncheck "Draft"
4. Click "Publish Release"

## Rollback Procedure

If a release has issues:

1. **Delete the release** from Forgejo (or mark as draft)
2. **Delete the tag**: `git tag -d v1.0.0 && git push origin :refs/tags/v1.0.0`
3. **Fix the issues** in main branch
4. **Create new release** with incremented patch version

## Version Numbering

LibreServ uses semantic versioning: `vMAJOR.MINOR.PATCH`

- **MAJOR** - Breaking changes, incompatible API
- **MINOR** - New features, backward compatible
- **PATCH** - Bug fixes, backward compatible

Pre-release versions: `v1.0.0-beta.1`, `v1.0.0-rc.1`

## Re-running the Script

**Yes, it's safe to re-run!** The script:

- ✅ Deletes and recreates `release-build/` each run
- ✅ Cleans `server/backend/OS/dist/` before frontend build (no permission issues)
- ✅ Checks if release tag already exists (prevents duplicates)
- ✅ Cleans up temp files on exit (unless `--keep-build` or `--dry-run`)
- ✅ Handles Ctrl+C gracefully (cleanup runs on interrupt)
- ✅ Cleans stale `release-build/` from previous failed runs

**If script fails mid-way:** Just re-run it. The script will offer to clean up the stale build directory automatically.

## What Gets Created/Cleaned

| Path | Created By | Cleaned When |
|------|------------|--------------|
| `release-build/` | Script (binaries) | Always on exit/error (unless `--keep-build`/`--dry-run`) |
| `server/backend/OS/dist/` | Script (frontend) | **Never** - valid build output |
| `server/backend/bin/` | Not created by script | **Never** - user's local builds |
| Temp files (release notes) | Script (editor) | Immediately after use |
| Draft release on Forgejo | Script (API) | **Never** - manual delete if needed |

## Troubleshooting

### CI Suite Fails

Fix the failing tests before proceeding. The script will not allow creating a release with failing tests.

### Token Validation Fails

- Ensure token has correct scopes
- Check Forgejo instance URL is correct
- Verify network connectivity to Forgejo

### Build Fails

Common causes:
- Missing Go dependencies: `cd server/backend && go mod download`
- Missing Node dependencies: `cd server/frontend && npm install`
- Podman not running (required for some tests)

### Asset Upload Fails

- Check token hasn't expired
- Verify Forgejo instance is accessible
- Ensure file sizes are within Forgejo limits (default 50MB)

## Post-Release Tasks

After publishing:

1. **Update documentation** - Changelog, README if needed
2. **Announce release** - Community channels, social media
3. **Monitor issues** - Watch for bug reports in first 24-48 hours
4. **Update goals** - Check off completed items in [GOALS.md](../GOALS.md)

## Security Considerations

- **Checksums** — `SHA256SUMS.txt` is required. GNU `sha256sum` lines.
- **Signatures** — `SHA256SUMS.txt.minisig` is required. minisign, public key pinned in the updaters and `install.sh`. A compromised Forgejo token cannot ship a matching binary + checksum pair.
- **First hop** — boxes still running unsigned code can apply one last unsigned update (the build that adds verification). Every hop after that must verify. `curl | sudo sh` of `install.sh` still trusts Forgejo for **the script itself**; use a copy of `install.sh` you already trust, or clone the repo.
- **Supply chain** — binaries are built from source on your machine. Review code before you sign.

## Verify an ISO or checksums file

```bash
minisign -Vm SHA256SUMS.txt -p keys/releases.minisign.pub
```

## Automation (Future)

Currently manual by design. Future automation may include:
- Automated changelog generation
- GitHub Actions / Forgejo Actions workflow
- Automatic ISO building for appliance releases (`./release.sh --with-iso`)

---

**Questions?** Open an issue on Forgejo or contact the maintainers.

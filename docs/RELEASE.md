# Release Process Guide

## Overview

LibreServ releases are created manually using the `./release.sh` script. This ensures quality control and allows for careful review before publishing.

## Prerequisites

- Git repository on `main` branch with no uncommitted changes
- Gitea account with write access to `LibreLoom/LibreServ`
- Go 1.25+ installed locally
- Node.js 20+ installed locally (for frontend build)
- Docker installed (for CI tests)

## Creating a Release

### 1. Run the Release Script

```bash
./release.sh              # Full release process
./release.sh --dry-run    # Build binaries only, skip Gitea API calls (keeps build dir)
./release.sh --keep-build # Keep release-build/ directory after completion
```

### 2. Follow the Prompts

The script will guide you through:

1. **Gitea Token** - Enter your API token (requires `write:repository` and `write:release` scopes)
2. **Version Tag** - Enter semantic version (e.g., `v1.0.0`, `v1.0.0-beta.1`)
3. **Git Validation** - Automatically checks for uncommitted changes
4. **CI Suite** - Runs full test profile (takes 5-15 minutes)
5. **Build Binaries** - Compiles Linux AMD64 and ARM64 binaries
6. **Release Notes** - Opens your editor to write changelog
7. **Create Draft** - Creates draft release on Gitea
8. **Upload Assets** - Uploads binaries and checksums
9. **Publish** - Option to publish immediately or keep as draft

### 3. Verify Release

After creation, verify:
- [ ] All assets uploaded (2 binaries + SHA256SUMS.txt)
- [ ] Release notes are formatted correctly
- [ ] Tag matches version in notes

## Manual Token Creation

To create a Gitea API token:

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
1. Go to the release page on Gitea
2. Click "Edit"
3. Uncheck "Draft"
4. Click "Publish Release"

## Rollback Procedure

If a release has issues:

1. **Delete the release** from Gitea (or mark as draft)
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
- ✅ Cleans `server/backend/OS/dist/` before frontend build
- ✅ Checks if release tag already exists (prevents duplicates)
- ✅ Cleans up temp files on exit (unless `--keep-build` or `--dry-run`)

**If script fails mid-way:** Just re-run it. The only issue is if a draft release was created on Gitea - you'll need to delete it manually or use a different version tag.

## Troubleshooting

### CI Suite Fails

Fix the failing tests before proceeding. The script will not allow creating a release with failing tests.

### Token Validation Fails

- Ensure token has correct scopes
- Check Gitea instance URL is correct
- Verify network connectivity to Gitea

### Build Fails

Common causes:
- Missing Go dependencies: `cd server/backend && go mod download`
- Missing Node dependencies: `cd server/frontend && npm install`
- Docker not running (required for some tests)

### Asset Upload Fails

- Check token hasn't expired
- Verify Gitea instance is accessible
- Ensure file sizes are within Gitea limits (default 50MB)

## Post-Release Tasks

After publishing:

1. **Update documentation** - Changelog, README if needed
2. **Announce release** - Community channels, social media
3. **Monitor issues** - Watch for bug reports in first 24-48 hours
4. **Update roadmap** - Mark completed tasks in ROADMAP.md

## Security Considerations

- **Checksums** - SHA256SUMS.txt provided for integrity verification
- **Binary signing** - Future releases may include GPG signatures
- **Supply chain** - Binaries built from source on your machine, review all code before release

## Automation (Future)

Currently manual by design. Future automation may include:
- Automated changelog generation
- GitHub Actions / Gitea Actions workflow
- Automatic ISO building for appliance releases

---

**Questions?** Open an issue on Gitea or contact the maintainers.

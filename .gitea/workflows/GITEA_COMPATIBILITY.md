# Gitea Workflow Compatibility Report

## ✅ Compatible Workflows

All workflows have been verified for Gitea compatibility:

### 1. ci.yml ✅
- **Status:** Fully compatible
- **Features:** Go build, frontend build, tests, go vet, gofmt
- **Notes:** Uses standard GitHub Actions syntax compatible with Gitea

### 2. dependency-scanning.yml ✅
- **Status:** Fully compatible
- **Features:** govulncheck, gosec, staticcheck
- **Notes:** Security scanning tools work in Gitea

### 3. fuzz.yml ✅
- **Status:** Fully compatible
- **Features:** Fuzz testing with corpus caching
- **Notes:** Uses GitHub Actions cache which may need Gitea cache configuration

### 4. docker.yml ⚠️
- **Status:** Compatible with modifications
- **Features:** Docker build, multi-platform, security scanning
- **Notes:** 
  - GitHub Actions cache (`type=gha`) commented out
  - May need Gitea container registry configuration
  - Uses `${{ gitea.actor }}` and `${{ secrets.GITEA_TOKEN }}`

### 5. race-detection.yml ✅
- **Status:** Fully compatible
- **Features:** Race detection testing
- **Notes:** Standard Go commands, no external dependencies

### 6. coverage.yml ✅
- **Status:** Fully compatible
- **Features:** Code coverage, HTML reports, badges
- **Notes:** Generates artifacts compatible with Gitea

### 7. release.yml ⚠️
- **Status:** Compatible with modifications
- **Features:** Multi-platform builds, release creation
- **Notes:**
  - Uses Gitea API directly instead of GitHub Actions
  - Requires `GITEA_TOKEN` secret
  - Uses `${{ gitea.server_url }}`, `${{ gitea.repository_owner }}`, `${{ gitea.repository_name }}`

## 🔧 Required Configuration

### Secrets
Ensure these secrets are configured in your Gitea repository:

1. **`GITEA_TOKEN`** - Personal access token with repo scope
   - Generate at: User Settings → Applications → Generate New Token
   - Required for: Docker push, release creation

### Repository Settings

1. **Enable Actions:**
   - Repository Settings → Actions → Enable Repository Actions

2. **Configure Runners (if self-hosted):**
   - Install Gitea Actions Runner
   - Register with your Gitea instance

3. **Container Registry (for docker.yml):**
   - Ensure Gitea Container Registry is enabled
   - Default registry: `gt.plainskill.net`

## ⚠️ Known Limitations

1. **GitHub Actions Cache:**
   - `type=gha` cache is GitHub-specific
   - Commented out in docker.yml
   - Alternative: Use local cache or registry cache

2. **Some Action Features:**
   - `permissions` syntax may vary between Gitea versions
   - Matrix builds are fully supported

3. **Artifacts:**
   - Artifact uploads/downloads work in Gitea 1.20+
   - Retention policies may differ

## 🚀 Quick Start

1. Add the `GITEA_TOKEN` secret to your repository
2. Enable Actions in repository settings
3. Push to trigger workflows
4. Monitor runs in the Actions tab

## 📝 Workflow Triggers

All workflows trigger on:
- Push to `main` or `master` branches
- Pull requests to `main` or `master`
- Scheduled runs (where configured)
- Tags starting with `v*` (for release.yml)

## 🐛 Troubleshooting

### Docker Build Fails
- Check that `GITEA_TOKEN` is set
- Verify container registry is accessible
- Check docker daemon is running on the runner

### Release Creation Fails
- Ensure `GITEA_TOKEN` has repo scope
- Verify repository has releases enabled
- Check that tag exists before creating release

### Cache Not Working
- Gitea may not support GitHub Actions cache
- Consider using registry cache or disabling cache
- Use local filesystem cache for self-hosted runners

## 📊 Workflow Summary

| Workflow | Purpose | Trigger | Gitea Ready |
|----------|---------|---------|-------------|
| ci.yml | Build & test | Push/PR | ✅ |
| dependency-scanning.yml | Security scan | Push/Schedule | ✅ |
| fuzz.yml | Fuzz testing | Push/PR/Schedule | ✅ |
| docker.yml | Docker build | Push/PR/Tags | ⚠️ |
| race-detection.yml | Race detection | Push/PR/Schedule | ✅ |
| coverage.yml | Coverage reports | Push/PR | ✅ |
| release.yml | Release binaries | Tags | ⚠️ |

✅ = Fully compatible
⚠️ = Compatible with minor configuration

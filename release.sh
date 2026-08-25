#!/bin/bash
set -e

# LibreServ Release Script
# Interactive script to create Forgejo releases with binaries
# Usage: ./release.sh [--dry-run]

FORGEJO_INSTANCE="${FORGEJO_INSTANCE:-https://gt.plainskill.net}"
REPO_OWNER="LibreLoom"
REPO_NAME="LibreServ"
ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
DRY_RUN=false
PRESERVE_BUILD=false
FORCE=false
PRERELEASE=false
YES=false
SKIP_CI=false
WITH_ISO=false
PUBLISH=false
LUNA_RELEASE=false
VERSION_TAG=""
NOTES_FILE=""

# Parse arguments
while [ $# -gt 0 ]; do
    case $1 in
        --dry-run)
            DRY_RUN=true
            PRESERVE_BUILD=true
            shift
            ;;
        --keep-build)
            PRESERVE_BUILD=true
            shift
            ;;
        --force)
            FORCE=true
            shift
            ;;
        --pre-release)
            PRERELEASE=true
            shift
            ;;
        --yes|-y)
            YES=true
            shift
            ;;
        --skip-ci)
            SKIP_CI=true
            shift
            ;;
        --with-iso)
            WITH_ISO=true
            shift
            ;;
        --luna)
            LUNA_RELEASE=true
            WITH_ISO=true
            shift
            ;;
        --publish)
            PUBLISH=true
            shift
            ;;
        --version)
            VERSION_TAG="$2"
            shift 2
            ;;
        --notes-file)
            NOTES_FILE="$2"
            shift 2
            ;;
        --help|-h)
            echo "Usage: ./release.sh [--dry-run] [--keep-build] [--force] [--pre-release] [--yes] [--version vX.Y.Z] [--notes-file PATH] [--luna] [--with-iso] [--publish] [--skip-ci]"
            echo ""
            echo "Options:"
            echo "  --dry-run      Build binaries and release notes, but skip Forgejo API calls"
            echo "  --keep-build   Keep release-build/ directory after completion"
            echo "  --force        Delete existing release with same tag and recreate"
            echo "  --pre-release  Mark release as pre-release/unstable (beta, rc, etc.)"
            echo "  --yes, -y      Non-interactive: no prompts (uses FORGEJO_TOKEN from the environment)"
            echo "  --version TAG  Version tag (e.g. v0.0.13); required with --yes"
            echo "  --notes-file   Release notes markdown file; with --yes, generated if omitted"
            echo "  --luna         Luna release: tag luna-vX.Y.Z (stable by default), lunad + ISO"
            echo "  --with-iso     Also build and upload luna-rapidinstall-x86_64.iso (implied by --luna)"
            echo "  --publish      Publish immediately (with --yes, skip the publish prompt)"
            echo "  --skip-ci      Do not run ./ci (still allowed for pre-releases)"
            echo "  --help, -h     Show this help message"
            exit 0
            ;;
        *)
            echo "Unknown option: $1" >&2
            exit 1
            ;;
    esac
done

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_step() { echo -e "${BLUE}[STEP]${NC} $1"; }

minisign_secret_key() {
    if [ -n "${MINISIGN_SECRET_KEY:-}" ]; then
        printf '%s\n' "$MINISIGN_SECRET_KEY"
        return 0
    fi
    if [ -f "$HOME/.minisign/libreserv.key" ]; then
        printf '%s\n' "$HOME/.minisign/libreserv.key"
        return 0
    fi
    return 1
}

# Sign SHA256SUMS.txt in $1. Fail closed — never publish unsigned checksums.
sign_checksums() {
    local dir="$1"
    local pub="$ROOT_DIR/keys/releases.minisign.pub"
    if ! command -v minisign >/dev/null 2>&1; then
        log_error "minisign is required to sign SHA256SUMS.txt."
        log_error "Install it (Arch: pacman -S minisign) and try again. Unsigned releases are not allowed."
        exit 1
    fi
    if [ ! -f "$pub" ]; then
        log_error "Missing $pub"
        exit 1
    fi
    local key
    if ! key="$(minisign_secret_key)"; then
        log_error "No minisign secret key. Set MINISIGN_SECRET_KEY or put the key at ~/.minisign/libreserv.key"
        exit 1
    fi
    if [ ! -f "$dir/SHA256SUMS.txt" ]; then
        log_error "SHA256SUMS.txt missing in $dir"
        exit 1
    fi
    log_info "Signing SHA256SUMS.txt ($key)..."
    if ! (cd "$dir" && minisign -S -s "$key" -m SHA256SUMS.txt); then
        log_error "minisign failed. Nothing will be published unsigned."
        exit 1
    fi
    if [ ! -f "$dir/SHA256SUMS.txt.minisig" ]; then
        log_error "SHA256SUMS.txt.minisig was not created"
        exit 1
    fi
    if ! minisign -V -q -p "$pub" -m "$dir/SHA256SUMS.txt"; then
        log_error "Signature does not match keys/releases.minisign.pub."
        log_error "Use the secret that matches the committed public key (MINISIGN_SECRET_KEY)."
        exit 1
    fi
    log_info "Checksums signed and verified against the committed public key"
}

print_banner() {
    echo -e "${BLUE}LibreServ Release Script${NC}"
    echo "========================"
    echo ""
}

# Prompt for Forgejo token
prompt_token() {
    if [ -n "${FORGEJO_TOKEN:-}" ]; then
        log_info "Using FORGEJO_TOKEN from the environment"
    elif [ "$YES" = true ]; then
        log_error "FORGEJO_TOKEN must be set in the environment when using --yes"
        exit 1
    else
    echo ""
    log_step "Forgejo API Token Required"
    echo ""
    echo "Create a new API token:"
    echo "  1. Go to ${FORGEJO_INSTANCE}/user/settings/applications"
    echo "  2. Click 'Generate New Token'"
    echo "  3. Name: anything you want (e.g., release-script)"
    echo "  4. Select scopes:"
    echo "     - repository: Read and Write"
    echo "     - user: Read"
    echo "  5. Copy the generated token"
    echo ""
    
    while true; do
        read -sp "Paste your Forgejo token: " FORGEJO_TOKEN
        echo ""
        if [ -z "$FORGEJO_TOKEN" ]; then
            log_error "Token cannot be empty"
            continue
        fi
        break
    done
    fi
    
    # Validate token by making a test API call
    log_info "Validating token..."
    VALIDATE_RESPONSE=$(curl -s -H "Authorization: token $FORGEJO_TOKEN" "$FORGEJO_INSTANCE/api/v1/user")
    if ! echo "$VALIDATE_RESPONSE" | grep -q '"id"'; then
        log_error "Token validation failed"
        log_error "Response: $VALIDATE_RESPONSE"
        echo ""
        log_error "Make sure your token has these scopes:"
        echo "  - repository: Read and Write"
        echo "  - user: Read"
        exit 1
    fi
    log_info "Token validated successfully"
}

# Prompt for version tag
prompt_version() {
    echo ""
    log_step "Version Tag"
    echo ""

    if [ -n "$VERSION_TAG" ]; then
        if [[ ! "$VERSION_TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$ ]]; then
            log_error "Invalid version format. Use semantic versioning: v1.0.0 or v1.0.0-beta.1"
            exit 1
        fi
        log_info "Version: $VERSION_TAG"
    else
        if [ "$YES" = true ]; then
            log_error "--version is required with --yes"
            exit 1
        fi
        while true; do
            read -p "Enter version tag (e.g., v1.0.0): " VERSION_TAG
            if [[ ! "$VERSION_TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$ ]]; then
                log_error "Invalid version format. Use semantic versioning: v1.0.0 or v1.0.0-beta.1"
                continue
            fi
            break
        done
    fi

    if [ "$LUNA_RELEASE" = true ]; then
        VERSION_TAG="luna-${VERSION_TAG}"
        log_info "Luna Forgejo tag: $VERSION_TAG (stable unless --pre-release)"
    fi
    
    # Ask if this is a pre-release
    if [ "$PRERELEASE" = false ] && [ "$YES" != true ]; then
        echo ""
        echo "Is this a pre-release (beta, rc, alpha)?"
        echo "Pre-releases are marked as 'unstable' and won't be offered as latest."
        read -p "Mark as pre-release? (y/N): " prerelease_confirm
        if [ "$prerelease_confirm" = "y" ] || [ "$prerelease_confirm" = "Y" ]; then
            PRERELEASE=true
            log_info "Release will be marked as pre-release"
        fi
    fi
}

# Check git status
check_git_status() {
    log_info "Checking git status..."
    
    # Check for uncommitted changes
    if [ -n "$(git status --porcelain)" ]; then
        log_error "Working directory has uncommitted changes"
        git status --short
        echo ""
        log_error "Please commit or stash changes before creating a release"
        exit 1
    fi
    
    # Check current branch
    CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
    if [ "$CURRENT_BRANCH" != "main" ]; then
        log_warn "Not on main branch (current: $CURRENT_BRANCH)"
        if [ "$YES" = true ]; then
            log_info "Continuing anyway (--yes)"
        else
            read -p "Continue anyway? (y/N): " confirm
            if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
                exit 1
            fi
        fi
    fi
    
    log_info "Git status OK"
}

# Validate tag doesn't conflict (early, before expensive operations)
validate_tag() {
    log_info "Validating tag $VERSION_TAG..."
    
    if git rev-parse "$VERSION_TAG" >/dev/null 2>&1; then
        if [ "$FORCE" = true ]; then
            log_warn "Local tag $VERSION_TAG exists, deleting (--force)..."
            git tag -d "$VERSION_TAG"
        else
            log_error "Git tag $VERSION_TAG already exists locally"
            echo "Delete it with: git tag -d $VERSION_TAG"
            echo "Or re-run with --force"
            exit 1
        fi
    fi
    
    REMOTE_EXISTS=$(git ls-remote --tags origin "refs/tags/$VERSION_TAG" 2>/dev/null | grep -c . || true)
    if [ "$REMOTE_EXISTS" -gt 0 ]; then
        if [ "$FORCE" = true ]; then
            log_warn "Remote tag $VERSION_TAG exists, deleting (--force)..."
            git push --delete origin "$VERSION_TAG" 2>/dev/null || true
        else
            log_error "Tag $VERSION_TAG already exists remotely"
            echo "Delete it with: git push --delete origin $VERSION_TAG && git tag -d $VERSION_TAG"
            echo "Or re-run with --force"
            exit 1
        fi
    fi
    
    log_info "Tag validated successfully"
}

# Run CI suite
run_ci() {
    log_step "Run CI Suite"
    echo ""
    
    if [ ! -f "./ci" ]; then
        log_error "CI script not found. Are you in the LibreServ root directory?"
        exit 1
    fi
    
    if [ "$SKIP_CI" = true ]; then
        log_warn "Skipping CI suite (--skip-ci)"
        return
    fi
    if [ "$YES" != true ]; then
        echo "The CI suite takes 5-15 minutes to run."
        echo ""
        read -p "Run full CI suite before release? (Y/n): " run_ci
        if [ "$run_ci" = "n" ] || [ "$run_ci" = "N" ]; then
            log_warn "Skipping CI suite - ensure tests pass manually!"
            return
        fi
    fi
    
    log_info "Running full CI profile (this may take a while)..."
    ./ci run -profile full
    
    if [ $? -ne 0 ]; then
        log_error "CI suite failed. Cannot create release with failing tests"
        exit 1
    fi
    
    log_info "CI suite passed"
}

# Build binaries
build_binaries() {
    log_step "Building Binaries"
    echo ""
    
    # Create build directory
    BUILD_DIR=$(pwd)/release-build
    rm -rf "$BUILD_DIR"
    mkdir -p "$BUILD_DIR"
    
    if [ "$LUNA_RELEASE" = true ]; then
        log_info "Building Luna rapidinstall ISO (musl lunad + rootfs + xorriso)..."
        if ! command -v podman >/dev/null 2>&1; then
            log_error "Podman is required for Luna ISO releases"
            rm -rf "$BUILD_DIR"
            exit 1
        fi
        chmod +x luna/os/build-iso.sh
        if ! (cd luna && ./os/build-iso.sh); then
            log_error "ISO build failed"
            rm -rf "$BUILD_DIR"
            exit 1
        fi
        ISO_SRC="luna/os/dist/luna-rapidinstall-x86_64.iso"
        if [ ! -f "$ISO_SRC" ]; then
            log_error "ISO missing at $ISO_SRC"
            rm -rf "$BUILD_DIR"
            exit 1
        fi
        cp "$ISO_SRC" "$BUILD_DIR/luna-rapidinstall-x86_64.iso"
        LUNAD_MUSL="luna/target/x86_64-unknown-linux-musl/release/lunad"
        if [ ! -x "$LUNAD_MUSL" ]; then
            log_error "missing musl lunad at $LUNAD_MUSL"
            rm -rf "$BUILD_DIR"
            exit 1
        fi
        cp "$LUNAD_MUSL" "$BUILD_DIR/lunad-linux-amd64"

        log_info "Generating SHA256 checksums..."
        cd "$BUILD_DIR"
        sha256sum lunad-linux-amd64 luna-rapidinstall-x86_64.iso > SHA256SUMS.txt
        cd ..
        sign_checksums "$BUILD_DIR"
        log_info "Luna assets built successfully"
        echo ""
        ls -lh "$BUILD_DIR"
        return
    fi
    
    # Build frontend first
    log_info "Building frontend..."
    cd server/backend

    # Clean old build to avoid permission issues
    rm -rf OS/dist

    if ! make frontend-build; then
        log_error "Frontend build failed"
        log_info "Cleaning up..."
        cd ../..
        rm -rf "$BUILD_DIR"
        exit 1
    fi
    cd ../..
    
    # Download restic binaries for embedding
    log_info "Downloading restic for embedding..."
    cd server/backend
    
    RESTIC_VERSION="0.18.1"
    
    # AMD64 restic
    log_info "Downloading restic ${RESTIC_VERSION} for linux/amd64..."
    mkdir -p OS/bin
    if ! curl -fSL "https://github.com/restic/restic/releases/download/v${RESTIC_VERSION}/restic_${RESTIC_VERSION}_linux_amd64.bz2" \
        | bzip2 -d > OS/bin/restic; then
        log_error "Failed to download restic for amd64"
        cd ../..
        rm -rf "$BUILD_DIR"
        exit 1
    fi
    chmod +x OS/bin/restic
    cd ../..
    
    # Get version info for ldflags
    GIT_COMMIT=$(git rev-parse HEAD)
    BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    
    # Build Linux AMD64
    log_info "Building libreserv-linux-amd64..."
    cd server/backend
    if ! GOOS=linux GOARCH=amd64 go build -tags "embedfront embedrestic" \
        -ldflags "-X gt.plainskill.net/LibreLoom/LibreServ/internal/api/handlers.Version=$VERSION_TAG \
                  -X gt.plainskill.net/LibreLoom/LibreServ/internal/api/handlers.GitCommit=$GIT_COMMIT \
                  -X gt.plainskill.net/LibreLoom/LibreServ/internal/api/handlers.BuildTime=$BUILD_TIME" \
        -o "$BUILD_DIR/libreserv-linux-amd64" ./cmd/libreserv; then
        log_error "Failed to build AMD64 binary"
        cd ../..
        rm -rf "$BUILD_DIR"
        exit 1
    fi
    cd ../..
    
    # Build Linux ARM64
    log_info "Building libreserv-linux-arm64..."
    cd server/backend

    # Download ARM64 restic for embedding
    log_info "Downloading restic ${RESTIC_VERSION} for linux/arm64..."
    if ! curl -fSL "https://github.com/restic/restic/releases/download/v${RESTIC_VERSION}/restic_${RESTIC_VERSION}_linux_arm64.bz2" \
        | bzip2 -d > OS/bin/restic; then
        log_error "Failed to download restic for arm64"
        cd ../..
        rm -rf "$BUILD_DIR"
        exit 1
    fi
    chmod +x OS/bin/restic

    if ! GOOS=linux GOARCH=arm64 go build -tags "embedfront embedrestic" \
        -ldflags "-X gt.plainskill.net/LibreLoom/LibreServ/internal/api/handlers.Version=$VERSION_TAG \
                  -X gt.plainskill.net/LibreLoom/LibreServ/internal/api/handlers.GitCommit=$GIT_COMMIT \
                  -X gt.plainskill.net/LibreLoom/LibreServ/internal/api/handlers.BuildTime=$BUILD_TIME" \
        -o "$BUILD_DIR/libreserv-linux-arm64" ./cmd/libreserv; then
        log_error "Failed to build ARM64 binary"
        cd ../..
        rm -rf "$BUILD_DIR"
        exit 1
    fi
    rm -f server/backend/OS/bin/restic
    cd ../..
    
    # Generate checksums
    log_info "Generating SHA256 checksums..."
    cd "$BUILD_DIR"
    sha256sum libreserv-linux-amd64 libreserv-linux-arm64 > SHA256SUMS.txt
    cd ..
    sign_checksums "$BUILD_DIR"
    
    log_info "Binaries built successfully"
    echo ""
    ls -lh "$BUILD_DIR"
}

# Create release notes in editor or from a file / git log
create_release_notes() {
    log_step "Create Release Notes"
    echo ""

    if [ -n "$NOTES_FILE" ]; then
        if [ ! -f "$NOTES_FILE" ]; then
            log_error "Notes file not found: $NOTES_FILE"
            exit 1
        fi
        RELEASE_NOTES=$(cat "$NOTES_FILE")
        log_info "Using release notes from $NOTES_FILE"
        return
    fi

    if [ "$LUNA_RELEASE" = true ]; then
        LAST_TAG=$(git describe --tags --abbrev=0 --match 'luna-v*' 2>/dev/null || true)
    else
        LAST_TAG=$(git describe --tags --abbrev=0 --match 'v*' 2>/dev/null || true)
    fi
    COMMITS=""
    if [ -n "$LAST_TAG" ]; then
        COMMITS=$(git log --oneline --decorate --no-merges "${LAST_TAG}..HEAD" 2>/dev/null || true)
    else
        COMMITS=$(git log --oneline --decorate --no-merges -20 2>/dev/null || true)
    fi

    if [ "$YES" = true ]; then
        RELEASE_NOTES="$(cat <<EOF
## What's Changed

Pre-release ${VERSION_TAG}. Automated cut for the Luna rapidinstall ISO rehearsal on a mini PC.

## New Features

- Luna rapidinstall ISO is pinned to Alpine 3.24 (same as the rootfs).
- ISO build now emits 32-bit UEFI GRUB when Alpine ships i386-efi modules.
- \`./os/build-iso.sh\` builds the web UI, musl lunad, rootfs, and hybrid ISO in one step.
- \`./release.sh --with-iso\` attaches \`luna-rapidinstall-x86_64.iso\` (and musl \`lunad-linux-amd64\`) to the Forgejo release.

## Bug Fixes

- ISO builder no longer defaults to \`alpine:latest\`.

## Breaking Changes

None.

## Upgrade Notes

Flash \`luna-rapidinstall-x86_64.iso\` to a USB stick, boot the mini PC with Secure Boot off, and type \`install luna\` when the installer names the built-in disk.

## Commits Since Last Release

${COMMITS:-"(No commits found)"}
EOF
)"
        log_info "Generated release notes (--yes)"
        return
    fi

    echo "Opening editor for release notes..."
    echo "Write your changelog, then save and close the editor."
    echo ""
    
    TMP_NOTES=$(mktemp)
    
    cat > "$TMP_NOTES" << 'TEMPLATE'
## What's Changed

## New Features

## Bug Fixes

## Breaking Changes

## Upgrade Notes

TEMPLATE
    
    echo "" >> "$TMP_NOTES"
    echo "## Commits Since Last Release" >> "$TMP_NOTES"
    echo "" >> "$TMP_NOTES"
    echo "${COMMITS:-"(No commits found)"}" >> "$TMP_NOTES"
    
    EDITOR="${EDITOR:-nano}"
    $EDITOR "$TMP_NOTES"
    
    RELEASE_NOTES=$(cat "$TMP_NOTES")
    rm -f "$TMP_NOTES"
    
    if [ -z "$RELEASE_NOTES" ]; then
        log_error "Release notes cannot be empty"
        exit 1
    fi
}

# Create draft release on Forgejo (empty notes — validates tag + API before user writes notes)
create_draft_release() {
    log_step "Creating Draft Release on Forgejo"
    echo ""
    
    # Check if release already exists and handle it
    EXISTING=$(curl -s -H "Authorization: token $FORGEJO_TOKEN" \
        "$FORGEJO_INSTANCE/api/v1/repos/$REPO_OWNER/$REPO_NAME/releases/tags/$VERSION_TAG")
    
    if command -v jq &> /dev/null; then
        EXISTING_ID=$(echo "$EXISTING" | jq -r '.id // empty')
    else
        EXISTING_ID=$(echo "$EXISTING" | grep -oP '"id"\s*:\s*\K[0-9]+' | head -1)
    fi
    
    if [ -n "$EXISTING_ID" ]; then
        if [ "$FORCE" = true ]; then
            log_info "Deleting existing release (--force)..."
            curl -s -X DELETE -H "Authorization: token $FORGEJO_TOKEN" \
                "$FORGEJO_INSTANCE/api/v1/repos/$REPO_OWNER/$REPO_NAME/releases/$EXISTING_ID" > /dev/null
            log_info "Deleted existing release"
        else
            log_error "Release $VERSION_TAG already exists"
            echo "Use --force to delete and recreate"
            exit 1
        fi
    fi
    
    PRERELEASE_FLAG="false"
    [ "$PRERELEASE" = true ] && PRERELEASE_FLAG="true"
    
    log_info "Creating draft release (validating API)..." 
    HTTP_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST \
        -H "Authorization: token $FORGEJO_TOKEN" \
        -H "Content-Type: application/json" \
        -d "{
            \"tag_name\": \"$VERSION_TAG\",
            \"name\": \"$VERSION_TAG\",
            \"body\": \"\",
            \"draft\": true,
            \"prerelease\": $PRERELEASE_FLAG
        }" \
        "$FORGEJO_INSTANCE/api/v1/repos/$REPO_OWNER/$REPO_NAME/releases")
    
    HTTP_CODE=$(echo "$HTTP_RESPONSE" | tail -n1)
    RESPONSE_BODY=$(echo "$HTTP_RESPONSE" | sed '$d')
    
    if [ "$HTTP_CODE" != "201" ]; then
        log_error "Failed to create release (HTTP $HTTP_CODE)"
        echo "Response: $RESPONSE_BODY"
        log_info "Cleaning up local tag..."
        git tag -d "$VERSION_TAG" 2>/dev/null || true
        exit 1
    fi
    
    if command -v jq &> /dev/null; then
        RELEASE_ID=$(echo "$RESPONSE_BODY" | jq -r '.id')
    else
        RELEASE_ID=$(echo "$RESPONSE_BODY" | grep -oP '"id"\s*:\s*\K[0-9]+' | head -1)
    fi
    
    if [ -z "$RELEASE_ID" ] || [ "$RELEASE_ID" = "null" ]; then
        log_error "Failed to parse release ID from response"
        echo "Response: $RESPONSE_BODY"
        log_info "Cleaning up local tag..."
        git tag -d "$VERSION_TAG" 2>/dev/null || true
        exit 1
    fi
    
    log_info "Draft release created successfully (ID: $RELEASE_ID) — API is working"
    log_info "Now write your release notes"
}

# Update the draft release with the written notes
update_release_with_notes() {
    log_step "Updating Release Notes"
    echo ""
    
    if command -v jq >/dev/null 2>&1; then
        HTTP_RESPONSE=$(jq -n --arg body "$RELEASE_NOTES" '{body: $body}' | curl -s -w "\n%{http_code}" -X PATCH \
            -H "Authorization: token $FORGEJO_TOKEN" \
            -H "Content-Type: application/json" \
            -d @- \
            "$FORGEJO_INSTANCE/api/v1/repos/$REPO_OWNER/$REPO_NAME/releases/$RELEASE_ID")
    else
        ESCAPED_NOTES=$(echo "$RELEASE_NOTES" | sed 's/\\/\\\\/g' | sed 's/"/\\"/g' | sed ':a;N;$!ba;s/\n/\\n/g')
        HTTP_RESPONSE=$(curl -s -w "\n%{http_code}" -X PATCH \
            -H "Authorization: token $FORGEJO_TOKEN" \
            -H "Content-Type: application/json" \
            -d "{\"body\": \"$ESCAPED_NOTES\"}" \
            "$FORGEJO_INSTANCE/api/v1/repos/$REPO_OWNER/$REPO_NAME/releases/$RELEASE_ID")
    fi
    
    HTTP_CODE=$(echo "$HTTP_RESPONSE" | tail -n1)
    
    if [ "$HTTP_CODE" != "200" ] && [ "$HTTP_CODE" != "204" ]; then
        log_error "Failed to update release notes (HTTP $HTTP_CODE)"
        echo "Response: $(echo "$HTTP_RESPONSE" | sed '$d')"
        log_warn "Release notes saved locally — paste them manually at:"
        echo "  ${FORGEJO_INSTANCE}/${REPO_OWNER}/${REPO_NAME}/releases/edit/$RELEASE_ID"
        echo ""
        echo "Notes content:"
        echo "$RELEASE_NOTES"
    else
        log_info "Release notes updated"
    fi
}

# Upload assets to Forgejo
upload_assets() {
    log_step "Uploading Assets"
    echo ""
    
    BUILD_DIR=$(pwd)/release-build
    
    log_info "Release ID: $RELEASE_ID"
    log_info "Build directory: $BUILD_DIR"
    ls -lh "$BUILD_DIR"
    echo ""
    
    if [ "$LUNA_RELEASE" = true ]; then
        REQUIRED_ASSETS=(lunad-linux-amd64 luna-rapidinstall-x86_64.iso SHA256SUMS.txt SHA256SUMS.txt.minisig)
    else
        REQUIRED_ASSETS=(libreserv-linux-amd64 libreserv-linux-arm64 SHA256SUMS.txt SHA256SUMS.txt.minisig)
    fi

    for file in "${REQUIRED_ASSETS[@]}"; do
        if [ ! -f "$BUILD_DIR/$file" ]; then
            log_error "Missing file: $BUILD_DIR/$file"
            exit 1
        fi
    done
    
    for file in "${REQUIRED_ASSETS[@]}"; do
        log_info "Uploading $file..."
        
        FILE_SIZE=$(du -h "$BUILD_DIR/$file" | cut -f1)
        BYTES=$(stat -c%s "$BUILD_DIR/$file")
        ASSET_URL="$FORGEJO_INSTANCE/api/v1/repos/$REPO_OWNER/$REPO_NAME/releases/$RELEASE_ID/assets?name=$file"

        # curl --data-binary loads the whole file; stream large ISOs instead.
        if [ "$BYTES" -gt 83886080 ]; then
            HTTP_CODE=$(python3 - "$ASSET_URL" "$BUILD_DIR/$file" "$FORGEJO_TOKEN" <<'PY'
import os, sys, urllib.request
url, path, token = sys.argv[1], sys.argv[2], sys.argv[3]
size = os.path.getsize(path)
req = urllib.request.Request(url, data=open(path, "rb"), method="POST")
req.add_header("Authorization", "token " + token)
req.add_header("Content-Type", "application/octet-stream")
req.add_header("Content-Length", str(size))
try:
    with urllib.request.urlopen(req, timeout=7200) as resp:
        print(resp.status)
except Exception as e:
    code = getattr(e, "code", 0)
    body = ""
    if hasattr(e, "read"):
        body = e.read().decode("utf-8", "replace")[:500]
    sys.stderr.write(f"{type(e).__name__}: {e}\n{body}\n")
    print(code or 0)
    sys.exit(1)
PY
)
            CURL_EXIT=$?
            RESPONSE_BODY=""
            MAX_TIME=7200
        else
            MAX_TIME=300
            UPLOAD_RESPONSE=$(curl -s -w "\n%{http_code}" \
                --connect-timeout 30 \
                --max-time "$MAX_TIME" \
                -X POST \
                -H "Authorization: token $FORGEJO_TOKEN" \
                -H "Content-Type: application/octet-stream" \
                --data-binary @"$BUILD_DIR/$file" \
                "$ASSET_URL" 2>&1)
            CURL_EXIT=$?
            HTTP_CODE=$(echo "$UPLOAD_RESPONSE" | tail -n1)
            RESPONSE_BODY=$(echo "$UPLOAD_RESPONSE" | sed '$d')
        fi
        
        if [ $CURL_EXIT -ne 0 ]; then
            log_error "curl failed with exit code $CURL_EXIT"
            log_error "Network error uploading $file ($FILE_SIZE)"
            exit 1
        fi
        
        HTTP_CODE=$(echo "$UPLOAD_RESPONSE" | tail -n1)
        RESPONSE_BODY=$(echo "$UPLOAD_RESPONSE" | sed '$d')
        
        if [ "$HTTP_CODE" != "201" ] && [ "$HTTP_CODE" != "200" ]; then
            log_error "Failed to upload $file (HTTP $HTTP_CODE)"
            echo "$RESPONSE_BODY"
            exit 1
        fi
        
        log_info "Uploaded $file ($FILE_SIZE)"
    done
}

# Publish release
publish_release() {
    log_step "Publish Release"
    echo ""
    
    log_info "Release is currently a draft"
    echo ""
    echo "Release URL: ${FORGEJO_INSTANCE}/${REPO_OWNER}/${REPO_NAME}/releases/tag/${VERSION_TAG}"
    echo ""
    if [ "$YES" = true ]; then
        if [ "$PUBLISH" = true ]; then
            confirm=y
        else
            confirm=n
        fi
    else
        read -p "Publish now? (y/N): " confirm
    fi
    if [ "$confirm" = "y" ] || [ "$confirm" = "Y" ]; then
        log_info "Publishing release..."
        
        PUBLISH_RESPONSE=$(curl -s -w "\n%{http_code}" -X PATCH \
            -H "Authorization: token $FORGEJO_TOKEN" \
            -H "Content-Type: application/json" \
            -d '{"draft": false}' \
            "$FORGEJO_INSTANCE/api/v1/repos/$REPO_OWNER/$REPO_NAME/releases/$RELEASE_ID")
        
        PUBLISH_CODE=$(echo "$PUBLISH_RESPONSE" | tail -n1)
        PUBLISH_BODY=$(echo "$PUBLISH_RESPONSE" | sed '$d')
        
        if [ "$PUBLISH_CODE" != "200" ] && [ "$PUBLISH_CODE" != "204" ]; then
            log_error "Failed to publish release (HTTP $PUBLISH_CODE)"
            echo "Response: $PUBLISH_BODY"
            exit 1
        fi
        
        log_info "Release published!"
        echo ""
        echo "View release: ${FORGEJO_INSTANCE}/${REPO_OWNER}/${REPO_NAME}/releases/tag/${VERSION_TAG}"
    else
        log_info "Release remains as draft"
        echo "You can publish it later from the Forgejo web interface"
    fi
}

# Cleanup
cleanup() {
    EXIT_CODE=$?
    BUILD_DIR=$(pwd)/release-build
    
    # Always clean on error
    if [ $EXIT_CODE -ne 0 ]; then
        if [ -d "$BUILD_DIR" ] && [ "$PRESERVE_BUILD" != true ]; then
            log_warn "Cleaning up build directory after error..."
            rm -rf "$BUILD_DIR"
        elif [ -d "$BUILD_DIR" ]; then
            log_warn "Keeping release-build/ after error (--keep-build)"
        fi
        return
    fi
    
    # Normal cleanup on success
    if [ -d "$BUILD_DIR" ]; then
        if [ "$PRESERVE_BUILD" = true ]; then
            log_info "Build directory preserved: $BUILD_DIR"
            echo "  Binaries: $BUILD_DIR/libreserv-linux-{amd64,arm64}"
            echo "  Checksums: $BUILD_DIR/SHA256SUMS.txt"
            echo "  Signature: $BUILD_DIR/SHA256SUMS.txt.minisig"
        else
            log_info "Cleaning up build directory..."
            rm -rf "$BUILD_DIR"
        fi
    fi
}

# Create and push git tag
create_and_push_tag() {
    log_step "Creating Git Tag"
    echo ""
    log_info "Creating git tag $VERSION_TAG..."
    
    git tag -a "$VERSION_TAG" -m "Release $VERSION_TAG"
    
    log_info "Pushing tag to Forgejo..."
    if ! git push origin "$VERSION_TAG"; then
        log_error "Failed to push tag to remote"
        echo "Cleaning up local tag..."
        git tag -d "$VERSION_TAG"
        exit 1
    fi
    
    log_info "Git tag created and pushed successfully"
}

# Main
main() {
    print_banner
    
    # Check if in correct directory
    if [ ! -f "./ci" ] || [ ! -d "./server/backend" ]; then
        log_error "Must run from LibreServ root directory"
        exit 1
    fi
    
    # Clean up any stale build artifacts from previous runs
    if [ -d "./release-build" ]; then
        log_warn "Found stale release-build/ directory from previous run"
        if [ "$YES" = true ]; then
            rm -rf "./release-build"
            log_info "Cleaned up stale build directory"
        else
            read -p "Clean it up and continue? (Y/n): " confirm
            if [ "$confirm" != "n" ] && [ "$confirm" != "N" ]; then
                rm -rf "./release-build"
                log_info "Cleaned up stale build directory"
            else
                log_error "Please remove ./release-build manually and re-run"
                exit 1
            fi
        fi
    fi
    
    prompt_token
    prompt_version
    check_git_status
    validate_tag
    
    echo ""
    log_info "Ready to create release $VERSION_TAG"
    echo ""
    if [ "$YES" = true ]; then
        log_info "Continuing (--yes)"
    else
        read -p "Continue? (y/N): " confirm
        if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
            log_info "Aborted"
            exit 0
        fi
    fi
    
    run_ci
    build_binaries
    
    if [ "$DRY_RUN" = true ]; then
        echo ""
        log_warn "Dry run mode - skipping Forgejo API calls"
        log_info "Release assets ready in: $(pwd)/release-build/"
        echo ""
        echo "To create the release manually:"
        echo "  1. Go to ${FORGEJO_INSTANCE}/${REPO_OWNER}/${REPO_NAME}/releases/new"
        echo "  2. Create tag: $VERSION_TAG"
        echo "  3. Upload files from: $(pwd)/release-build/"
        echo ""
        
        # Cleanup
        cleanup
        
        echo ""
        log_info "Release preparation complete!"
        echo ""
        exit 0
    fi
    
    # Risky operations first (tag + API) — validates everything before user writes notes
    create_and_push_tag
    create_draft_release
    
    # Only now ask for release notes — all risky ops have passed
    create_release_notes
    update_release_with_notes
    
    echo ""
    
    upload_assets
    publish_release
    
    # Cleanup
    cleanup
    
    echo ""
    log_info "Release process complete!"
    echo ""
}

# Trap to cleanup on exit, interrupt, or termination
trap cleanup EXIT INT TERM

main

#!/bin/bash
set -e

# LibreServ Release Script
# Interactive script to create Gitea releases with binaries
# Usage: ./release.sh [--dry-run]

GITEA_INSTANCE="${GITEA_INSTANCE:-https://gt.plainskill.net}"
REPO_OWNER="LibreLoom"
REPO_NAME="LibreServ"
DRY_RUN=false

# Parse arguments
for arg in "$@"; do
    case $arg in
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --help|-h)
            echo "Usage: ./release.sh [--dry-run]"
            echo ""
            echo "Options:"
            echo "  --dry-run    Build binaries and release notes, but skip Gitea API calls"
            echo "  --help, -h   Show this help message"
            exit 0
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

print_banner() {
    echo -e "${BLUE}LibreServ Release Script${NC}"
    echo "========================"
    echo ""
}

# Prompt for Gitea token
prompt_token() {
    echo ""
    log_step "Gitea API Token Required"
    echo ""
    echo "Create a new API token:"
    echo "  1. Go to ${GITEA_INSTANCE}/user/settings/applications"
    echo "  2. Click 'Generate New Token'"
    echo "  3. Name: anything you want (e.g., release-script)"
    echo "  4. Select scopes:"
    echo "     - repository: Read and Write"
    echo "     - user: Read"
    echo "  5. Copy the generated token"
    echo ""
    
    while true; do
        read -sp "Paste your Gitea token: " GITEA_TOKEN
        echo ""
        if [ -z "$GITEA_TOKEN" ]; then
            log_error "Token cannot be empty"
            continue
        fi
        break
    done
    
    # Validate token by making a test API call
    log_info "Validating token..."
    VALIDATE_RESPONSE=$(curl -s -H "Authorization: token $GITEA_TOKEN" "$GITEA_INSTANCE/api/v1/user")
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
    
    while true; do
        read -p "Enter version tag (e.g., v1.0.0): " VERSION_TAG
        if [[ ! "$VERSION_TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9]+)?$ ]]; then
            log_error "Invalid version format. Use semantic versioning: v1.0.0 or v1.0.0-beta.1"
            continue
        fi
        break
    done
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
        read -p "Continue anyway? (y/N): " confirm
        if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
            exit 1
        fi
    fi
    
    # Check if tag already exists
    if git rev-parse "$VERSION_TAG" >/dev/null 2>&1; then
        log_error "Tag $VERSION_TAG already exists"
        exit 1
    fi
    
    log_info "Git status OK"
}

# Run CI suite
run_ci() {
    log_step "Run CI Suite"
    echo ""
    
    if [ ! -f "./ci" ]; then
        log_error "CI script not found. Are you in the LibreServ root directory?"
        exit 1
    fi
    
    echo "The CI suite takes 5-15 minutes to run."
    echo ""
    read -p "Run full CI suite before release? (Y/n): " run_ci
    if [ "$run_ci" = "n" ] || [ "$run_ci" = "N" ]; then
        log_warn "Skipping CI suite - ensure tests pass manually!"
        return
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
    
    # Build frontend first
    log_info "Building frontend..."
    cd server/backend
    make frontend-build
    cd ../..
    
    # Get version info for ldflags
    GIT_COMMIT=$(git rev-parse HEAD)
    BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    
    # Build Linux AMD64
    log_info "Building libreserv-linux-amd64..."
    cd server/backend
    GOOS=linux GOARCH=amd64 go build -tags "embedfront" \
        -ldflags "-X gt.plainskill.net/LibreLoom/LibreServ/internal/api/handlers.Version=$VERSION_TAG \
                  -X gt.plainskill.net/LibreLoom/LibreServ/internal/api/handlers.GitCommit=$GIT_COMMIT \
                  -X gt.plainskill.net/LibreLoom/LibreServ/internal/api/handlers.BuildTime=$BUILD_TIME" \
        -o "$BUILD_DIR/libreserv-linux-amd64" ./cmd/libreserv
    cd ../..
    
    # Build Linux ARM64
    log_info "Building libreserv-linux-arm64..."
    cd server/backend
    GOOS=linux GOARCH=arm64 go build -tags "embedfront" \
        -ldflags "-X gt.plainskill.net/LibreLoom/LibreServ/internal/api/handlers.Version=$VERSION_TAG \
                  -X gt.plainskill.net/LibreLoom/LibreServ/internal/api/handlers.GitCommit=$GIT_COMMIT \
                  -X gt.plainskill.net/LibreLoom/LibreServ/internal/api/handlers.BuildTime=$BUILD_TIME" \
        -o "$BUILD_DIR/libreserv-linux-arm64" ./cmd/libreserv
    cd ../..
    
    # Generate checksums
    log_info "Generating SHA256 checksums..."
    cd "$BUILD_DIR"
    sha256sum libreserv-linux-amd64 libreserv-linux-arm64 > SHA256SUMS.txt
    cd ..
    
    log_info "Binaries built successfully"
    echo ""
    ls -lh "$BUILD_DIR"
}

# Create release notes in editor
create_release_notes() {
    log_step "Create Release Notes"
    echo ""
    echo "Opening editor for release notes..."
    echo "Write your changelog, then save and close the editor."
    echo ""
    
    NOTES_FILE=$(mktemp)
    
    # Add template
    cat > "$NOTES_FILE" << 'TEMPLATE'
## What's Changed

## New Features

## Bug Fixes

## Breaking Changes

## Upgrade Notes

TEMPLATE
    
    # Add recent commits
    echo "" >> "$NOTES_FILE"
    echo "## Commits Since Last Release" >> "$NOTES_FILE"
    echo "" >> "$NOTES_FILE"
    git log --oneline --decorate --no-merges -20 >> "$NOTES_FILE" 2>/dev/null || echo "(No commits found)" >> "$NOTES_FILE"
    
    # Open editor
    EDITOR="${EDITOR:-nano}"
    $EDITOR "$NOTES_FILE"
    
    RELEASE_NOTES=$(cat "$NOTES_FILE")
    rm -f "$NOTES_FILE"
    
    if [ -z "$RELEASE_NOTES" ]; then
        log_error "Release notes cannot be empty"
        exit 1
    fi
}

# Create release on Gitea
create_gitea_release() {
    log_step "Creating Gitea Release"
    echo ""
    
    log_info "Creating draft release..."
    
    RESPONSE=$(curl -s -X POST \
        -H "Authorization: token $GITEA_TOKEN" \
        -H "Content-Type: application/json" \
        -d "{
            \"tag_name\": \"$VERSION_TAG\",
            \"name\": \"Release $VERSION_TAG\",
            \"body\": \"$(echo "$RELEASE_NOTES" | sed 's/"/\\"/g' | tr '\n' ' ')\",
            \"draft\": true
        }" \
        "$GITEA_INSTANCE/api/v1/repos/$REPO_OWNER/$REPO_NAME/releases")
    
    # Extract release ID
    RELEASE_ID=$(echo "$RESPONSE" | grep -o '"id":[0-9]*' | grep -o '[0-9]*')
    
    if [ -z "$RELEASE_ID" ]; then
        log_error "Failed to create release"
        echo "Response: $RESPONSE"
        exit 1
    fi
    
    log_info "Created draft release (ID: $RELEASE_ID)"
}

# Upload assets to Gitea
upload_assets() {
    log_step "Uploading Assets"
    echo ""
    
    BUILD_DIR=$(pwd)/release-build
    
    for file in libreserv-linux-amd64 libreserv-linux-arm64 SHA256SUMS.txt; do
        log_info "Uploading $file..."
        
        curl -s -X POST \
            -H "Authorization: token $GITEA_TOKEN" \
            -H "Content-Type: application/octet-stream" \
            --data-binary @"$BUILD_DIR/$file" \
            "$GITEA_INSTANCE/api/v1/repos/$REPO_OWNER/$REPO_NAME/releases/$RELEASE_ID/assets?name=$file" > /dev/null
        
        log_info "Uploaded $file"
    done
}

# Publish release
publish_release() {
    log_step "Publish Release"
    echo ""
    
    log_info "Release is currently a draft"
    echo ""
    echo "Release URL: ${GITEA_INSTANCE}/${REPO_OWNER}/${REPO_NAME}/releases/tag/${VERSION_TAG}"
    echo ""
    read -p "Publish now? (y/N): " confirm
    if [ "$confirm" = "y" ] || [ "$confirm" = "Y" ]; then
        log_info "Publishing release..."
        
        curl -s -X PATCH \
            -H "Authorization: token $GITEA_TOKEN" \
            -H "Content-Type: application/json" \
            -d '{"draft": false}' \
            "$GITEA_INSTANCE/api/v1/repos/$REPO_OWNER/$REPO_NAME/releases/$RELEASE_ID" > /dev/null
        
        log_info "Release published!"
        echo ""
        echo "View release: ${GITEA_INSTANCE}/${REPO_OWNER}/${REPO_NAME}/releases/tag/${VERSION_TAG}"
    else
        log_info "Release remains as draft"
        echo "You can publish it later from the Gitea web interface"
    fi
}

# Cleanup
cleanup() {
    BUILD_DIR=$(pwd)/release-build
    if [ -d "$BUILD_DIR" ]; then
        log_info "Cleaning up build directory..."
        rm -rf "$BUILD_DIR"
    fi
}

# Main
main() {
    print_banner
    
    # Check if in correct directory
    if [ ! -f "./ci" ] || [ ! -d "./server/backend" ]; then
        log_error "Must run from LibreServ root directory"
        exit 1
    fi
    
    prompt_token
    prompt_version
    check_git_status
    
    echo ""
    log_info "Ready to create release $VERSION_TAG"
    echo ""
    read -p "Continue? (y/N): " confirm
    if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
        log_info "Aborted"
        exit 0
    fi
    
    run_ci
    build_binaries
    create_release_notes
    
    if [ "$DRY_RUN" = true ]; then
        echo ""
        log_warn "Dry run mode - skipping Gitea API calls"
        log_info "Release assets ready in: $(pwd)/release-build/"
        echo ""
        echo "To create the release manually:"
        echo "  1. Go to ${GITEA_INSTANCE}/${REPO_OWNER}/${REPO_NAME}/releases/new"
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
    
    create_gitea_release
    upload_assets
    publish_release
    
    # Cleanup
    cleanup
    
    echo ""
    log_info "Release process complete!"
    echo ""
}

# Trap to cleanup on exit
trap cleanup EXIT

main

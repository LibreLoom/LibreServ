#!/bin/bash
set -euo pipefail

# LibreServ Installation Script
# Usage: curl -fsSL https://gt.plainskill.net/LibreLoom/LibreServ/raw/branch/main/install.sh -o install.sh && sudo bash install.sh && rm install.sh
#
# Options:
#   --uninstall    Remove LibreServ (preserves data)
#   --upgrade      Upgrade existing installation (preserves data and config)
#   --help         Show this help message

GITHUB_REPO="LibreLoom/LibreServ"
GITEA_URL="https://gt.plainskill.net"
INSTALL_DIR="/opt/libreserv"
BIN_DIR="/usr/local/bin"
CONFIG_DIR="/etc/libreserv"
DATA_DIR="/var/lib/libreserv"
LOG_DIR="/var/log/libreserv"
USER="libreserv"
SERVICE_NAME="libreserv"
NO_SYSTEMD=false
RESTIC_VERSION="0.18.1"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

print_banner() {
    echo -e "${BLUE}"
    cat <<'BANNER'
,--,                                                                        
,---.'|                                                                      
|   | :                                  .--.--.                             
:   : |     ,--,     ,---,               /  /    '.                           
|   ' :   ,--.'|   ,---.'|     __  ,-.   |  :  /`. /               __  ,-.   
;   ; '   |  |,    |   | :   ,' ,'/ /|   ;  |  |--`              ,' ,'/ /|   
'   | |__ `--'_    :   : :   '  | |' | ,---.  |  :  ;_       ,---.  '  | |' | 
|   | :.'|,' ,'|   :     |,-.|  |   ,' /     \  \  \    `.  /     \ |  |   ,' 
'   :    ;'  | |   |   : '  |'  :  / /    /  |  `----.   \/    /  |'  :  /   
|   |  ./ |  | :   |   |  / :|  | ' .    ' / |  __ \  \  |.    ' / ||  | '    
;   : ;   '  : |__ '   : |: |;  :| |'   ;   /| /  /`--'  /'   ;   /|;  : |    
|   |/    |  | '.'||   | '/ :|  , ; '   |  / |'--'.     / '   |  / ||  , ;    
'---'     ;  :    ;|   :    | ---'  |   :    |  `--'---'  |   :    | ---'     
          |  ,   / /    \  /        \   \  /              \   \  /           
           ---`-'  `-'----'         `----'                `----'            
     .---. 
   /.  ./| 
 .-' . ' | 
/___/ \:| 
.   \  ' . 
 \   \   ' 
  \   \   
   \   \ | 
    '---" 
BANNER
    echo -e "${NC}"
}

print_help() {
    echo "LibreServ Installation Script"
    echo ""
    echo "Usage: curl -fsSL https://gt.plainskill.net/LibreLoom/LibreServ/raw/branch/main/install.sh -o install.sh && sudo bash install.sh && rm install.sh"
    echo ""
    echo "Options:"
    echo "  --uninstall    Remove LibreServ (preserves data in ${DATA_DIR})"
    echo "  --upgrade      Upgrade existing installation (preserves data and config)"
    echo "  --no-systemd   Skip systemd setup (for TESTING only, not for production)"
    echo "  --help         Show this help message"
    echo ""
    echo "After installation, access the web interface at http://<device-ip>:8080"
}

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Detect OS and Architecture
detect_system() {
    OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
    ARCH="$(uname -m)"

    case "$ARCH" in
        x86_64) ARCH="amd64" ;;
        aarch64|arm64) ARCH="arm64" ;;
        *) log_error "Unsupported architecture: $ARCH"; exit 1 ;;
    esac

    if [ "$OS" != "linux" ]; then
        log_error "Unsupported OS: $OS (only Linux is supported for server installation)"
        exit 1
    fi

    log_info "Detected: ${OS}/${ARCH}"
}

# Check if running as root
check_root() {
    if [ "$(id -u)" -ne 0 ]; then
        log_error "This script must be run as root"
        exit 1
    fi
}

# Check required commands are available
check_dependencies() {
    local missing=()

    for cmd in curl openssl sha256sum; do
        if ! command -v "$cmd" >/dev/null 2>&1; then
            missing+=("$cmd")
        fi
    done

    if [ ${#missing[@]} -gt 0 ]; then
        log_error "Missing required commands: ${missing[*]}"
        log_error "Install them before running this script"
        exit 1
    fi
}

# Get distro info from /etc/os-release
get_distro_info() {
    if [ ! -f /etc/os-release ]; then
        log_error "Cannot detect Linux distribution (/etc/os-release not found)"
        exit 1
    fi

    . /etc/os-release
    DISTRO="$ID"
    DISTRO_VERSION_CODENAME="${VERSION_CODENAME:-}"
    DISTRO_VERSION_ID="${VERSION_ID:-}"

    # Map derivatives to their parent distro for Docker repo purposes
    case "$DISTRO" in
        linuxmint|pop|elementary|neon|zorin)
            DISTRO="ubuntu"
            if [ -z "$DISTRO_VERSION_CODENAME" ] && [ -f /etc/os-release ]; then
                . /etc/os-release
            fi
            ;;
        rocky|alma)
            DISTRO="rhel"
            ;;
    esac
}

# Run systemctl or skip in --no-systemd mode
run_systemctl() {
    if [ "$NO_SYSTEMD" = true ]; then
        return 0
    fi
    systemctl "$@"
}

# Install Docker if needed
install_docker() {
    if command -v docker >/dev/null 2>&1; then
        log_info "Docker is already installed: $(docker --version)"
        if ! run_systemctl is-active --quiet docker 2>/dev/null; then
            log_info "Starting Docker service..."
            run_systemctl start docker
        fi
        return
    fi

    log_info "Installing Docker..."

    get_distro_info

    case "$DISTRO" in
        ubuntu|debian)
            apt-get update -qq
            apt-get install -y -qq ca-certificates curl gnupg
            install -m 0755 -d /etc/apt/keyrings
            if ! command -v gpg >/dev/null 2>&1; then
                apt-get install -y -qq gnupg
            fi
            curl -fsSL "https://download.docker.com/linux/${DISTRO}/gpg" | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
            chmod a+r /etc/apt/keyrings/docker.gpg

            if [ -z "$DISTRO_VERSION_CODENAME" ]; then
                DISTRO_VERSION_CODENAME="$(lsb_release -cs 2>/dev/null || echo "focal")"
                log_warn "Could not detect version codename, using: ${DISTRO_VERSION_CODENAME}"
            fi

            echo "deb [arch=${ARCH} signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/${DISTRO} ${DISTRO_VERSION_CODENAME} stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null
            apt-get update -qq
            apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
            run_systemctl enable docker
            run_systemctl start docker
            ;;
        fedora)
            dnf -y -q install dnf-plugins-core
            dnf config-manager --add-repo https://download.docker.com/linux/fedora/docker-ce.repo
            dnf install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
            run_systemctl enable docker
            run_systemctl start docker
            ;;
        rhel|centos)
            if command -v dnf >/dev/null 2>&1; then
                dnf -y -q install dnf-plugins-core
                dnf config-manager --add-repo "https://download.docker.com/linux/rhel/docker-ce.repo"
                dnf install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
            elif command -v yum >/dev/null 2>&1; then
                yum install -y -q yum-utils
                yum-config-manager --add-repo "https://download.docker.com/linux/rhel/docker-ce.repo"
                yum install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
            else
                log_error "No supported package manager found (dnf or yum required)"
                exit 1
            fi
            run_systemctl enable docker
            run_systemctl start docker
            ;;
        opensuse-leap|opensuse-tumbleweed|sles)
            zypper -q install -y docker docker-compose-plugin
            run_systemctl enable docker
            run_systemctl start docker
            ;;
        arch|manjaro|endeavouros)
            pacman -Sy --noconfirm docker
            run_systemctl enable docker
            run_systemctl start docker
            ;;
        alpine)
            apk add docker docker-compose
            rc-update add docker default
            rc-service docker start
            log_warn "Alpine uses OpenRC, not systemd. Service management differs."
            ;;
        *)
            log_error "Unsupported Linux distribution: $DISTRO"
            log_error "Please install Docker manually: https://docs.docker.com/engine/install/"
            exit 1
            ;;
    esac

    log_info "Docker installed successfully"
}

# Create user if not exists
create_user() {
    if id "$USER" >/dev/null 2>&1; then
        log_info "User '$USER' already exists"
        return
    fi

    log_info "Creating system user: ${USER}"
    useradd --system --home-dir "${DATA_DIR}" --shell /bin/false --user-group "${USER}" 2>/dev/null || \
    adduser --system --home "${DATA_DIR}" --shell /bin/false --group "${USER}" 2>/dev/null || {
        log_error "Failed to create user '$USER'"
        exit 1
    }

    if getent group docker >/dev/null 2>&1; then
        usermod -aG docker "${USER}"
        log_info "Added ${USER} to docker group"
    fi
}

# Create directories with proper ownership and permissions
create_directories() {
    log_info "Creating directories..."
    
    # Create all directories first
    mkdir -p "${INSTALL_DIR}" "${CONFIG_DIR}" "${DATA_DIR}" "${DATA_DIR}/apps" "${DATA_DIR}/backups" "${LOG_DIR}" "${CONFIG_DIR}/caddy/certs"
    
    # Set ownership - explicitly for each directory
    chown "${USER}:${USER}" "${INSTALL_DIR}"
    chown "${USER}:${USER}" "${CONFIG_DIR}"
    chown -R "${USER}:${USER}" "${DATA_DIR}"
    chown "${USER}:${USER}" "${LOG_DIR}"
    chown -R "${USER}:${USER}" "${CONFIG_DIR}/caddy"
    
    # Set permissions
    # - INSTALL_DIR: readable by all, writable by user (for catalog updates)
    chmod 755 "${INSTALL_DIR}"
    # - CONFIG_DIR: restricted (contains secrets)
    chmod 750 "${CONFIG_DIR}"
    # - DATA_DIR: restricted (contains app data)
    chmod 700 "${DATA_DIR}" "${DATA_DIR}/apps" "${DATA_DIR}/backups"
    # - LOG_DIR: readable by user, writable by service
    chmod 750 "${LOG_DIR}"
    # - Caddy dirs: writable by service for config/cert generation
    chmod 750 "${CONFIG_DIR}/caddy"
    chmod 700 "${CONFIG_DIR}/caddy/certs"
    
    # Verify writability as the target user
    log_info "Verifying directory permissions..."
    local check_failed=false
    
    for dir in "${CONFIG_DIR}" "${DATA_DIR}" "${LOG_DIR}" "${CONFIG_DIR}/caddy"; do
        if ! su -s /bin/sh "${USER}" -c "test -w ${dir}" 2>/dev/null; then
            log_error "Directory ${dir} is not writable by ${USER}"
            check_failed=true
        fi
    done
    
    if [ "$check_failed" = true ]; then
        log_error "Permission verification failed. Check that ${USER} user exists and has correct ownership."
        ls -ld "${INSTALL_DIR}" "${CONFIG_DIR}" "${DATA_DIR}" "${LOG_DIR}"
        exit 1
    fi
    
    log_info "Directory permissions verified"
}

# Prompt for version
prompt_version() {
    log_info "Version Selection"
    echo ""
    echo "Available options:"
    echo "  - latest: Install the latest stable release (recommended)"
    echo "  - <version>: Install specific version (e.g., v0.0.0)"
    echo ""

    if [ -t 0 ] || [ -c /dev/tty ]; then
        while true; do
            echo -n "Enter version to install [latest]: "
            read -r version_input < /dev/tty 2>/dev/null || read -r version_input
            version_input="${version_input:-latest}"

            if [ "$version_input" = "latest" ]; then
                get_latest_release
                INSTALL_VERSION="$LATEST_RELEASE"
                return
            elif [[ "$version_input" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9]+)?$ ]]; then
                INSTALL_VERSION="$version_input"
                log_info "Installing version: ${INSTALL_VERSION}"
                return
            else
                log_error "Invalid version format. Use 'latest' or a version like v0.0.0"
            fi
        done
    else
        log_info "No TTY available, using latest release"
        get_latest_release
        INSTALL_VERSION="$LATEST_RELEASE"
    fi
}

# Get latest release version
get_latest_release() {
    log_info "Fetching latest release information..."
    local response
    response=$(curl -sf "${GITEA_URL}/api/v1/repos/${GITHUB_REPO}/releases?limit=1&sort=created&direction=desc") || {
        log_error "Failed to fetch releases from Gitea API"
        exit 1
    }

    if [ -z "$response" ] || [ "$response" = "[]" ]; then
        log_error "No releases found"
        exit 1
    fi

    if command -v jq >/dev/null 2>&1; then
        LATEST_RELEASE=$(echo "$response" | jq -r '.[0].tag_name // empty')
    else
        LATEST_RELEASE=$(echo "$response" | grep -o '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | cut -d'"' -f4)
    fi

    if [ -z "$LATEST_RELEASE" ]; then
        log_error "Could not parse release version from API response"
        log_error "Response: $response"
        exit 1
    fi

    log_info "Latest release: ${LATEST_RELEASE}"
}

# Download and install binary
download_binary() {
    BINARY_NAME="libreserv-${OS}-${ARCH}"
    DOWNLOAD_URL="${GITEA_URL}/${GITHUB_REPO}/releases/download/${INSTALL_VERSION}/${BINARY_NAME}"
    CHECKSUM_URL="${GITEA_URL}/${GITHUB_REPO}/releases/download/${INSTALL_VERSION}/SHA256SUMS.txt"

    if [ "$NO_SYSTEMD" = false ] && systemctl is-active --quiet "${SERVICE_NAME}" 2>/dev/null; then
        log_info "Stopping existing service..."
        run_systemctl stop "${SERVICE_NAME}"
    fi

    log_info "Downloading ${BINARY_NAME}..."
    if ! curl -fsSL "${DOWNLOAD_URL}" -o "${INSTALL_DIR}/libreserv"; then
        log_error "Failed to download binary from ${DOWNLOAD_URL}"
        return 1
    fi

    log_info "Downloading checksums..."
    if curl -fsSL "${CHECKSUM_URL}" -o "/tmp/SHA256SUMS.txt" 2>/dev/null; then
        log_info "Verifying checksum..."
        EXPECTED_HASH=$(grep "  ${BINARY_NAME}$" /tmp/SHA256SUMS.txt | awk '{print $1}')
        if [ -z "$EXPECTED_HASH" ]; then
            log_warn "Checksum not found for ${BINARY_NAME}, skipping verification"
        else
            ACTUAL_HASH=$(sha256sum "${INSTALL_DIR}/libreserv" | awk '{print $1}')
            if [ "$EXPECTED_HASH" != "$ACTUAL_HASH" ]; then
                log_error "Checksum verification failed!"
                log_error "Expected: ${EXPECTED_HASH}"
                log_error "Got:      ${ACTUAL_HASH}"
                rm -f "${INSTALL_DIR}/libreserv"
                return 1
            fi
            log_info "Checksum verified"
        fi
        rm -f /tmp/SHA256SUMS.txt
    else
        log_error "Could not download checksums. Verification is required for security. Check your network connection and that the release includes SHA256SUMS.txt"
        exit 1
    fi

    chmod +x "${INSTALL_DIR}/libreserv"
    ln -sf "${INSTALL_DIR}/libreserv" "${BIN_DIR}/libreserv"
}

# Download restic binary for restic-based backups
download_restic() {
    local restic_dir="${DATA_DIR}/bin"
    local restic_path="${restic_dir}/restic"

    if [ -x "${restic_path}" ]; then
        log_info "restic already installed at ${restic_path}"
        return
    fi

    log_info "Downloading restic ${RESTIC_VERSION} for ${OS}/${ARCH}..."
    mkdir -p "${restic_dir}"

    local url="https://github.com/restic/restic/releases/download/v${RESTIC_VERSION}/restic_${RESTIC_VERSION}_linux_${ARCH}.bz2"
    if ! curl -fsSL "${url}" | bzip2 -d > "${restic_path}.tmp" 2>/dev/null; then
        rm -f "${restic_path}.tmp"
        log_warn "Failed to download restic; incremental backups will require manual installation"
        log_warn "Install restic manually: https://restic.net/downloads/"
        return
    fi

    chmod +x "${restic_path}.tmp"
    mv "${restic_path}.tmp" "${restic_path}"
    chown "${USER}:${USER}" "${restic_path}"
    log_info "restic ${RESTIC_VERSION} installed to ${restic_path}"
}

# Download and extract the app catalog
download_catalog() {
    CATALOG_URL="${GITEA_URL}/${GITHUB_REPO}/releases/download/${INSTALL_VERSION}/catalog.tar.gz"
    CATALOG_DIR="${INSTALL_DIR}/catalog"

    mkdir -p "${CATALOG_DIR}"

    log_info "Downloading app catalog..."
    if curl -fsSL "${CATALOG_URL}" -o "/tmp/catalog.tar.gz" 2>/dev/null; then
        tar -xzf /tmp/catalog.tar.gz -C "${CATALOG_DIR}" --exclude='..'
        rm -f /tmp/catalog.tar.gz
        chown -R "${USER}:${USER}" "${CATALOG_DIR}"
        chmod 755 "${CATALOG_DIR}"
        log_info "App catalog installed"
    else
        rm -f /tmp/catalog.tar.gz
        log_warn "App catalog not available for this release"
        log_warn "The app catalog will be empty. You can install apps after updating to a release that includes the catalog."
        # Create empty builtin dir so the app doesn't crash on startup
        mkdir -p "${CATALOG_DIR}/builtin"
        chown -R "${USER}:${USER}" "${CATALOG_DIR}"
        chmod 755 "${CATALOG_DIR}"
    fi
}

# Create default config
create_config() {
    if [ -f "${CONFIG_DIR}/libreserv.yaml" ]; then
        log_info "Configuration file already exists, preserving"
        # Ensure correct ownership even if file existed
        chown "${USER}:${USER}" "${CONFIG_DIR}/libreserv.yaml"
        chmod 640 "${CONFIG_DIR}/libreserv.yaml"
        return
    fi

    log_info "Creating default configuration..."
    JWT_SECRET="$(openssl rand -hex 32)"
    CSRF_SECRET="$(openssl rand -hex 32)"

    cat > "${CONFIG_DIR}/libreserv.yaml" <<EOF
# LibreServ Configuration
# All paths and settings have code defaults — this file only contains secrets.
# DB-backed settings (logging.level, smtp.*, server.mode, etc.) must be
# changed via the Settings UI — editing this file has no effect after first boot.

auth:
  jwt_secret: "${JWT_SECRET}"
  csrf_secret: "${CSRF_SECRET}"
EOF

    # Explicitly set ownership and permissions on config file
    chown "${USER}:${USER}" "${CONFIG_DIR}/libreserv.yaml"
    chmod 640 "${CONFIG_DIR}/libreserv.yaml"
}

# Create systemd service
create_systemd_service() {
    if [ "$NO_SYSTEMD" = true ] || ! command -v systemctl >/dev/null 2>&1; then
        if [ "$NO_SYSTEMD" = true ]; then
            log_warn "--no-systemd specified. Skipping systemd service creation."
            log_warn "--no-systemd is for TESTING only. Production deployments require systemd."
        else
            log_warn "systemctl not found. Skipping systemd service creation."
            log_warn "You will need to configure the service manually."
            log_warn "Tip: pass --no-systemd to skip this (for TESTING only, not for production)."
        fi
        return
    fi

    log_info "Creating systemd service..."
    cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=LibreServ Platform
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
User=${USER}
Group=${USER}
WorkingDirectory=${INSTALL_DIR}
ExecStart=${BIN_DIR}/libreserv --config ${CONFIG_DIR}/libreserv.yaml
Restart=always
RestartSec=10

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${DATA_DIR} ${LOG_DIR} ${INSTALL_DIR} ${CONFIG_DIR}
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

    run_systemctl daemon-reload
}

# Verify service starts successfully
verify_service() {
    if [ "$NO_SYSTEMD" = true ]; then
        log_info "LibreServ binary installed to ${BIN_DIR}/libreserv"
        log_info "Run manually: sudo -u ${USER} ${BIN_DIR}/libreserv --config ${CONFIG_DIR}/libreserv.yaml"
        log_warn "--no-systemd mode is for TESTING ONLY. Production deployments require systemd."
        return 0
    fi

    log_info "Starting LibreServ service..."
    run_systemctl enable "${SERVICE_NAME}"
    run_systemctl start "${SERVICE_NAME}"

    log_info "Waiting for service to be ready..."
    sleep 3

    if run_systemctl is-active --quiet "${SERVICE_NAME}"; then
        log_info "Service started successfully!"
        return 0
    else
        log_error "Service failed to start. Checking logs..."
        journalctl -u "${SERVICE_NAME}" --no-pager -n 20
        return 1
    fi
}

# Verify all permissions before starting service
verify_permissions() {
    log_info "Verifying file permissions..."
    local failed=false
    
    # Check directories
    for dir in "${INSTALL_DIR}" "${CONFIG_DIR}" "${DATA_DIR}" "${LOG_DIR}" "${CONFIG_DIR}/caddy"; do
        if [ ! -d "$dir" ]; then
            log_error "Directory missing: $dir"
            failed=true
            continue
        fi
        
        local owner
        owner=$(stat -c '%U:%G' "$dir" 2>/dev/null || stat -f '%Su:%Sg' "$dir" 2>/dev/null)
        if [ "$owner" != "${USER}:${USER}" ]; then
            log_error "Directory $dir owned by $owner (expected ${USER}:${USER})"
            failed=true
        fi
    done
    
    # Check config file
    if [ -f "${CONFIG_DIR}/libreserv.yaml" ]; then
        local cfg_owner
        cfg_owner=$(stat -c '%U:%G' "${CONFIG_DIR}/libreserv.yaml" 2>/dev/null || stat -f '%Su:%Sg' "${CONFIG_DIR}/libreserv.yaml" 2>/dev/null)
        if [ "$cfg_owner" != "${USER}:${USER}" ]; then
            log_error "Config file owned by $cfg_owner (expected ${USER}:${USER})"
            failed=true
        fi
    fi
    
    # Check binary
    if [ -x "${INSTALL_DIR}/libreserv" ]; then
        local bin_owner
        bin_owner=$(stat -c '%U:%G' "${INSTALL_DIR}/libreserv" 2>/dev/null || stat -f '%Su:%Sg' "${INSTALL_DIR}/libreserv" 2>/dev/null)
        if [ "$bin_owner" != "root:root" ]; then
            log_warn "Binary owned by $bin_owner (expected root:root)"
        fi
    else
        log_error "Binary not found or not executable: ${INSTALL_DIR}/libreserv"
        failed=true
    fi
    
    if [ "$failed" = true ]; then
        log_error "Permission verification failed"
        log_info "Directory listing:"
        ls -ld "${INSTALL_DIR}" "${CONFIG_DIR}" "${DATA_DIR}" "${LOG_DIR}" "${CONFIG_DIR}/caddy" "${CONFIG_DIR}/caddy/certs" 2>&1 || true
        return 1
    fi
    
    log_info "All permissions verified"
    return 0
}

# Get IP address for post-install message (portable)
get_ip_address() {
    local ip=""
    if command -v hostname >/dev/null 2>&1; then
        ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
    fi
    if [ -z "$ip" ] && command -v ip >/dev/null 2>&1; then
        ip="$(ip route get 1 2>/dev/null | awk '{print $7; exit}')"
    fi
    if [ -z "$ip" ]; then
        ip="<device-ip>"
    fi
    echo "$ip"
}

# Print post-install instructions
print_post_install() {
    local ip
    ip="$(get_ip_address)"

    echo ""
    echo -e "${GREEN}========================================${NC}"
    echo -e "${GREEN}  LibreServ Installation Complete!${NC}"
    echo -e "${GREEN}========================================${NC}"
    echo ""
    echo -e "Installed version: ${BLUE}${INSTALL_VERSION}${NC}"
    echo ""
    echo -e "Next steps:"
    echo ""
    echo -e "  1. Open your browser and navigate to:"
    echo -e "     ${BLUE}http://${ip}:8080${NC}"
    echo ""
    echo -e "  2. Complete the setup wizard to create your admin account"
    echo ""
    echo -e "  3. Install your first app from the catalog"
    echo ""
    echo -e "Service commands:"
    if [ "$NO_SYSTEMD" = true ]; then
        echo -e "   Run:    ${YELLOW}sudo -u ${USER} ${BIN_DIR}/libreserv --config ${CONFIG_DIR}/libreserv.yaml${NC}"
        echo -e "   Logs:   ${YELLOW}tail -f ${LOG_DIR}/libreserv.log${NC}"
        echo ""
        echo -e "   ${YELLOW}--no-systemd is for TESTING only. Use systemctl in production.${NC}"
    else
        echo -e "   Status:  ${YELLOW}systemctl status ${SERVICE_NAME}${NC}"
        echo -e "   Stop:    ${YELLOW}systemctl stop ${SERVICE_NAME}${NC}"
        echo -e "   Restart: ${YELLOW}systemctl restart ${SERVICE_NAME}${NC}"
        echo -e "   Logs:    ${YELLOW}journalctl -u ${SERVICE_NAME} -f${NC}"
    fi
    echo ""
    echo -e "Configuration: ${CONFIG_DIR}/libreserv.yaml"
    echo -e "Data directory: ${DATA_DIR}"
    echo -e "Logs: ${LOG_DIR}"
    echo ""
    echo -e "To upgrade: ${YELLOW}curl -fsSL https://gt.plainskill.net/LibreLoom/LibreServ/raw/branch/main/install.sh -o install.sh && sudo bash install.sh --upgrade && rm install.sh${NC}"
    echo -e "To uninstall: ${YELLOW}curl -fsSL https://gt.plainskill.net/LibreLoom/LibreServ/raw/branch/main/install.sh -o install.sh && sudo bash install.sh --uninstall && rm install.sh${NC}"
    echo ""
}

# Upgrade existing installation
do_upgrade() {
    check_root
    log_info "Upgrading LibreServ..."

    if [ ! -f "${BIN_DIR}/libreserv" ]; then
        log_error "LibreServ is not installed. Use regular installation instead."
        exit 1
    fi

    BACKUP_BINARY="${INSTALL_DIR}/libreserv.bak"
    if [ -f "${INSTALL_DIR}/libreserv" ]; then
        log_info "Backing up current binary..."
        cp "${INSTALL_DIR}/libreserv" "${BACKUP_BINARY}"
    fi

    run_systemctl stop "${SERVICE_NAME}" 2>/dev/null || true

    create_directories
    get_latest_release
    INSTALL_VERSION="$LATEST_RELEASE"

    if ! download_binary; then
        log_error "Download failed. Restoring previous binary..."
        if [ -f "${BACKUP_BINARY}" ]; then
            cp "${BACKUP_BINARY}" "${INSTALL_DIR}/libreserv"
            chmod +x "${INSTALL_DIR}/libreserv"
            ln -sf "${INSTALL_DIR}/libreserv" "${BIN_DIR}/libreserv"
            log_info "Previous binary restored"
            run_systemctl start "${SERVICE_NAME}" 2>/dev/null || true
        fi
        exit 1
    fi

    download_catalog
    download_restic

    rm -f "${BACKUP_BINARY}"

    log_info "Reloading systemd..."
    run_systemctl daemon-reload

    log_info "Starting service..."
    if verify_service; then
        log_info "Upgrade completed successfully!"
    else
        log_error "Upgrade failed. Service may not be running."
        log_error "Previous binary backup was removed after successful download."
        exit 1
    fi
}

# Uninstall LibreServ
do_uninstall() {
    check_root
    log_warn "Uninstalling LibreServ..."
    log_info "Data in ${DATA_DIR} will be preserved"

    log_info "Stopping service..."
    run_systemctl stop "${SERVICE_NAME}" 2>/dev/null || true
    run_systemctl disable "${SERVICE_NAME}" 2>/dev/null || true

    log_info "Removing files..."
    rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
    rm -f "${BIN_DIR}/libreserv"
    rm -rf "${INSTALL_DIR}"

    run_systemctl daemon-reload

    echo ""
    log_info "LibreServ has been uninstalled"
    log_info "Data preserved in: ${DATA_DIR}"
    log_info "Config preserved in: ${CONFIG_DIR}"
    log_info "To completely remove, run: rm -rf ${DATA_DIR} ${CONFIG_DIR} ${LOG_DIR}"
}

# Main installation
do_install() {
    print_banner
    check_root
    check_dependencies
    detect_system

    install_docker

    create_user
    create_directories

    prompt_version
    download_binary
    download_catalog
    download_restic
    create_config

    create_systemd_service

    if verify_permissions; then
        if verify_service; then
            print_post_install
        else
            log_error "Installation completed but service failed to start"
            if [ "$NO_SYSTEMD" = true ]; then
                log_error "Run manually: sudo -u ${USER} ${BIN_DIR}/libreserv --config ${CONFIG_DIR}/libreserv.yaml"
            else
                log_error "Check logs with: journalctl -u ${SERVICE_NAME} -n 50"
            fi
            exit 1
        fi
    else
        log_error "Permission verification failed. Not starting service."
        if [ "$NO_SYSTEMD" = true ]; then
            log_error "Fix permissions and run: sudo -u ${USER} ${BIN_DIR}/libreserv --config ${CONFIG_DIR}/libreserv.yaml"
        else
            log_error "Fix permissions and run: systemctl start ${SERVICE_NAME}"
        fi
        exit 1
    fi
}

# Parse arguments
DO_HELP=false
DO_UNINSTALL=false
DO_UPGRADE=false
for arg in "$@"; do
    case "$arg" in
        --no-systemd) NO_SYSTEMD=true ;;
        --uninstall) DO_UNINSTALL=true ;;
        --upgrade) DO_UPGRADE=true ;;
        --help|-h) DO_HELP=true ;;
    esac
done

if [ "$DO_HELP" = true ]; then
    print_help
elif [ "$DO_UNINSTALL" = true ]; then
    do_uninstall
elif [ "$DO_UPGRADE" = true ]; then
    do_upgrade
else
    do_install
fi

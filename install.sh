#!/bin/bash
set -e

# LibreServ Installation Script
# Usage: curl -fsSL https://gt.plainskill.net/libreloom/libreserv/raw/branch/main/install.sh | sudo sh
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

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

print_banner() {
    echo -e "${BLUE}"
    echo "  _     _ _                       _ "
    echo " | |   (_| |______ _ __ ___   ___| |"
    echo " | |   | | '_/ _  | '_ \` _ \\ / _ \\ |"
    echo " | |___| | | | (_| | | | | | |  __/ |"
    echo " |_____|_|_|  \\__,_|_| |_| |_|\\___|_|"
    echo -e "${NC}"
    echo ""
}

print_help() {
    echo "LibreServ Installation Script"
    echo ""
    echo "Usage: curl -fsSL https://gt.plainskill.net/libreloom/libreserv/raw/branch/main/install.sh | sudo sh"
    echo ""
    echo "Options:"
    echo "  --uninstall    Remove LibreServ (preserves data in ${DATA_DIR})"
    echo "  --upgrade      Upgrade existing installation (preserves data and config)"
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

# Install Docker if needed
install_docker() {
    if command -v docker >/dev/null 2>&1; then
        log_info "Docker is already installed: $(docker --version)"
        return
    fi

    log_info "Installing Docker..."

    if [ -f /etc/os-release ]; then
        . /etc/os-release
        DISTRO=$ID
    else
        log_error "Cannot detect Linux distribution"
        exit 1
    fi

    case "$DISTRO" in
        ubuntu|debian)
            apt-get update -qq
            apt-get install -y -qq ca-certificates curl gnupg
            install -m 0755 -d /etc/apt/keyrings
            curl -fsSL https://download.docker.com/linux/${DISTRO}/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
            chmod a+r /etc/apt/keyrings/docker.gpg
            echo "deb [arch=${ARCH} signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/${DISTRO} $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null
            apt-get update -qq
            apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
            systemctl enable docker
            systemctl start docker
            ;;
        fedora|rhel|centos)
            dnf -y -q install dnf-plugins-core
            dnf config-manager --add-repo https://download.docker.com/linux/fedora/docker-ce.repo
            dnf install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
            systemctl enable docker
            systemctl start docker
            ;;
        arch)
            pacman -Sy --noconfirm --quiet docker
            systemctl enable docker
            systemctl start docker
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
    useradd --system --home-dir ${DATA_DIR} --shell /bin/false ${USER}
}

# Create directories
create_directories() {
    log_info "Creating directories..."
    mkdir -p ${INSTALL_DIR} ${CONFIG_DIR} ${DATA_DIR} ${DATA_DIR}/apps ${DATA_DIR}/backups ${LOG_DIR}
    chown -R ${USER}:${USER} ${INSTALL_DIR} ${DATA_DIR} ${LOG_DIR}
    chmod 700 ${DATA_DIR}
}

# Get latest release version
get_latest_release() {
    log_info "Fetching latest release information..."
    LATEST_RELEASE=$(curl -s "${GITEA_URL}/api/v1/repos/${GITHUB_REPO}/releases?limit=1" | grep -oP '"tag_name": "\K[^"]+')

    if [ -z "$LATEST_RELEASE" ]; then
        log_error "Could not determine latest release version"
        exit 1
    fi

    log_info "Latest release: ${LATEST_RELEASE}"
}

# Download and install binary
download_binary() {
    BINARY_NAME="libreserv-${OS}-${ARCH}"
    DOWNLOAD_URL="${GITEA_URL}/libreloom/libreserv/releases/download/${LATEST_RELEASE}/${BINARY_NAME}"
    CHECKSUM_URL="${GITEA_URL}/libreloom/libreserv/releases/download/${LATEST_RELEASE}/SHA256SUMS.txt"

    log_info "Downloading ${BINARY_NAME}..."
    curl -sL "${DOWNLOAD_URL}" -o "${INSTALL_DIR}/libreserv"
    
    log_info "Downloading checksums..."
    curl -sL "${CHECKSUM_URL}" -o "/tmp/SHA256SUMS.txt"
    
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
            exit 1
        fi
        log_info "Checksum verified"
    fi
    
    rm -f /tmp/SHA256SUMS.txt
    chmod +x "${INSTALL_DIR}/libreserv"
    ln -sf "${INSTALL_DIR}/libreserv" "${BIN_DIR}/libreserv"
}

# Create default config
create_config() {
    if [ -f "${CONFIG_DIR}/libreserv.yaml" ]; then
        log_info "Configuration file already exists, preserving"
        return
    fi

    log_info "Creating default configuration..."
    cat <<EOF > "${CONFIG_DIR}/libreserv.yaml"
server:
  host: "0.0.0.0"
  port: 8080
  mode: "production"

database:
  path: "${DATA_DIR}/libreserv.db"

apps:
  data_path: "${DATA_DIR}/apps"
  catalog_path: "${INSTALL_DIR}/catalog"

logging:
  level: "info"
  format: "json"
  file: "${LOG_DIR}/libreserv.log"

auth:
  jwt_secret: "$(openssl rand -hex 32)"
  csrf_secret: "$(openssl rand -hex 32)"
EOF

    chown -R ${USER}:${USER} ${CONFIG_DIR}
}

# Create systemd service
create_systemd_service() {
    log_info "Creating systemd service..."
    cat <<EOF > /etc/systemd/system/${SERVICE_NAME}.service
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
ReadWritePaths=${DATA_DIR} ${LOG_DIR}
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

    systemctl daemon-reload
}

# Verify service starts successfully
verify_service() {
    log_info "Starting LibreServ service..."
    systemctl enable ${SERVICE_NAME}
    systemctl start ${SERVICE_NAME}

    log_info "Waiting for service to be ready..."
    sleep 3

    if systemctl is-active --quiet ${SERVICE_NAME}; then
        log_info "Service started successfully!"
        return 0
    else
        log_error "Service failed to start. Checking logs..."
        journalctl -u ${SERVICE_NAME} --no-pager -n 20
        return 1
    fi
}

# Print post-install instructions
print_post_install() {
    echo ""
    echo -e "${GREEN}========================================${NC}"
    echo -e "${GREEN}  LibreServ Installation Complete!${NC}"
    echo -e "${GREEN}========================================${NC}"
    echo ""
    echo -e "Installed version: ${BLUE}${LATEST_RELEASE}${NC}"
    echo ""
    echo -e "Next steps:"
    echo ""
    echo -e "  1. Open your browser and navigate to:"
    echo -e "     ${BLUE}http://$(hostname -I | awk '{print $1}'):8080${NC}"
    echo ""
    echo -e "  2. Complete the setup wizard to create your admin account"
    echo ""
    echo -e "  3. Install your first app from the catalog"
    echo ""
    echo -e "Service commands:"
    echo -e "   Status:  ${YELLOW}systemctl status ${SERVICE_NAME}${NC}"
    echo -e "   Stop:    ${YELLOW}systemctl stop ${SERVICE_NAME}${NC}"
    echo -e "   Restart: ${YELLOW}systemctl restart ${SERVICE_NAME}${NC}"
    echo -e "   Logs:    ${YELLOW}journalctl -u ${SERVICE_NAME} -f${NC}"
    echo ""
    echo -e "Configuration: ${CONFIG_DIR}/libreserv.yaml"
    echo -e "Data directory: ${DATA_DIR}"
    echo -e "Logs: ${LOG_DIR}"
    echo ""
    echo -e "To upgrade: ${YELLOW}curl -fsSL https://gt.plainskill.net/libreloom/libreserv/raw/branch/main/install.sh | sudo sh -s -- --upgrade${NC}"
    echo -e "To uninstall: ${YELLOW}curl -fsSL https://gt.plainskill.net/libreloom/libreserv/raw/branch/main/install.sh | sudo sh -s -- --uninstall${NC}"
    echo ""
}

# Upgrade existing installation
do_upgrade() {
    log_info "Upgrading LibreServ..."

    if [ ! -f "${BIN_DIR}/libreserv" ]; then
        log_error "LibreServ is not installed. Use regular installation instead."
        exit 1
    fi

    systemctl stop ${SERVICE_NAME} 2>/dev/null || true

    create_directories
    get_latest_release
    download_binary

    log_info "Reloading systemd..."
    systemctl daemon-reload

    log_info "Starting service..."
    systemctl start ${SERVICE_NAME}

    if verify_service; then
        log_info "Upgrade completed successfully!"
    else
        log_error "Upgrade failed. Service may not be running."
        exit 1
    fi
}

# Uninstall LibreServ
do_uninstall() {
    log_warn "Uninstalling LibreServ..."
    log_info "Data in ${DATA_DIR} will be preserved"

    log_info "Stopping service..."
    systemctl stop ${SERVICE_NAME} 2>/dev/null || true
    systemctl disable ${SERVICE_NAME} 2>/dev/null || true

    log_info "Removing files..."
    rm -f /etc/systemd/system/${SERVICE_NAME}.service
    rm -f ${BIN_DIR}/libreserv
    rm -rf ${INSTALL_DIR}

    systemctl daemon-reload

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
    detect_system

    install_docker

    create_user
    create_directories

    get_latest_release
    download_binary
    create_config

    create_systemd_service

    if verify_service; then
        print_post_install
    else
        log_error "Installation completed but service failed to start"
        log_error "Check logs with: journalctl -u ${SERVICE_NAME} -n 50"
        exit 1
    fi
}

# Parse arguments
case "${1:-}" in
    --uninstall)
        check_root
        do_uninstall
        ;;
    --upgrade)
        do_upgrade
        ;;
    --help|-h)
        print_help
        ;;
    *)
        do_install
        ;;
esac

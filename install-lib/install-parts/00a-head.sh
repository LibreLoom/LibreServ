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
FORGEJO_URL="https://gt.plainskill.net"
INSTALL_DIR="/opt/libreserv"
BIN_DIR="/usr/local/bin"
CONFIG_DIR="/etc/libreserv"
DATA_DIR="/var/lib/libreserv"
LOG_DIR="/var/log/libreserv"
USER="libreserv"
SERVICE_NAME="libreserv"
NO_SYSTEMD=false
RESTIC_VERSION="0.19.1"

# Baked-in LibreServ minisign public key (keys/libreserv.minisign.pub). Do not fetch this from Forgejo.
RELEASE_MINISIGN_PUB='untrusted comment: minisign public key 48EB64CB69EA36CD
RWTNNuppy2TrSN0svaVDgtJ4spfWLS9ZMvu6r103YVewyX4HAKfq3Rkt'

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

print_banner() {
    printf "${BLUE}"
    cat <<'BANNER'
       **   **                       ********                         
/**      // /**                     **//////                          
/**       **/**      ******  ***** /**         *****  ****** **    **
/**      /**/****** //**//* **///**/********* **///**//**//*/**   /**
/**      /**/**///** /** / /*******////////**/******* /** / //** /** 
/**      /**/**  /** /**   /**////        /**/**////  /**    //****   
/********/**/****** /***   //****** ******** //******/***     //**    
//////// // /////   ///     ////// ////////   /////////       //     
BANNER
    printf "${NC}\n"
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

    # Map derivatives to their parent distro for package repository purposes
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

# Install Podman if needed
install_runtime() {
    if command -v podman >/dev/null 2>&1; then
        log_info "Podman is already installed: $(podman --version)"
        return
    fi

    log_info "Installing Podman..."

    get_distro_info

    case "$DISTRO" in
        ubuntu|debian)
            apt-get update -qq
            apt-get install -y -qq podman podman-compose
            ;;
        fedora|rhel|centos)
            if command -v dnf >/dev/null 2>&1; then
                dnf install -y -q podman podman-compose
            elif command -v yum >/dev/null 2>&1; then
                yum install -y -q podman podman-compose
            else
                log_error "No supported package manager found (dnf or yum required)"
                exit 1
            fi
            ;;
        opensuse-leap|opensuse-tumbleweed|sles)
            zypper -q install -y podman podman-compose
            ;;
        arch|manjaro|endeavouros)
            pacman -Sy --noconfirm podman podman-compose
            ;;
        alpine)
            apk add podman podman-compose
            log_warn "Alpine uses OpenRC, not systemd. Service management differs."
            ;;
        *)
            log_error "Unsupported Linux distribution: $DISTRO"
            log_error "Please install Podman manually"
            exit 1
            ;;
    esac

    log_info "Podman installed successfully"
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


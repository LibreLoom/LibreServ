#!/bin/bash
set -e

# LibreServ Installation Script
# Usage: curl -fsSL https://gt.plainskill.net/libreloom/libreserv/raw/branch/main/install.sh | sudo sh

GITHUB_REPO="libreloom/libreserv"
GITEA_URL="https://gt.plainskill.net"
INSTALL_DIR="/opt/libreserv"
BIN_DIR="/usr/local/bin"
CONFIG_DIR="/etc/libreserv"
DATA_DIR="/var/lib/libreserv"
USER="libreserv"

# Detect OS and Architecture
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "$ARCH" in
    x86_64) ARCH="amd64" ;;
    aarch64|arm64) ARCH="arm64" ;;
    *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac

if [ "$OS" != "linux" ] && [ "$OS" != "darwin" ]; then
    echo "Unsupported OS: $OS"
    exit 1
fi

echo ">> Installing LibreServ for ${OS}/${ARCH}..."

# Create user if not exists
if ! id "$USER" >/dev/null 2>&1; then
    echo ">> Creating system user: ${USER}"
    useradd --system --home-dir ${DATA_DIR} --shell /bin/false ${USER}
fi

# Create directories
echo ">> Creating directories..."
mkdir -p ${INSTALL_DIR} ${CONFIG_DIR} ${DATA_DIR} ${DATA_DIR}/apps ${DATA_DIR}/backups
chown -R ${USER}:${USER} ${INSTALL_DIR} ${DATA_DIR}
chmod 700 ${DATA_DIR}

# Get latest release from Gitea
echo ">> Fetching latest release information..."
LATEST_RELEASE=$(curl -s "${GITEA_URL}/api/v1/repos/${GITHUB_REPO}/releases?limit=1" | grep -oP '"tag_name": "\K[^"]+')

if [ -z "$LATEST_RELEASE" ]; then
    echo "Error: Could not determine latest release version."
    exit 1
fi

echo ">> Latest release: ${LATEST_RELEASE}"

# Download binary
BINARY_NAME="libreserv-${OS}-${ARCH}"
DOWNLOAD_URL="${GITEA_URL}/libreloom/libreserv/releases/download/${LATEST_RELEASE}/${BINARY_NAME}"

echo ">> Downloading ${BINARY_NAME}..."
curl -L "${DOWNLOAD_URL}" -o "${INSTALL_DIR}/libreserv"
chmod +x "${INSTALL_DIR}/libreserv"
ln -sf "${INSTALL_DIR}/libreserv" "${BIN_DIR}/libreserv"

# Create default config if not exists
if [ ! -f "${CONFIG_DIR}/libreserv.yaml" ]; then
    echo ">> Creating default configuration..."
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
  file: "/var/log/libreserv/libreserv.log"

auth:
  jwt_secret: "$(openssl rand -hex 32)"
  csrf_secret: "$(openssl rand -hex 32)"
EOF
    mkdir -p /var/log/libreserv
    chown -R ${USER}:${USER} ${CONFIG_DIR} /var/log/libreserv
fi

# Set up systemd service (Linux only)
if [ "$OS" == "linux" ] && [ -d "/etc/systemd/system" ]; then
    echo ">> Setting up systemd service..."
    cat <<EOF > /etc/systemd/system/libreserv.service
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

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    echo ">> Installation complete! Start with: systemctl start libreserv"
fi

echo ">> LibreServ ${LATEST_RELEASE} installed successfully."

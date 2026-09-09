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

# Get latest LibreServ release (tag vX.Y.Z only — skip luna-v* and connect-v*)
get_latest_release() {
    log_info "Fetching latest release information..."
    local response
    response=$(curl -sf "${FORGEJO_URL}/api/v1/repos/${GITHUB_REPO}/releases?limit=50&sort=created&direction=desc") || {
        log_error "Failed to fetch releases from Forgejo API"
        exit 1
    }

    if [ -z "$response" ] || [ "$response" = "[]" ]; then
        log_error "No releases found"
        exit 1
    fi

    if command -v jq >/dev/null 2>&1; then
        LATEST_RELEASE=$(echo "$response" | jq -r '[.[] | select(.draft == false and .prerelease == false and (.tag_name | test("^v[0-9]+\\.[0-9]+\\.[0-9]+")))] | .[0].tag_name // empty')
    elif command -v python3 >/dev/null 2>&1; then
        LATEST_RELEASE=$(printf '%s' "$response" | python3 -c '
import json, re, sys
pat = re.compile(r"^v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.]+)?$")
for r in json.load(sys.stdin):
    if r.get("draft") or r.get("prerelease"):
        continue
    t = r.get("tag_name") or ""
    if pat.match(t):
        print(t)
        break
')
    else
        LATEST_RELEASE=$(echo "$response" | grep -o '"tag_name"[[:space:]]*:[[:space:]]*"v[0-9][^"]*"' | head -1 | cut -d'"' -f4)
    fi

    if [ -z "$LATEST_RELEASE" ]; then
        log_error "Could not parse a LibreServ v* release from the API"
        log_error "Response: $response"
        exit 1
    fi

    log_info "Latest release: ${LATEST_RELEASE}"
}

# Download and install binary.
# Verify signature + checksum on a temp file first; only then replace the
# installed binary. Failures return (do not exit) so --upgrade can restore.
download_binary() {
    BINARY_NAME="libreserv-${OS}-${ARCH}"
    DOWNLOAD_URL="${FORGEJO_URL}/${GITHUB_REPO}/releases/download/${INSTALL_VERSION}/${BINARY_NAME}"
    CHECKSUM_URL="${FORGEJO_URL}/${GITHUB_REPO}/releases/download/${INSTALL_VERSION}/SHA256SUMS.txt"
    SIG_URL="${CHECKSUM_URL}.minisig"

    mkdir -p "${INSTALL_DIR}"

    local tmp_bin tmp_sums tmp_sig pub_file
    tmp_bin="$(mktemp "${INSTALL_DIR}/.libreserv.download.XXXXXX")"
    tmp_sums="$(mktemp)"
    tmp_sig="$(mktemp)"
    pub_file=""

    cleanup_download_temps() {
        [ -n "${tmp_bin}" ] && rm -f "${tmp_bin}"
        [ -n "${tmp_sums}" ] && rm -f "${tmp_sums}"
        [ -n "${tmp_sig}" ] && rm -f "${tmp_sig}"
        [ -n "${pub_file}" ] && rm -f "${pub_file}"
        return 0
    }

    log_info "Downloading ${BINARY_NAME}..."
    if ! curl -fsSL "${DOWNLOAD_URL}" -o "${tmp_bin}"; then
        log_error "Failed to download binary from ${DOWNLOAD_URL}"
        cleanup_download_temps
        return 1
    fi

    log_info "Downloading checksums..."
    if ! curl -fsSL "${CHECKSUM_URL}" -o "${tmp_sums}"; then
        log_error "Could not download checksums. This install needs SHA256SUMS.txt from the release."
        cleanup_download_temps
        return 1
    fi
    if ! curl -fsSL "${SIG_URL}" -o "${tmp_sig}"; then
        log_error "Could not download the checksum signature. That file proves the download is from us, not whoever owns the download host."
        cleanup_download_temps
        return 1
    fi

    if ! command -v minisign >/dev/null 2>&1; then
        log_error "minisign is required to verify this download."
        log_error "Install it, then run this installer again:"
        log_error "  Arch:    pacman -S minisign"
        log_error "  Fedora:  dnf install minisign"
        log_error "  Debian:  apt install minisign"
        log_error "  Alpine:  apk add minisign"
        cleanup_download_temps
        return 1
    fi

    pub_file="$(mktemp)"
    printf '%s\n' "${RELEASE_MINISIGN_PUB}" > "${pub_file}"
    if ! minisign -V -q -p "${pub_file}" -m "${tmp_sums}" -x "${tmp_sig}"; then
        log_error "The checksum file was not signed by LibreServ. Nothing was installed."
        cleanup_download_temps
        return 1
    fi
    rm -f "${pub_file}"
    pub_file=""

    log_info "Verifying checksum..."
    EXPECTED_HASH=$(grep "  ${BINARY_NAME}$" "${tmp_sums}" | awk '{print $1}')
    if [ -z "$EXPECTED_HASH" ]; then
        log_error "Checksum not found for ${BINARY_NAME} in SHA256SUMS.txt"
        cleanup_download_temps
        return 1
    fi
    ACTUAL_HASH=$(sha256sum "${tmp_bin}" | awk '{print $1}')
    if [ "$EXPECTED_HASH" != "$ACTUAL_HASH" ]; then
        log_error "Checksum verification failed!"
        log_error "Expected: ${EXPECTED_HASH}"
        log_error "Got:      ${ACTUAL_HASH}"
        cleanup_download_temps
        return 1
    fi
    log_info "Checksum and signature verified"

    # Only stop / replace after the download has proven good.
    if [ "$NO_SYSTEMD" = false ] && systemctl is-active --quiet "${SERVICE_NAME}" 2>/dev/null; then
        log_info "Stopping existing service..."
        run_systemctl stop "${SERVICE_NAME}"
    fi

    chmod +x "${tmp_bin}"
    mv -f "${tmp_bin}" "${INSTALL_DIR}/libreserv"
    tmp_bin=""
    ln -sf "${INSTALL_DIR}/libreserv" "${BIN_DIR}/libreserv"
    cleanup_download_temps
}

# Download restic binary for restic-based backups via install-lib helper
# (sibling path only — no bash <(curl) of the helper).
download_restic() {
    local restic_dir="${DATA_DIR}/bin"
    local restic_path="${restic_dir}/restic"
    local root helper
    # Prefer repo root set by thin install.sh; else dirname of this script.
    root="${_INSTALL_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)}"
    case "${root}" in
        */install-lib/install-parts) root="$(cd "${root}/../.." && pwd)" ;;
    esac
    helper="${root}/install-lib/download-restic.sh"

    if [ ! -f "${helper}" ]; then
        log_warn "install-lib/download-restic.sh not found next to install.sh; skipping restic install"
        log_warn "Install restic manually: https://restic.net/downloads/"
        return
    fi

    log_info "Downloading restic ${RESTIC_VERSION} for ${OS}/${ARCH} (verified helper)..."
    mkdir -p "${restic_dir}"
    if ! RESTIC_OWNER="${USER}:${USER}" RESTIC_VERSION="${RESTIC_VERSION}" RESTIC_ARCH="${ARCH}" \
        bash "${helper}" "${restic_path}"; then
        log_warn "restic verified download failed; install manually: https://restic.net/downloads/"
        return
    fi
}


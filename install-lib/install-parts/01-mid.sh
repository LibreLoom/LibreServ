# Create catalog directory for repo-based apps
create_catalog_dir() {
    CATALOG_DIR="${INSTALL_DIR}/catalog"
    mkdir -p "${CATALOG_DIR}/apps"
    chown -R "${USER}:${USER}" "${CATALOG_DIR}"
    chmod 755 "${CATALOG_DIR}"
    log_info "App catalog directory created"
}

# Generate a 6-character no-ambiguous setup code
generate_setup_code() {
    local chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    local code=""
    for i in 1 2 3 4 5 6; do
        local byte
        byte=$(dd if=/dev/urandom bs=1 count=1 2>/dev/null | od -An -tu1 | tr -d ' ')
        code="${code}${chars:$((byte % ${#chars})):1}"
    done
    echo "$code"
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

server:
  host: "0.0.0.0"

auth:
  jwt_secret: "${JWT_SECRET}"
  csrf_secret: "${CSRF_SECRET}"
EOF

    # Explicitly set ownership and permissions on config file
    chown "${USER}:${USER}" "${CONFIG_DIR}/libreserv.yaml"
    chmod 640 "${CONFIG_DIR}/libreserv.yaml"

    # Generate setup code for the included card/documentation
    SETUP_CODE="$(generate_setup_code)"
    echo "$SETUP_CODE" > "${CONFIG_DIR}/setup-code"
    chown "${USER}:${USER}" "${CONFIG_DIR}/setup-code"
    chmod 640 "${CONFIG_DIR}/setup-code"
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
After=network.target

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


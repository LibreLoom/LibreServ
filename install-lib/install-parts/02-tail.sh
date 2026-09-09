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
    local setup_code
    if [ -f "${CONFIG_DIR}/setup-code" ]; then
        setup_code="$(cat "${CONFIG_DIR}/setup-code")"
    fi

    echo ""
    echo -e "${GREEN}========================================${NC}"
    echo -e "${GREEN}  LibreServ Installation Complete!${NC}"
    echo -e "${GREEN}========================================${NC}"
    echo ""
    echo -e "Installed version: ${BLUE}${INSTALL_VERSION}${NC}"
    echo ""

    if [ -n "$setup_code" ]; then
        echo -e "${YELLOW}┌─────────────────────────────────────────────┐${NC}"
        echo -e "${YELLOW}│                                               │${NC}"
        printf "${YELLOW}│${NC}  Setup code:  ${BLUE}%-6s${NC}                        ${YELLOW}│${NC}\n" "$setup_code"
        echo -e "${YELLOW}│                                               │${NC}"
        echo -e "${YELLOW}│  Write this down. You will need it to         ${NC}"
        echo -e "${YELLOW}│  complete the web setup.                      ${NC}"
        echo -e "${YELLOW}│                                               │${NC}"
        echo -e "${YELLOW}└─────────────────────────────────────────────┘${NC}"
        echo ""
    fi

    echo -e "Next steps:"
    echo ""
    echo -e "  1. Open your browser and navigate to:"
    ip_msg="http://${ip}:8080"
    echo -e "     ${BLUE}${ip_msg}${NC}"
    echo ""
    if [ -n "$setup_code" ]; then
        echo -e "  2. Enter the setup code: ${YELLOW}${setup_code}${NC}"
        echo ""
        echo -e "  3. Complete the setup wizard to create your admin account"
        echo ""
        echo -e "  4. Install your first app from the catalog"
    else
        echo -e "  2. Complete the setup wizard to create your admin account"
        echo ""
        echo -e "  3. Install your first app from the catalog"
    fi
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

    # Keep the running service up while the new binary is downloaded and
    # verified. download_binary stops it only after checks pass, just before
    # replacing the installed file.
    create_directories
    get_latest_release
    INSTALL_VERSION="$LATEST_RELEASE"

    if ! download_binary; then
        log_error "Download or verification failed. Leaving the previous binary in place."
        if [ -f "${BACKUP_BINARY}" ]; then
            # Re-link / restore in case a partial install moved anything.
            cp "${BACKUP_BINARY}" "${INSTALL_DIR}/libreserv"
            chmod +x "${INSTALL_DIR}/libreserv"
            ln -sf "${INSTALL_DIR}/libreserv" "${BIN_DIR}/libreserv"
            log_info "Previous binary restored"
            run_systemctl start "${SERVICE_NAME}" 2>/dev/null || true
        fi
        rm -f "${BACKUP_BINARY}"
        exit 1
    fi

    create_catalog_dir
    download_restic

    rm -f "${BACKUP_BINARY}"

    log_info "Updating systemd unit..."
    create_systemd_service

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

    install_runtime

    create_user
    create_directories

    prompt_version
    download_binary
    create_catalog_dir
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

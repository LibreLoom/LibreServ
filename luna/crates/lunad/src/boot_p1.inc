                        problems.push(err);
                    }
                    if let Some(err) = st.tunnel_error.clone() {
                        problems.push(err);
                    }

                    if !net.ethernet_connected {
                        problems.push(
                            "No ethernet cable detected. Plug Luna into your router or modem with the included RJ45 (ethernet) cable."
                                .into(),
                        );
                    } else if net.ipv4.is_empty() {
                        problems.push(
                            "Waiting for a network address from your router or modem.".into(),
                        );
                    } else if !net.has_default_route {
                        problems.push(
                            "This Luna has a network address, but no path out to the internet. Check the router or modem."
                                .into(),
                        );
                    }

                    if let Ok(conn) = db.lock() {
                        let preflight = crate::system_health::run_preflight(&data_dir, &conn);
                        let mut preflight_errors: Vec<_> = preflight
                            .checks
                            .into_iter()
                            .filter(|(_, c)| c.status != "ok")
                            .filter_map(|(_, c)| c.error)
                            .collect();
                        preflight_errors.sort();
                        problems.extend(preflight_errors);

                        if let Ok(drives) = crate::db::list_drives(&conn) {
                            for drive in drives {
                                // Unplugged is normal — not an HDMI-console problem.
                                if drive.state.as_str() == "readonly" {
                                    problems.push(format!(
                                        "Drive \"{}\" can be read but not written. This is usually the filesystem, or a write-lock switch on the stick.",
                                        drive.label
                                    ));
                                }
                            }
                        }
                    }

                    // Keep problem list short enough for a small HDMI screen.
                    problems.truncate(6);

                    let snap = crate::console::ConsoleSnapshot {
                        ipv4: net.ipv4.clone(),
                        cable_in: net.ethernet_connected,
                        has_default_route: net.has_default_route,
                        setup_code: st.setup_code.clone(),
                        connect_hostname: st.hostname.clone(),
                        problems,
                    };
                    // Always rewrite so luna-console's mtime liveness check stays
                    // honest when status text is unchanged (e.g. Connect hostname
                    // already shown).
                    let _ = crate::console::write_issue(&data_dir, &snap);
                    std::thread::sleep(std::time::Duration::from_secs(2));
                }
            })
            .ok();
    }

    {
        let data_dir = cfg.data_dir.clone();
        let db = state.db.clone();
        std::thread::Builder::new()
            .name("luna-flash-recovery".into())
            .spawn(move || {
                loop {
                    if let Ok(conn) = db.lock() {
                        let _ = crate::recovery_drive::scan_candidate_dirs(&data_dir, &conn);
                    }
                    std::thread::sleep(std::time::Duration::from_secs(3));
                }
            })
            .ok();
    }

    let health_db = state.db.clone();
    let health_drives = state.drive_manager.clone();
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(15 * 60));
        loop {
            ticker.tick().await;
            if let Ok(conn) = health_db.lock() {
                let _ = health_drives.health_check(&conn);
            }
        }
    });

    // Reclaimable RAM caches: shrink thumbs/listings under MemAvailable pressure;
    // flush dirty writes early rather than dropping them.
    let pressure_state = state.clone();
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(5));
        loop {
            ticker.tick().await;
            let state = pressure_state.clone();
            let _ = tokio::task::spawn_blocking(move || {
                state.ram_cache.reclaim_for_pressure(|drive_id| {
                    let Ok(conn) = state.db.lock() else {
                        return None;
                    };
                    crate::db::get_drive(&conn, drive_id)
                        .ok()
                        .flatten()
                        .filter(|d| !d.mount_point.is_empty())
                        .map(|d| std::path::PathBuf::from(d.mount_point))
                });
            })
            .await;
        }
    });

    let updates_bg = state.updates.clone();
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(3600));
        ticker.tick().await;
        loop {
            let svc = updates_bg.clone();
            let version = env!("CARGO_PKG_VERSION").to_string();
            let _ = tokio::task::spawn_blocking(move || {
                let _ = svc.check(&version, false);
            })
            .await;
            ticker.tick().await;
        }
    });

    let protect_db = state.db.clone();
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(30 * 60));
        loop {
            ticker.tick().await;
            let db = protect_db.clone();
            let _ = tokio::task::spawn_blocking(move || {
                let _ = crate::protect::sync_all(&db);
            })
            .await;
        }
    });

    let backup_state = state.clone();
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(120));
        loop {
            ticker.tick().await;

use std::net::SocketAddr;

use lunad::{AppState, api, config::Config, db, drives::DriveManager, mount::CommandMounter};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "lunad=info,tower_http=warn".into()),
        )
        .with_target(false)
        .compact()
        .init();

    let mut cfg = Config::from_env().overlay_from_args();
    if let Err(e) = std::fs::create_dir_all(&cfg.data_dir) {
        // The configured data dir isn't usable (e.g. a read-only $HOME in a
        // container, or /var/lib/luna without root). Fall back to a scratch
        // dir instead of dying — a dev box should just boot.
        let fallback = std::env::temp_dir().join("luna-data");
        std::fs::create_dir_all(&fallback)
            .map_err(|_| anyhow::anyhow!("could not create data dir: {e}"))?;
        tracing::warn!(data_dir = %cfg.data_dir.display(), fallback = %fallback.display(), "data dir unusable, using scratch dir");
        cfg.data_dir = fallback;
    }
    let conn = db::open(&cfg.db_path())?;
    let drive_manager = std::sync::Arc::new(DriveManager::new(
        std::sync::Arc::new(CommandMounter),
        &cfg.data_dir,
    ));
    {
        let mounts = std::fs::read_to_string("/proc/mounts").unwrap_or_default();
        let detected = lunad::dev_mock::scan_all(std::path::Path::new("/sys/block"), &mounts);
        drive_manager.reconcile(&conn, &detected)?;
    }
    let connect = std::sync::Arc::new(
        lunad::connect::ConnectService::new(&cfg.data_dir, std::env::var("LUNA_CONNECT_URL").ok())
            .with_local_port(cfg.port),
    );
    connect.restore_tunnel_from_disk();
    let state = AppState::new(conn, drive_manager, &cfg.data_dir).with_connect(connect);

    // Catch-up gallery index for every adopted mount already on disk.
    {
        let mounts = {
            let db = state.db.lock().expect("db");
            lunad::db::list_drives(&db)
                .unwrap_or_default()
                .into_iter()
                .filter(|d| d.state == "as_is" && !d.mount_point.is_empty())
                .map(|d| (d.id, std::path::PathBuf::from(d.mount_point)))
                .collect::<Vec<_>>()
        };
        for (id, mount) in mounts {
            state.gallery.watch_mount(&id, mount);
        }
    }

    // Password recovery is the Linux `pwreset` login shell (luna-pwreset),
    // which POSTs to /api/v1/console/reset-password on loopback.

    let connect_poll_wake = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));

    std::thread::Builder::new()
        .name("luna-dhcp-link".into())
        .spawn({
            let wake = connect_poll_wake.clone();
            move || {
                lunad::dhcp::request_on_wired(std::path::Path::new("/sys/class/net"));
                lunad::dhcp::watch_link_up(
                    std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
                    Some(wake),
                );
            }
        })
        .ok();

    {
        let connect = state.connect.clone();
        let db = state.db.clone();
        let wake = connect_poll_wake.clone();
        std::thread::Builder::new()
            .name("luna-connect-status".into())
            .spawn(move || {
                use std::sync::atomic::Ordering;
                use std::time::Duration;

                loop {
                    let _ = connect.poll_status();
                    let setup_open = db
                        .lock()
                        .map(|conn| lunad::auth::setup_wizard_open_conn(&conn))
                        .unwrap_or(false);
                    let interval = connect.poll_interval_secs(setup_open);
                    let mut waited = 0u64;
                    while waited < interval {
                        if wake.swap(false, Ordering::Relaxed) {
                            break;
                        }
                        std::thread::sleep(Duration::from_secs(1));
                        waited += 1;
                    }
                }
            })
            .ok();
    }

    {
        let connect = state.connect.clone();
        let data_dir = cfg.data_dir.clone();
        let db = state.db.clone();
        std::thread::Builder::new()
            .name("luna-console-help".into())
            .spawn(move || {
                loop {
                    let proc_route = std::fs::read_to_string("/proc/net/route").unwrap_or_default();
                    let net = lunad::net::read_status(
                        std::path::Path::new("/sys/class/net"),
                        &proc_route,
                    );
                    let st = connect.status();
                    let mut problems: Vec<String> = Vec::new();

                    if let Some(err) = st.device_token_error.clone() {
                        problems.push(err);
                    }
                    if let Some(err) = st.connect_unreachable.clone() {
                        problems.push(err);
                    }
                    if st.connect_active
                        && st.enabled
                        && st.hostname.is_some()
                        && !st.tunnel_active
                        && st.device_token_error.is_none()
                    {
                        problems.push(
                            "Remote access is set up, but the secure tunnel is not running yet. Luna will keep trying."
                                .into(),
                        );
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
                        let preflight = lunad::system_health::run_preflight(&data_dir, &conn);
                        let mut preflight_errors: Vec<_> = preflight
                            .checks
                            .into_iter()
                            .filter(|(_, c)| c.status != "ok")
                            .filter_map(|(_, c)| c.error)
                            .collect();
                        preflight_errors.sort();
                        problems.extend(preflight_errors);

                        if let Ok(drives) = lunad::db::list_drives(&conn) {
                            for drive in drives {
                                match drive.state.as_str() {
                                    "readonly" => problems.push(format!(
                                        "Drive \"{}\" can be read but not written. Check the cable or try another port.",
                                        drive.label
                                    )),
                                    "missing" => problems.push(format!(
                                        "Drive \"{}\" is missing. Plug it back in.",
                                        drive.label
                                    )),
                                    _ => {}
                                }
                            }
                        }
                    }

                    // Keep problem list short enough for a small HDMI screen.
                    problems.truncate(6);

                    let snap = lunad::console::ConsoleSnapshot {
                        ipv4: net.ipv4.clone(),
                        cable_in: net.ethernet_connected,
                        has_default_route: net.has_default_route,
                        setup_code: st.setup_code.clone(),
                        connect_hostname: st.hostname.clone(),
                        unclaimed: st.unclaimed,
                        problems,
                    };
                    // Always rewrite so luna-console's mtime liveness check stays
                    // honest when status text is unchanged (e.g. Connect hostname
                    // already shown).
                    let _ = lunad::console::write_issue(&data_dir, &snap);
                    std::thread::sleep(std::time::Duration::from_secs(2));
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
                let _ = lunad::protect::sync_all(&db);
            })
            .await;
        }
    });

    let backup_state = state.clone();
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(120));
        loop {
            ticker.tick().await;
            let last = backup_state
                .last_io_activity
                .load(std::sync::atomic::Ordering::Relaxed);
            let now = lunad::db::now_unix();
            let connect = backup_state.connect.clone();
            let db = backup_state.db.clone();
            let _ = tokio::task::spawn_blocking(move || {
                lunad::cloud_backup::tick(&connect, last, now, &db);
            })
            .await;
        }
    });

    let scrub_state = state.clone();
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(10 * 60));
        loop {
            ticker.tick().await;
            let hour = lunad::scrub::local_hour_now();
            let now = lunad::db::now_unix();
            let last_run = scrub_state
                .db
                .lock()
                .ok()
                .and_then(|conn| {
                    lunad::db::get_meta(&conn, "last_periodic_scrub_at")
                        .ok()
                        .flatten()
                })
                .and_then(|raw| raw.parse::<i64>().ok());
            let last_activity = scrub_state
                .last_io_activity
                .load(std::sync::atomic::Ordering::Relaxed);
            let running = scrub_state
                .scrub_running
                .load(std::sync::atomic::Ordering::SeqCst);
            if !lunad::scrub::should_run_periodic(running, hour, last_run, last_activity, now) {
                continue;
            }
            if scrub_state
                .scrub_running
                .swap(true, std::sync::atomic::Ordering::SeqCst)
            {
                continue;
            }
            let db = scrub_state.db.clone();
            let flag = scrub_state.scrub_running.clone();
            let _ = tokio::task::spawn_blocking(move || {
                let _ = lunad::scrub::scrub_all_drives_unlocked(&db);
                if let Ok(conn) = db.lock() {
                    let _ = lunad::db::set_meta(&conn, "last_periodic_scrub_at", &now.to_string());
                    let _ = lunad::db::wal_checkpoint_passive(&conn);
                    let last_vac = lunad::db::get_meta(&conn, "last_vacuum_at")
                        .ok()
                        .flatten()
                        .and_then(|raw| raw.parse::<i64>().ok())
                        .unwrap_or(0);
                    // Compact at most monthly — VACUUM rewrites the whole file.
                    if now.saturating_sub(last_vac) >= 30 * 24 * 60 * 60
                        && lunad::db::vacuum_if_possible(&conn).is_ok()
                    {
                        let _ = lunad::db::set_meta(&conn, "last_vacuum_at", &now.to_string());
                    }
                }
                flag.store(false, std::sync::atomic::Ordering::SeqCst);
            })
            .await;
        }
    });

    let trim_state = state.clone();
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(30 * 60));
        loop {
            ticker.tick().await;
            let hour = lunad::scrub::local_hour_now();
            let now = lunad::db::now_unix();
            let last_run = trim_state
                .db
                .lock()
                .ok()
                .and_then(|conn| lunad::db::get_meta(&conn, "last_fstrim_at").ok().flatten())
                .and_then(|raw| raw.parse::<i64>().ok());
            let last_activity = trim_state
                .last_io_activity
                .load(std::sync::atomic::Ordering::Relaxed);
            if !lunad::fstrim::should_run_fstrim(false, hour, last_run, last_activity, now) {
                continue;
            }
            let db = trim_state.db.clone();
            let _ = tokio::task::spawn_blocking(move || {
                if let Ok(conn) = db.lock() {
                    let _ = lunad::fstrim::fstrim_all_drives(&conn);
                    let _ = lunad::db::set_meta(&conn, "last_fstrim_at", &now.to_string());
                }
            })
            .await;
        }
    });

    let protected_api = api::router()
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            lunad::auth::guard,
        ))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            touch_io_activity,
        ));
    let app = axum::Router::new()
        .merge(protected_api)
        .merge(lunad::dav::router())
        .with_state(state)
        .fallback(axum::routing::get(|uri: axum::http::Uri| async move {
            lunad::staticweb::handle(uri.path())
        }));

    let addr: SocketAddr = format!("{}:{}", cfg.host, cfg.port).parse()?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(%addr, product = "Luna", "listening");
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await?;
    Ok(())
}

async fn touch_io_activity(
    axum::extract::State(state): axum::extract::State<lunad::AppState>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let path = req.uri().path();
    if path.contains("/files")
        || path.starts_with("/api/v1/uploads")
        || path.starts_with("/api/v1/jobs")
    {
        state.touch_io_activity();
    }
    next.run(req).await
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}

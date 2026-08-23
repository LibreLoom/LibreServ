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
        let detected = lunad::detect::scan(std::path::Path::new("/sys/block"), &mounts);
        drive_manager.reconcile(&conn, &detected)?;
    }
    let proc_route = std::fs::read_to_string("/proc/net/route").unwrap_or_default();
    let net = lunad::net::read_status(std::path::Path::new("/sys/class/net"), &proc_route);
    let wpa_cli_ok = std::process::Command::new("wpa_cli")
        .arg("-v")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    let wifi: std::sync::Arc<dyn lunad::wifi::WifiProvider> =
        match (net.wifi_interface.as_deref(), wpa_cli_ok) {
            (Some(iface), true) => std::sync::Arc::new(lunad::wifi::WpaCliProvider::new(iface)),
            _ => std::sync::Arc::new(lunad::wifi::NoopProvider),
        };
    let connect = std::sync::Arc::new(lunad::connect::ConnectService::new(
        &cfg.data_dir,
        std::env::var("LUNA_CONNECT_URL").ok(),
    ));
    let state = AppState::new(conn, drive_manager)
        .with_wifi(wifi)
        .with_connect(connect)
        .with_thumb_dir(cfg.data_dir.join("thumbs"));

    {
        let auth = state.auth.clone();
        std::thread::Builder::new()
            .name("luna-recovery".into())
            .spawn(move || {
                lunad::recovery::run_loop(
                    auth,
                    lunad::recovery::EvdevKeys::scan(),
                    lunad::recovery::ConsolePrompt,
                    std::time::Instant::now,
                );
            })
            .ok();
    }

    std::thread::Builder::new()
        .name("luna-console-help".into())
        .spawn(lunad::console::print_connection_help)
        .ok();

    let setup_done = state
        .db
        .lock()
        .ok()
        .and_then(|conn| lunad::db::get_meta(&conn, "setup").ok().flatten())
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|v| v.get("setup_completed").and_then(|b| b.as_bool()))
        .unwrap_or(false);
    if lunad::hotspot::should_start_setup_hotspot(
        setup_done,
        net.ethernet_connected,
        net.wifi_connected,
    ) && let Some(iface) = net.wifi_interface.clone()
    {
        let hotspot = lunad::hotspot::CommandHotspot::new(iface, &cfg.data_dir.join("run"));
        match hotspot.start() {
            Ok(()) => {
                tracing::info!(ssid = lunad::hotspot::SETUP_SSID, "setup hotspot active");
                state.set_hotspot(hotspot);
            }
            Err(e) => tracing::warn!(error = %e, "setup hotspot unavailable"),
        }
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

    let protect_db = state.db.clone();
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(30 * 60));
        loop {
            ticker.tick().await;
            if let Ok(conn) = protect_db.lock() {
                let _ = lunad::protect::sync_all(&conn);
            }
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
                if let Ok(conn) = db.lock() {
                    lunad::cloud_backup::tick(&connect, last, now, &conn);
                }
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
                if let Ok(conn) = db.lock() {
                    let _ = lunad::scrub::scrub_all_drives(&conn);
                    let _ = lunad::db::set_meta(&conn, "last_periodic_scrub_at", &now.to_string());
                }
                flag.store(false, std::sync::atomic::Ordering::SeqCst);
            })
            .await;
        }
    });

    let hotspot_db = state.db.clone();
    let hotspot_state = state.clone();
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(30));
        loop {
            ticker.tick().await;
            let proc_route = std::fs::read_to_string("/proc/net/route").unwrap_or_default();
            let net = lunad::net::read_status(std::path::Path::new("/sys/class/net"), &proc_route);
            let setup_done = hotspot_db
                .lock()
                .ok()
                .and_then(|conn| lunad::db::get_meta(&conn, "setup").ok().flatten())
                .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
                .and_then(|v| v.get("setup_completed").and_then(|b| b.as_bool()))
                .unwrap_or(false);
            if (setup_done || net.ethernet_connected || net.wifi_connected)
                && let Some(hotspot) = hotspot_state.hotspot.lock().unwrap().take()
            {
                let _ = hotspot.stop();
                tracing::info!("setup hotspot stopped");
            }
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

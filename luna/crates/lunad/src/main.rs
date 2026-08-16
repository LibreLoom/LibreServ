use std::net::SocketAddr;

use lunad::{
    AppState, api,
    ble::{BleService, NoopTransport, RouterExecutor},
    config::Config,
    db,
    drives::DriveManager,
    mount::CommandMounter,
};

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

    let cfg = Config::from_env();
    if cfg.data_dir.exists() {
        std::fs::create_dir_all(&cfg.data_dir)?;
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
    let ble_setup_code = {
        let existing = db::get_meta(&conn, "ble_setup_code")?;
        match existing {
            Some(code) if !code.is_empty() => code,
            _ => {
                let code = uuid::Uuid::new_v4().simple().to_string()[..8].to_uppercase();
                db::set_meta(&conn, "ble_setup_code", &code)?;
                code
            }
        }
    };
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
    let state = AppState::new(conn, drive_manager).with_wifi(wifi);

    let app = axum::Router::new()
        .merge(api::router())
        .merge(lunad::dav::router())
        .with_state(state)
        .fallback(axum::routing::get(|uri: axum::http::Uri| async move {
            lunad::staticweb::handle(uri.path())
        }));

    let ble = BleService::new(
        ble_setup_code,
        RouterExecutor::new(app.clone()),
        std::sync::Arc::new(NoopTransport),
    );
    if let Err(e) = ble.start() {
        tracing::warn!(error = %e, "BLE bootstrap disabled");
    }

    let addr: SocketAddr = format!("{}:{}", cfg.host, cfg.port).parse()?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(%addr, product = "Luna", "listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    ble.stop();
    Ok(())
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}

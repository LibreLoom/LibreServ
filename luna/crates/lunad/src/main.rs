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

    let cfg = Config::from_env();
    if cfg.data_dir.exists() {
        std::fs::create_dir_all(&cfg.data_dir)?;
    }
    let conn = db::open(&cfg.db_path())?;
    let drive_manager = std::sync::Arc::new(DriveManager::new(
        std::sync::Arc::new(CommandMounter),
        &cfg.data_dir,
    ));
    let state = AppState::new(conn, drive_manager);

    let app = axum::Router::new()
        .merge(api::router(state))
        .fallback(axum::routing::get(|uri: axum::http::Uri| async move {
            lunad::staticweb::handle(uri.path())
        }));

    let addr: SocketAddr = format!("{}:{}", cfg.host, cfg.port).parse()?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(%addr, product = "Luna", "listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}

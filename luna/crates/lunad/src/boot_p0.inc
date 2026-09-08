use std::net::SocketAddr;

use crate::{AppState, api, config::Config, db, drives::DriveManager, mount::CommandMounter};

pub async fn run() -> anyhow::Result<()> {
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
        let detected = crate::dev_mock::scan_all(std::path::Path::new("/sys/block"), &mounts);
        drive_manager.reconcile(&conn, &detected)?;
    }
    let connect = std::sync::Arc::new(
        crate::connect::ConnectService::new(&cfg.data_dir, std::env::var("LUNA_CONNECT_URL").ok())
            .with_local_port(cfg.port),
    );
    connect.restore_tunnel_from_disk();
    let state = AppState::new(conn, drive_manager, &cfg.data_dir).with_connect(connect);

    // One-shot: pull pre-microdb index/hash/upload rows out of luna.db into each
    // mounted drive's `.luna` before gallery catch-up or search fans out.
    {
        let db = state.db.lock().expect("db");
        for drive in crate::db::list_drives(&db).unwrap_or_default() {
            if drive.state != "as_is" || drive.mount_point.is_empty() {
                continue;
            }
            let root = std::path::Path::new(&drive.mount_point);
            if !crate::drive_db::path_for(root).is_file() {
                continue;
            }
            if let Ok(dconn) = crate::drive_db::open(root) {
                let _ = crate::drive_db::migrate_from_central(&db, &drive.id, &dconn);
            }
        }
    }

    // Catch-up gallery index for every adopted mount already on disk.
    {
        let mounts = {
            let db = state.db.lock().expect("db");
            crate::db::list_drives(&db)
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

    let connect_poll_wake = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));

    // DHCP link watcher: wake Connect poll on carrier rise *or* when IPv4 appears
    // (late DHCP/internet with cable already in — carrier edge alone misses that).
    std::thread::Builder::new()
        .name("luna-dhcp-link".into())
        .spawn({
            let wake = connect_poll_wake.clone();
            move || {
                crate::dhcp::request_on_wired(std::path::Path::new("/sys/class/net"));
                crate::dhcp::watch_link_up(
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
                    // Supervisor: if Connect poll failed/flapped but local tunnel credentials exist,
                    // keep (re)starting cloudflared so DNS does not stick on Error 1033.
                    connect.ensure_tunnel_if_needed();
                    let setup_open = db
                        .lock()
                        .map(|conn| crate::auth::setup_wizard_open_conn(&conn))
                        .unwrap_or(false);
                    let interval = connect.poll_interval_secs(setup_open);
                    let mut waited = 0u64;
                    while waited < interval {
                        if wake.swap(false, Ordering::Relaxed) {
                            break;
                        }
                        std::thread::sleep(Duration::from_secs(1));
                        waited += 1;
                        // Re-check during long steady-state sleeps (300s). Otherwise a dead
                        // cloudflared child is not noticed until the next Connect poll.
                        if waited.is_multiple_of(5) {
                            connect.ensure_tunnel_if_needed();
                        }
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
                    let net = crate::net::read_status(
                        std::path::Path::new("/sys/class/net"),
                        &proc_route,
                    );
                    let st = connect.status();
                    let mut problems: Vec<String> = Vec::new();

                    if let Some(err) = st.device_token_error.clone() {
                        problems.push(err);
                    }
                    if let Some(err) = st.connect_unreachable.clone() {

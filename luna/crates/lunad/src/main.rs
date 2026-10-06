use std::net::SocketAddr;

use lunad::{
    AppState, api, config::Config, db, drives::DriveManager, drives::mount::CommandMounter,
};

fn main() -> anyhow::Result<()> {
    // `luna-run` compares this against the daemon on the data partition, so it
    // prints the bare semver and nothing else.
    if std::env::args()
        .skip(1)
        .any(|a| a == "--version" || a == "-V")
    {
        println!("{}", lunad::VERSION);
        return Ok(());
    }
    // Capped runtime for 2 GiB targets: 2 async workers handle the HTTP
    // workload (disk work goes to spawn_blocking), and 16 blocking threads
    // cap the default pool of 512 thread stacks.
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .max_blocking_threads(16)
        .enable_all()
        .build()
        .map_err(|e| anyhow::anyhow!("could not start async runtime: {e}"))?
        .block_on(async_main())
}

async fn async_main() -> anyhow::Result<()> {
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
        // Fail closed: a silent scratch dir under a shared /tmp would expose
        // device tokens, session secrets, and the user database. Only a dev
        // who opts in with LUNA_ALLOW_TMP_DATA=1 gets the fallback.
        if std::env::var("LUNA_ALLOW_TMP_DATA").ok().as_deref() != Some("1") {
            return Err(anyhow::anyhow!(
                "could not create data dir {}: {e}",
                cfg.data_dir.display()
            ));
        }
        let fallback = std::env::temp_dir().join("luna-data");
        std::fs::create_dir_all(&fallback)
            .map_err(|_| anyhow::anyhow!("could not create data dir: {e}"))?;
        #[cfg(unix)]
        verify_owned_scratch_dir(&fallback)?;
        tracing::warn!(data_dir = %cfg.data_dir.display(), fallback = %fallback.display(), "data dir unusable, using scratch dir");
        cfg.data_dir = fallback;
    }
    // The data dir holds device tokens, session secrets, and luna.db — keep
    // it owner-only even when it already existed with looser permissions.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&cfg.data_dir, std::fs::Permissions::from_mode(0o700)).map_err(
            |e| anyhow::anyhow!("could not secure data dir {}: {e}", cfg.data_dir.display()),
        )?;
    }
    let conn = db::open(&cfg.db_path())?;
    let drive_manager = std::sync::Arc::new(DriveManager::new(
        std::sync::Arc::new(CommandMounter),
        &cfg.data_dir,
    ));
    let detected = {
        let mounts = std::fs::read_to_string("/proc/mounts").unwrap_or_default();
        lunad::drives::detect::scan_with_dev_mocks(std::path::Path::new("/sys/block"), &mounts)
    };
    drive_manager.reconcile(&conn, &detected)?;

    // Password recovery runs once, here, before the network is up: Connect has
    // not been restored and the HTTP listener has not bound, so no peer can
    // reach lunad while a recovery stick is being honoured.
    lunad::system::recovery_drive::scan_at_boot(&cfg.data_dir, &conn, &detected, &drive_manager);

    let connect = std::sync::Arc::new(
        lunad::net::connect::ConnectService::new(
            &cfg.data_dir,
            std::env::var("LUNA_CONNECT_URL").ok(),
        )
        .with_local_port(cfg.port),
    );
    connect.restore_tunnel_from_disk();
    let state = AppState::new(conn, drive_manager, &cfg.data_dir).with_connect(connect.clone());

    // One-shot: pull pre-microdb index/hash/upload rows out of luna.db into
    // each mounted drive's marker database before gallery catch-up or search
    // fans out.
    {
        let db = state.db.lock().expect("db");
        for drive in lunad::db::list_drives(&db).unwrap_or_default() {
            if drive.state != "as_is" || drive.mount_point.is_empty() {
                continue;
            }
            let root = std::path::Path::new(&drive.mount_point);
            if lunad::drives::drive_db::find_db_file(root).is_none() {
                continue;
            }
            if let Ok(dconn) = lunad::drives::drive_db::open(root) {
                let _ = lunad::drives::drive_db::migrate_from_central(&db, &drive.id, &dconn);
            }
        }
    }

    // Upload sessions idle past the orphan cutoff lose their `.part` temp
    // and their microdb row — a crash or an abandoned upload never leaves
    // resumable state behind. Runs after the migration above so rows that
    // just moved into drive microdbs are swept too.
    lunad::files::uploads::sweep_orphans(&state.db);

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
            state.search_index.watch_mount(&id, mount.clone());
            state.gallery.watch_mount(&id, mount);
        }
    }

    let connect_poll_wake = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    // Set at graceful shutdown so the detached supervisor loops stop instead
    // of dying mid-work when the process exits.
    let shutting_down = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let mut bg_tasks: Vec<tokio::task::JoinHandle<()>> = Vec::new();

    // DHCP link watcher: wake Connect poll on carrier rise *or* when IPv4 appears
    // (late DHCP/internet with cable already in — carrier edge alone misses that).
    std::thread::Builder::new()
        .name("luna-dhcp-link".into())
        .spawn({
            let wake = connect_poll_wake.clone();
            let stop = shutting_down.clone();
            move || {
                lunad::net::dhcp::request_on_wired(std::path::Path::new("/sys/class/net"));
                lunad::net::dhcp::watch_link_up(stop, Some(wake));
            }
        })
        .ok();

    {
        let connect = state.connect.clone();
        let db = state.db.clone();
        let wake = connect_poll_wake.clone();
        let stop = shutting_down.clone();
        std::thread::Builder::new()
            .name("luna-connect-status".into())
            .spawn(move || {
                use std::sync::atomic::Ordering;
                use std::time::Duration;

                while !stop.load(Ordering::Relaxed) {
                    let _ = connect.poll_status();
                    // Supervisor: if Connect poll failed/flapped but local tunnel credentials exist,
                    // keep (re)starting cloudflared so DNS does not stick on Error 1033.
                    connect.ensure_tunnel_if_needed();
                    let setup_open = db
                        .lock()
                        .map(|conn| lunad::auth::setup_wizard_open_conn(&conn))
                        .unwrap_or(false);
                    let interval = connect.poll_interval_secs(setup_open);
                    let mut waited = 0u64;
                    while waited < interval {
                        if stop.load(Ordering::Relaxed) || wake.swap(false, Ordering::Relaxed) {
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
        let stop = shutting_down.clone();
        std::thread::Builder::new()
            .name("luna-console-help".into())
            .spawn(move || {
                use std::sync::atomic::Ordering;
                while !stop.load(Ordering::Relaxed) {
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
                        // Core checks only: network and Connect problems are
                        // listed above, and feature warnings don't belong on
                        // a small HDMI screen.
                        let core = lunad::system::system_health::run_core(
                            &data_dir,
                            &conn,
                            lunad::system::system_health::ClockReading::live(),
                            false,
                        );
                        let mut preflight_errors: Vec<_> = core
                            .checks
                            .into_values()
                            .filter(|c| c.status == lunad::system::system_health::FAILED)
                            .map(|c| c.message)
                            .collect();
                        preflight_errors.sort();
                        problems.extend(preflight_errors);

                        if let Ok(drives) = lunad::db::list_drives(&conn) {
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

                        // Same rows and wording as the web's system checks.
                        let cloud_sources = st.connect_active && !st.backup_sources.is_empty();
                        let mut backup_problems: Vec<_> =
                            lunad::system::system_health::backup_checks(
                                &conn,
                                cloud_sources,
                                lunad::db::now_unix(),
                            )
                            .into_values()
                            .filter(|c| c.status == lunad::system::system_health::WARNING)
                            .map(|c| c.message)
                            .collect();
                        backup_problems.sort();
                        problems.extend(backup_problems);
                    }

                    // Keep problem list short enough for a small HDMI screen.
                    problems.truncate(6);

                    let snap = lunad::system::console::ConsoleSnapshot {
                        ipv4: net.ipv4.clone(),
                        cable_in: net.ethernet_connected,
                        has_default_route: net.has_default_route,
                        device_code: st.device_code.clone(),
                        connect_hostname: st.hostname.clone(),
                        problems,
                    };
                    // Always rewrite so luna-console's mtime liveness check stays
                    // honest when status text is unchanged (e.g. Connect hostname
                    // already shown). Every 10s is plenty for a small HDMI screen.
                    let _ = lunad::system::console::write_issue(&data_dir, &snap);
                    // Second-sized slices so shutdown isn't a 10 s wait.
                    for _ in 0..10 {
                        if stop.load(Ordering::Relaxed) {
                            break;
                        }
                        std::thread::sleep(std::time::Duration::from_secs(1));
                    }
                }
            })
            .ok();
    }

    // Catch changes made behind Luna's back (a drive plugged into another
    // computer): folders whose timestamp hasn't moved cost one stat each.
    let rescan_state = state.clone();
    bg_tasks.push(tokio::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(15 * 60));
        ticker.tick().await;
        loop {
            ticker.tick().await;
            let drives = rescan_state.db.lock().ok().map(|conn| {
                lunad::files::search::indexable_drives(&conn, true)
                    .into_iter()
                    .map(|d| (d.id, d.mount))
                    .collect::<Vec<_>>()
            });
            if let Some(drives) = drives {
                rescan_state.search_index.rescan(drives, false);
            }
        }
    }));

    let health_db = state.db.clone();
    let health_drives = state.drive_manager.clone();
    bg_tasks.push(tokio::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(15 * 60));
        loop {
            ticker.tick().await;
            if let Ok(conn) = health_db.lock() {
                let _ = health_drives.health_check(&conn);
            }
        }
    }));

    // Reclaimable RAM caches: shrink thumbs/listings under MemAvailable pressure;
    // flush dirty writes early rather than dropping them.
    let pressure_state = state.clone();
    bg_tasks.push(tokio::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(5));
        loop {
            ticker.tick().await;
            let state = pressure_state.clone();
            let _ = tokio::task::spawn_blocking(move || {
                state.ram_cache.reclaim_for_pressure(|drive_id| {
                    let Ok(conn) = state.db.lock() else {
                        return None;
                    };
                    lunad::db::get_drive(&conn, drive_id)
                        .ok()
                        .flatten()
                        .filter(|d| !d.mount_point.is_empty())
                        .map(|d| std::path::PathBuf::from(d.mount_point))
                });
            })
            .await;
        }
    }));

    let updates_bg = state.updates.clone();
    bg_tasks.push(tokio::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(3600));
        ticker.tick().await;
        loop {
            let svc = updates_bg.clone();
            let version = lunad::VERSION.to_string();
            let _ = tokio::task::spawn_blocking(move || {
                let _ = svc.check(&version, false);
            })
            .await;
            ticker.tick().await;
        }
    }));

    let protect_db = state.db.clone();
    let protect_health = state.health_cache.clone();
    bg_tasks.push(tokio::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(30 * 60));
        loop {
            ticker.tick().await;
            let db = protect_db.clone();
            let changed =
                tokio::task::spawn_blocking(move || match lunad::backup::protect::sync_all(&db) {
                    Ok(outcome) => outcome.state_changed,
                    Err(e) => {
                        tracing::warn!(error = %e, "protected folders couldn't be listed");
                        false
                    }
                })
                .await
                .unwrap_or(false);
            if changed {
                protect_health.invalidate();
            }
        }
    }));

    let backup_state = state.clone();
    bg_tasks.push(tokio::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(120));
        loop {
            ticker.tick().await;
            let last = backup_state
                .last_io_activity
                .load(std::sync::atomic::Ordering::Relaxed);
            let now = lunad::db::now_unix();
            let connect = backup_state.connect.clone();
            let db = backup_state.db.clone();
            let changed = tokio::task::spawn_blocking(move || {
                lunad::backup::cloud_backup::tick(&connect, last, now, &db)
            })
            .await
            .unwrap_or(false);
            if changed {
                backup_state.health_cache.invalidate();
            }
        }
    }));

    let scrub_state = state.clone();
    bg_tasks.push(tokio::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(10 * 60));
        loop {
            ticker.tick().await;
            let hour = lunad::drives::scrub::local_hour_now();
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
            if !lunad::drives::scrub::should_run_periodic(
                running,
                hour,
                last_run,
                last_activity,
                now,
            ) {
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
                let _ = lunad::drives::scrub::scrub_all_drives_unlocked(&db);
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
    }));

    let trim_state = state.clone();
    bg_tasks.push(tokio::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(30 * 60));
        loop {
            ticker.tick().await;
            let hour = lunad::drives::scrub::local_hour_now();
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
            if !lunad::drives::fstrim::should_run_fstrim(false, hour, last_run, last_activity, now)
            {
                continue;
            }
            let db = trim_state.db.clone();
            let _ = tokio::task::spawn_blocking(move || {
                if let Ok(conn) = db.lock() {
                    let _ = lunad::drives::fstrim::fstrim_all_drives(&conn);
                    let _ = lunad::db::set_meta(&conn, "last_fstrim_at", &now.to_string());
                }
            })
            .await;
        }
    }));

    // Drop empty collab rooms after they go idle.
    {
        let hub = state.collab.clone();
        bg_tasks.push(tokio::spawn(async move {
            let mut ticker = tokio::time::interval(std::time::Duration::from_secs(30));
            loop {
                ticker.tick().await;
                hub.evict_idle().await;
            }
        }));
    }

    // Same for office docstorage sessions; plus a boot-time sweep for bundle
    // dirs left behind by old document versions.
    lunad::api::office::sweep_old_bundles(&cfg.data_dir);
    {
        let hub = state.office_docs.clone();
        bg_tasks.push(tokio::spawn(async move {
            let mut ticker = tokio::time::interval(std::time::Duration::from_secs(60));
            loop {
                ticker.tick().await;
                hub.evict_idle().await;
            }
        }));
    }

    let protected_api = api::router()
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            lunad::auth::guard,
        ))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            lunad::api::public_limits::limit_public_album_uploads,
        ))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            touch_io_activity,
        ));
    let eurooffice_dir = cfg.data_dir.join("eurooffice");
    let mut app = axum::Router::new()
        .merge(protected_api)
        // WebDAV sits outside protected_api (it authenticates itself) but is
        // file traffic all the same.
        .merge(
            lunad::files::dav::router().layer(axum::middleware::from_fn_with_state(
                state.clone(),
                touch_io_activity,
            )),
        );
    if eurooffice_dir.is_dir() {
        tracing::info!(dir = %eurooffice_dir.display(), "serving EuroOffice assets");
        // One wildcard route handles the whole /eurooffice tree: versioned
        // pack URLs are deversioned and docstorage sockets upgraded inside
        // the dispatcher. It stays outside protected_api — pack assets are
        // public and the socket authenticates on the office JWT in the
        // Socket.IO CONNECT payload, not the session cookie.
        // These routes bypass staticweb::handle, so the pack security headers
        // (XFO SAMEORIGIN — the app iframes the editor — plus nosniff) are
        // layered on here instead. No CSP: the pack keeps its own policy.
        app = app.merge(
            axum::Router::new()
                .route(
                    "/eurooffice/{*tail}",
                    axum::routing::any(lunad::api::office_ws::dispatch),
                )
                // The editor iframe resolves ../../sdkjs/ against the root —
                // matches Document Server's nginx layout.
                .route(
                    "/sdkjs/{*tail}",
                    axum::routing::any(lunad::api::office_ws::sdkjs_dispatch),
                )
                // sdkjs font metrics load from ../../../../fonts/ — site root in
                // the DS nginx layout, so the pack's generated fonts dir is
                // served here too.
                .route(
                    "/fonts/{*tail}",
                    axum::routing::any(lunad::api::office_ws::fonts_dispatch),
                )
                .layer(axum::middleware::from_fn(
                    lunad::api::office::pack_security_headers,
                )),
        );
    }
    // Self-hosted diagrams.net webapp — a plain static pack, no dispatcher
    // tricks (unlike EuroOffice the pack's URLs are unversioned and there's
    // no socket). The editor iframe is same-origin and speaks postMessage.
    let drawio_dir = cfg.data_dir.join("drawio");
    if drawio_dir.is_dir() {
        tracing::info!(dir = %drawio_dir.display(), "serving draw.io assets");
        app = app.merge(
            axum::Router::new()
                .route("/drawio/{*tail}", axum::routing::any(drawio_dispatch))
                .layer(axum::middleware::from_fn(
                    lunad::api::office::pack_security_headers,
                )),
        );
    }
    let app =
        app.with_state(state)
            .fallback(axum::routing::get(|uri: axum::http::Uri| async move {
                lunad::system::staticweb::handle(uri.path())
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
    // Deterministic teardown: a service stop must not leave the managed
    // cloudflared running or the supervisors ticking behind a dead listener.
    shutting_down.store(true, std::sync::atomic::Ordering::Relaxed);
    connect.stop_tunnel();
    for task in bg_tasks {
        task.abort();
    }
    Ok(())
}

/// Static draw.io pack — every `/drawio/**` request serves from
/// `{data_dir}/drawio`. Missing files 404 rather than falling through to the
/// SPA fallback, so the web app's pack probe (`/drawio/pack.json`) can tell
/// "pack present, file absent" from "no pack".
async fn drawio_dispatch(
    axum::extract::State(state): axum::extract::State<lunad::AppState>,
    axum::extract::Path(tail): axum::extract::Path<String>,
    mut req: axum::extract::Request,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    use tower::ServiceExt;
    let dir = state.data_dir.join("drawio");
    if let Ok(uri) = format!("/{tail}").parse::<axum::http::Uri>() {
        *req.uri_mut() = uri;
    }
    match tower_http::services::ServeDir::new(dir).oneshot(req).await {
        Ok(res) => res.into_response(),
        Err(_) => axum::http::StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

async fn touch_io_activity(
    axum::extract::State(state): axum::extract::State<lunad::AppState>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    if lunad::is_io_path(req.uri().path()) {
        state.touch_io_activity();
    }
    next.run(req).await
}

/// The LUNA_ALLOW_TMP_DATA fallback must belong to this process and stay
/// owner-only — /tmp is shared, so a foreign or group-writable scratch dir
/// would leak tokens just like the original bug did.
#[cfg(unix)]
fn verify_owned_scratch_dir(dir: &std::path::Path) -> anyhow::Result<()> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    if std::fs::metadata(dir)?.uid() != unsafe { libc::geteuid() } {
        return Err(anyhow::anyhow!(
            "scratch data dir {} is owned by a different user",
            dir.display()
        ));
    }
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    Ok(())
}

// OpenRC/systemd stop lunad with SIGTERM, not SIGINT — without terminate()
// wired here, every service stop kills the daemon with no graceful shutdown
// (no WAL checkpoint, orphaned cloudflared).
async fn shutdown_signal() {
    let ctrl_c = tokio::signal::ctrl_c();
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        if let Ok(mut term) = signal(SignalKind::terminate()) {
            tokio::select! {
                _ = ctrl_c => {},
                _ = term.recv() => {},
            }
            return;
        }
    }
    let _ = ctrl_c.await;
}

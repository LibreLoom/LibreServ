            let last = backup_state
                .last_io_activity
                .load(std::sync::atomic::Ordering::Relaxed);
            let now = crate::db::now_unix();
            let connect = backup_state.connect.clone();
            let db = backup_state.db.clone();
            let _ = tokio::task::spawn_blocking(move || {
                crate::cloud_backup::tick(&connect, last, now, &db);
            })
            .await;
        }
    });

    let scrub_state = state.clone();
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(10 * 60));
        loop {
            ticker.tick().await;
            let hour = crate::scrub::local_hour_now();
            let now = crate::db::now_unix();
            let last_run = scrub_state
                .db
                .lock()
                .ok()
                .and_then(|conn| {
                    crate::db::get_meta(&conn, "last_periodic_scrub_at")
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
            if !crate::scrub::should_run_periodic(running, hour, last_run, last_activity, now) {
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
                let _ = crate::scrub::scrub_all_drives_unlocked(&db);
                if let Ok(conn) = db.lock() {
                    let _ = crate::db::set_meta(&conn, "last_periodic_scrub_at", &now.to_string());
                    let _ = crate::db::wal_checkpoint_passive(&conn);
                    let last_vac = crate::db::get_meta(&conn, "last_vacuum_at")
                        .ok()
                        .flatten()
                        .and_then(|raw| raw.parse::<i64>().ok())
                        .unwrap_or(0);
                    // Compact at most monthly — VACUUM rewrites the whole file.
                    if now.saturating_sub(last_vac) >= 30 * 24 * 60 * 60
                        && crate::db::vacuum_if_possible(&conn).is_ok()
                    {
                        let _ = crate::db::set_meta(&conn, "last_vacuum_at", &now.to_string());
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
            let hour = crate::scrub::local_hour_now();
            let now = crate::db::now_unix();
            let last_run = trim_state
                .db
                .lock()
                .ok()
                .and_then(|conn| crate::db::get_meta(&conn, "last_fstrim_at").ok().flatten())
                .and_then(|raw| raw.parse::<i64>().ok());
            let last_activity = trim_state
                .last_io_activity
                .load(std::sync::atomic::Ordering::Relaxed);
            if !crate::fstrim::should_run_fstrim(false, hour, last_run, last_activity, now) {
                continue;
            }
            let db = trim_state.db.clone();
            let _ = tokio::task::spawn_blocking(move || {
                if let Ok(conn) = db.lock() {
                    let _ = crate::fstrim::fstrim_all_drives(&conn);
                    let _ = crate::db::set_meta(&conn, "last_fstrim_at", &now.to_string());
                }
            })
            .await;
        }
    });

    let protected_api = api::router()
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            crate::auth::guard,
        ))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            crate::api::public_limits::limit_public_album_uploads,
        ))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            touch_io_activity,
        ));
    let app = axum::Router::new()
        .merge(protected_api)
        .merge(crate::dav::router())
        .with_state(state)
        .fallback(axum::routing::get(|uri: axum::http::Uri| async move {
            crate::staticweb::handle(uri.path())
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
    axum::extract::State(state): axum::extract::State<crate::AppState>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let path = req.uri().path();
    if path.contains("/files")
        || path.starts_with("/api/v1/uploads")
        || path.starts_with("/api/v1/jobs")
        || path.starts_with("/s/")
    {
        state.touch_io_activity();
    }
    next.run(req).await
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}

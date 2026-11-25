use std::net::SocketAddr;

use lunad::{
    AppState, api, config::Config, db, drives::DriveManager, drives::mount::CommandMounter,
};

fn main() -> anyhow::Result<()> {
    // D1 (process start to answering requests) counts from here.
    let started = std::time::Instant::now();
    // The sandboxed text reader: lunad re-runs itself as `nobody` with
    // memory and CPU caps to parse one file, then exits. No runtime, no logs.
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some(lunad::files::content::worker::SUBCOMMAND) {
        std::process::exit(lunad::files::content::worker::worker_main(&args[2..]));
    }
    // Printed bare (no prefix) so the version is machine-readable: the release
    // smoke test compares it against the version the build stamped in.
    if std::env::args()
        .skip(1)
        .any(|a| a == "--version" || a == "-V")
    {
        println!("{}", lunad::version());
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
        .block_on(async_main(started))
}

/// Sleep until the system has been up for `seconds`, if it has not been yet.
/// Returns how long it slept.
fn wait_for_usb_to_settle(seconds: f64) -> std::time::Duration {
    let up = std::fs::read_to_string("/proc/uptime").ok().and_then(|t| {
        t.split_whitespace()
            .next()
            .and_then(|v| v.parse::<f64>().ok())
    });
    if let Some(up) = up
        && up < seconds
    {
        let wait = std::time::Duration::from_secs_f64((seconds - up).min(seconds));
        tracing::info!(
            seconds = wait.as_secs_f32(),
            "waiting for USB drives to show up"
        );
        std::thread::sleep(wait);
        return wait;
    }
    std::time::Duration::ZERO
}

async fn async_main(started: std::time::Instant) -> anyhow::Result<()> {
    // Perf logs (target lunad::perf) stay off unless LUNA_PERF=1 or RUST_LOG
    // names the target; see luna/perf/README.md.
    let perf = lunad::perf::settings_from(
        std::env::var("LUNA_PERF").ok().as_deref(),
        std::env::var("RUST_LOG").ok().as_deref(),
    );
    lunad::perf::set_enabled(perf.enabled);
    let mut filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| "lunad=info,tower_http=warn".into());
    if let Some(directive) = perf.directive.as_deref().and_then(|d| d.parse().ok()) {
        filter = filter.add_directive(directive);
    }
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .compact()
        .init();
    let perf_sampler = perf
        .enabled
        .then(|| lunad::perf::spawn_sampler(lunad::perf::sample_interval()));

    let mut cfg = Config::from_env().overlay_from_args();
    // The data dir holds device tokens, session secrets, the user database,
    // and the binaries the daemon runs — so it must belong to the account the
    // daemon runs as, and to nobody else. Preparing it also keeps it
    // owner-only, even when it already existed with looser permissions.
    if let Err(e) = lunad::datadir::prepare(&cfg.data_dir, lunad::datadir::current_uid()) {
        // Fail closed: a silent scratch dir under a shared /tmp would expose
        // device tokens, session secrets, and the user database. Only a dev
        // who opts in with LUNA_ALLOW_TMP_DATA=1 gets the fallback.
        if lunad::datadir::is_ownership_error(&e)
            || std::env::var("LUNA_ALLOW_TMP_DATA").ok().as_deref() != Some("1")
        {
            return Err(anyhow::anyhow!(
                "could not prepare the data dir {}: {e}",
                cfg.data_dir.display()
            ));
        }
        let fallback = std::env::temp_dir().join("luna-data");
        lunad::datadir::prepare(&fallback, lunad::datadir::current_uid())?;
        tracing::warn!(data_dir = %cfg.data_dir.display(), fallback = %fallback.display(), "data dir unusable, using scratch dir");
        cfg.data_dir = fallback;
    }
    let mut conn = db::open(&cfg.db_path())?;
    // Row changes the HDMI console shows ask it to look again (no polling).
    lunad::system::console::watch_db(&mut conn);
    // Nothing is uploading yet, so any cloud backup run left open by a crash or restart is over.
    let ended_runs = db::recover_interrupted_runs(&conn, db::now_unix())?;
    if ended_runs > 0 {
        tracing::info!(
            ended_runs,
            "ended cloud backup runs interrupted by a restart"
        );
    }
    let drive_manager = std::sync::Arc::new(DriveManager::new(
        std::sync::Arc::new(CommandMounter),
        &cfg.data_dir,
    ));
    // USB sticks need a couple of seconds after power-on to show up, and this
    // is the only look at them before the password-recovery stick scan below
    // (it runs once, before the network is up). Starting this early on a fast
    // boot would miss them, so give them until 8 seconds of uptime.
    let usb_wait = wait_for_usb_to_settle(8.0);
    let detected = {
        let mounts = std::fs::read_to_string("/proc/mounts").unwrap_or_default();
        lunad::drives::detect::scan_with_dev_mocks(std::path::Path::new("/sys/block"), &mounts)
    };
    tracing::info!(
        drives = ?detected.iter().map(|d| d.name.as_str()).collect::<Vec<_>>(),
        "drives seen at startup"
    );
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
    // each mounted drive's marker database before photos catch-up or search
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
    // Luna is left on for weeks: an upload someone abandoned must not hold a
    // drive's space until the next restart.
    {
        let db = state.db.clone();
        lunad::clock::every(std::time::Duration::from_secs(60 * 60), false, move || {
            lunad::files::uploads::sweep_orphans(&db)
        });
    }

    // Rate-limit buckets are keyed per client and only matter while their
    // window or lock is live. A Luna left on for weeks must not grow the
    // table forever, so drop the dead ones on the same hourly beat.
    {
        let db = state.db.clone();
        lunad::clock::every(std::time::Duration::from_secs(60 * 60), false, move || {
            lunad::api::form_limits::prune_rate_limits(&db);
        });
    }

    // Catch-up photos index for every adopted mount already on disk.
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
            state.photos.watch_mount(&id, mount);
        }
    }

    let connect_poll_wake = state.connect.poll_wake();
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
                const RESTART_GAP: Duration = Duration::from_secs(5);
                let mut last_restart: Option<std::time::Instant> = None;
                // What the HDMI console shows of Connect; a change asks it to look again.
                let mut shown = lunad::system::console::ConnectShown::default();

                // Connect turning on (a device token saved) wakes this loop;
                // the cloud backup key mover sleeps until then.
                let mut was_active = false;
                while !stop.load(Ordering::Relaxed) {
                    let _ = connect.poll_status();
                    let active = connect.is_connect_active();
                    if active && !was_active {
                        lunad::backup::cloud::rewrap::nudge();
                    }
                    was_active = active;
                    // Supervisor: if Connect poll failed/flapped but local tunnel credentials exist,
                    // keep (re)starting cloudflared so DNS does not stick on Error 1033.
                    connect.ensure_tunnel_if_needed();
                    shown.note(&connect.status());
                    // No device token: nothing to pull or watch until one is
                    // saved, and saving one wakes this loop (D3: no timer).
                    if !active {
                        wake.wait_forever();
                        continue;
                    }
                    let setup_open = db
                        .lock()
                        .map(|conn| lunad::auth::setup_wizard_open_conn(&conn))
                        .unwrap_or(false);
                    let interval = Duration::from_secs(connect.poll_interval_secs(setup_open));
                    let deadline = std::time::Instant::now() + interval;
                    // Block until the next pull (or a wake) instead of ticking every
                    // second. While a tunnel is expected but its child can't be
                    // watched (no pidfd, or a connector left by an earlier lunad),
                    // look every 5 s during long steady-state waits (300 s):
                    // otherwise a dead cloudflared is not noticed until the next poll.
                    while !stop.load(Ordering::Relaxed) {
                        let left = deadline.saturating_duration_since(std::time::Instant::now());
                        if left.is_zero() {
                            break;
                        }
                        // A watched cloudflared wakes this loop itself when
                        // it exits; only an unwatched one is looked at.
                        let slice = if connect.expects_tunnel() && !connect.tunnel_watched() {
                            left.min(Duration::from_secs(5))
                        } else {
                            left
                        };
                        if wake.wait(slice) {
                            if !connect.take_tunnel_exit() {
                                break;
                            }
                            // The watched cloudflared exited: restart it, at
                            // most every 5 s so one that dies at once can't spin.
                            if let Some(at) = last_restart {
                                std::thread::sleep(RESTART_GAP.saturating_sub(at.elapsed()));
                            }
                            last_restart = Some(std::time::Instant::now());
                        }
                        connect.ensure_tunnel_if_needed();
                        shown.note(&connect.status());
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
            // Rebuilds the screen on network, database and Connect changes,
            // with a 30-minute look for text that changes with time; holds the
            // lock luna-console reads to tell that lunad is running.
            .spawn(move || lunad::system::console::run(&data_dir, &db, &connect, stop))
            .ok();
    }

    // Catch changes made behind Luna's back: folders whose timestamp hasn't
    // moved cost one stat each. A drive with an armed change watch already
    // tells search about each change (photos_indexer), so it is re-read only
    // every 6 hours in case the kernel dropped events unnoticed; a drive
    // without one (watch limit reached) every 15 minutes (D3).
    let rescan_state = state.clone();
    {
        const WATCHED_EVERY: u32 = 24;
        let mut ticks = 0u32;
        lunad::clock::every(std::time::Duration::from_secs(15 * 60), false, move || {
            ticks = ticks.wrapping_add(1);
            let all = ticks.is_multiple_of(WATCHED_EVERY);
            let drives = rescan_state
                .db
                .lock()
                .ok()
                .map(|conn| lunad::files::search::indexable_drives(&conn, true))
                .unwrap_or_default();
            let drives: Vec<_> = drives
                .into_iter()
                .filter(|d| all || !rescan_state.photos.is_watching(&d.id))
                .map(|d| (d.id, d.mount))
                .collect();
            if !drives.is_empty() {
                rescan_state.search_index.rescan(drives, false);
            }
        });
    }

    // Drive health: has a drive gone read-only? The clock thread only reads
    // the drive list and mount flags; a probe that writes (only when the drive
    // was written since, or hourly: DriveManager::health_probe, so an idle disk
    // can spin down) runs on its own thread, without the database lock, since
    // it can wait seconds on a USB disk spinning up. One probe at a time.
    let health_db = state.db.clone();
    let health_drives = state.drive_manager.clone();
    let probing = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    lunad::clock::every(std::time::Duration::from_secs(15 * 60), true, move || {
        use std::sync::atomic::Ordering;
        let Some(rows) = health_db
            .lock()
            .ok()
            .and_then(|c| lunad::db::list_drives(&c).ok())
        else {
            return;
        };
        if !health_drives.health_probe_due(&rows) || probing.swap(true, Ordering::AcqRel) {
            return;
        }
        let (db, drives, busy) = (health_db.clone(), health_drives.clone(), probing.clone());
        let spawned = std::thread::Builder::new()
            .name("luna-drive-probe".into())
            .spawn(move || {
                let changes = drives.health_probe(&rows);
                busy.store(false, Ordering::Release);
                let Ok(conn) = db.lock() else { return };
                for (id, was, state) in changes {
                    // Skip a drive whose state moved on while it was probed
                    // (ejected, formatting, marked by another path).
                    let unchanged = lunad::db::get_drive(&conn, &id)
                        .ok()
                        .flatten()
                        .is_some_and(|d| d.state == was);
                    if unchanged {
                        let _ = lunad::db::set_drive_state(&conn, &id, state);
                    }
                }
            });
        if spawned.is_err() {
            probing.store(false, Ordering::Release);
        }
    });

    // Reclaimable RAM caches: shrink thumbs/listings under MemAvailable pressure;
    // flush dirty writes early rather than dropping them.
    // An empty cache has nothing to reclaim, so the loop sleeps until
    // something is cached instead of waking every 5 s on an idle Luna.
    // While it holds something it wakes at once on a kernel memory-stall
    // report, and on a timer (every minute, every 5 s close to the line) only
    // where the kernel gives no stall reports or memory is close to the line;
    // otherwise its one timed wake is when the cache empties itself after
    // IDLE_EXPIRY without use, so a used-but-idle Luna sleeps (D3).
    let pressure_state = state.clone();
    let stalled = std::sync::Arc::new(tokio::sync::Notify::new());
    let psi = lunad::drives::ram_cache::watch_memory_pressure(stalled.clone());
    tracing::info!(
        psi,
        "RAM cache: memory stalls {}",
        if psi {
            "wake the pressure check"
        } else {
            "not reported by this kernel; pressure check runs on its timer"
        }
    );
    bg_tasks.push(tokio::spawn(async move {
        use lunad::drives::ram_cache::{IDLE_EXPIRY, pressure_wait, psi_watching, reclaim_on_wake};
        let cache = &pressure_state.ram_cache;
        loop {
            cache.wait_until_filled().await;
            let wait = pressure_wait(
                lunad::budget::meminfo().available_bytes,
                psi_watching(),
                cache.idle_left(IDLE_EXPIRY),
            );
            let stall = tokio::select! {
                _ = lunad::clock::sleep(wait) => false,
                _ = stalled.notified() => true,
            };
            // Expiry is a quick in-memory clear; an emptied cache has nothing
            // to reclaim, so no blocking thread is started for it.
            if cache.expire_idle(IDLE_EXPIRY) {
                continue;
            }
            // Woken for an expiry that later use moved on: sleep again.
            if !reclaim_on_wake(
                stall,
                psi_watching(),
                lunad::budget::meminfo().available_bytes,
            ) {
                continue;
            }
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

    // exFAT and FAT drives have no journal: write out what the kernel holds a
    // few seconds after a change instead of leaving it for the kernel's own
    // half-minute timer, so a power cut loses as little as possible.
    // It sleeps until Luna writes something, a backstop falls due, or (with
    // no such drive in use) a slow re-check, so an idle Luna stays asleep.
    let flush_state = state.clone();
    bg_tasks.push(tokio::spawn(async move {
        use lunad::drives::flusher::{IDLE_RECHECK, TICK};
        let mut planner = lunad::drives::flusher::Planner::default();
        let mut wait = std::time::Duration::ZERO;
        // Drives with a write-out still running. A stick that stopped
        // answering can hold syncfs for good; it is skipped, never waited on,
        // so the other drives keep being written out.
        let in_flight: std::sync::Arc<std::sync::Mutex<std::collections::HashSet<String>>> =
            Default::default();
        loop {
            tokio::select! {
                _ = lunad::clock::sleep(wait) => {}
                _ = lunad::drives::ram_cache::drive_written() => {
                    // Let a burst of writes finish, then write them out together.
                    tokio::time::sleep(TICK).await;
                }
                // A drive was adopted, mounted or changed state (console::watch_db).
                _ = lunad::drives::flusher::drives_changed() => {}
            }
            wait = TICK;
            let drives = flush_state
                .db
                .lock()
                .ok()
                .and_then(|conn| lunad::db::list_drives(&conn).ok());
            let Some(drives) = drives else { continue };
            let mounts = std::fs::read_to_string("/proc/mounts").unwrap_or_default();
            let mut live = Vec::new();
            for d in drives {
                if d.mount_point.is_empty() || (d.state != "as_is" && d.state != "readonly") {
                    continue;
                }
                let mount = std::path::PathBuf::from(&d.mount_point);
                let real = std::fs::canonicalize(&mount).unwrap_or_else(|_| mount.clone());
                if !lunad::files::fsrules::rules_from_mounts(&mounts, &real).is_restricted() {
                    continue;
                }
                live.push(d.id.clone());
                if in_flight.lock().map_or(true, |g| g.contains(&d.id)) {
                    continue;
                }
                let generation = lunad::drives::ram_cache::drive_write_gen(&d.id);
                if planner.due(&d.id, generation, std::time::Instant::now()) {
                    if let Ok(mut g) = in_flight.lock() {
                        g.insert(d.id.clone());
                    }
                    let (id, in_flight) = (d.id.clone(), in_flight.clone());
                    tokio::task::spawn_blocking(move || {
                        let _ = lunad::drives::sync_filesystem(&mount);
                        if let Ok(mut g) = in_flight.lock() {
                            g.remove(&id);
                        }
                    });
                }
            }
            planner.retain(&live);
            // A write-out still running is looked at again soon, as before;
            // otherwise sleep until the next backstop (or the slow re-check).
            let busy = in_flight.lock().map_or(true, |g| !g.is_empty());
            if !busy {
                let now = std::time::Instant::now();
                wait = planner
                    .next_backstop()
                    .map_or(IDLE_RECHECK, |at| at.saturating_duration_since(now))
                    .max(TICK);
            }
        }
    }));

    // luna-boot-ok confirms the boot after lunad is up, so look for it often
    // until a freshly installed OS image has settled. With no image waiting
    // the loop ends: an image installed later records this boot and only
    // settles after a restart, when this loop starts again.
    let updates_settle = state.updates.clone();
    bg_tasks.push(tokio::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(15));
        loop {
            ticker.tick().await;
            let svc = updates_settle.clone();
            let waiting = tokio::task::spawn_blocking(move || {
                svc.settle_os_boot();
                svc.has_pending_os()
            })
            .await
            .unwrap_or(true);
            if !waiting {
                break;
            }
        }
    }));

    let updates_bg = state.updates.clone();
    bg_tasks.push(tokio::spawn(async move {
        let mut ticker = lunad::clock::interval(std::time::Duration::from_secs(3600));
        ticker.tick().await;
        loop {
            let svc = updates_bg.clone();
            let version = lunad::version().to_string();
            let _ = tokio::task::spawn_blocking(move || {
                let _ = svc.check(&version, false);
            })
            .await;
            ticker.tick().await;
        }
    }));

    // Cloud backups: copy every active backup to Luna Connect every 6 hours,
    // and check a sample of each one once a day. Each loop awaits its own run
    // before waiting again, so runs never overlap.
    let cloud_db = state.db.clone();
    let cloud_connect = state.connect.clone();
    let cloud_health = state.health_cache.clone();
    bg_tasks.push(tokio::spawn(async move {
        let mut ticker = lunad::clock::interval(std::time::Duration::from_secs(6 * 60 * 60));
        loop {
            ticker.tick().await;
            let db = cloud_db.clone();
            let connect = cloud_connect.clone();
            let changed = tokio::task::spawn_blocking(move || {
                let store = lunad::api::cloud_backups::connect_store(&connect, &db);
                let store_ref = store
                    .as_ref()
                    .map(|s| s as &dyn lunad::backup::cloud::store::CloudStore);
                lunad::backup::cloud::ops::run_all(&db, store_ref, &connect, lunad::db::now_unix())
            })
            .await
            .unwrap_or(false);
            if changed {
                cloud_health.invalidate();
            }
        }
    }));

    // Cloud backups moving to the newest key: a few small steps every minute, only while Luna
    // Connect is active. Steps take each backup's run lock, so they never overlap a backup.
    let move_db = state.db.clone();
    let move_connect = state.connect.clone();
    // With nothing to move (the usual case) the wait doubles up to 30 minutes,
    // and a new key version (see console::watch_db) cuts it short. Without
    // Connect there is nothing to move, so it sleeps with no timer until a
    // nudge: a new key version, or Connect turning on (the Connect status loop).
    bg_tasks.push(tokio::spawn(async move {
        const STEP_GAP: std::time::Duration = std::time::Duration::from_secs(60);
        const IDLE_MAX: std::time::Duration = std::time::Duration::from_secs(30 * 60);
        let mut wait = STEP_GAP;
        loop {
            if move_connect.is_connect_active() {
                tokio::select! {
                    _ = lunad::clock::sleep(wait) => {}
                    _ = lunad::backup::cloud::rewrap::nudged() => wait = STEP_GAP,
                }
            } else {
                lunad::backup::cloud::rewrap::nudged().await;
                wait = STEP_GAP;
            }
            if !move_connect.is_connect_active() {
                continue;
            }
            let db = move_db.clone();
            let connect = move_connect.clone();
            let worked = tokio::task::spawn_blocking(move || {
                let store = lunad::api::cloud_backups::connect_store(&connect, &db);
                let store_ref = store
                    .as_ref()
                    .map(|s| s as &dyn lunad::backup::cloud::store::CloudStore);
                lunad::backup::cloud::rewrap::trickle(&db, store_ref, lunad::db::now_unix())
            })
            .await
            .unwrap_or(0);
            wait = if worked > 0 {
                STEP_GAP
            } else {
                (wait * 2).min(IDLE_MAX)
            };
        }
    }));

    let check_db = state.db.clone();
    let check_connect = state.connect.clone();
    let check_health = state.health_cache.clone();
    bg_tasks.push(tokio::spawn(async move {
        let mut ticker = lunad::clock::interval(std::time::Duration::from_secs(24 * 60 * 60));
        loop {
            ticker.tick().await;
            let db = check_db.clone();
            let connect = check_connect.clone();
            let _ = tokio::task::spawn_blocking(move || {
                // Without Connect there is nothing to check against.
                if let Some(store) = lunad::api::cloud_backups::connect_store(&connect, &db) {
                    lunad::backup::cloud::ops::check_all(&db, &store, lunad::db::now_unix());
                }
            })
            .await;
            check_health.invalidate();
        }
    }));

    // Drive backups: rebuild the backup list from the copies on the drives
    // once at start, then run every active backup every 30 minutes.
    let backups_db = state.db.clone();
    let backups_health = state.health_cache.clone();
    bg_tasks.push(tokio::spawn(async move {
        let db = backups_db.clone();
        let rebuilt = tokio::task::spawn_blocking(move || {
            let conn = db.lock().unwrap_or_else(|p| p.into_inner());
            lunad::backup::drive_backup::rebuild_from_manifests(&conn)
        })
        .await
        .unwrap_or(0);
        if rebuilt > 0 {
            backups_health.invalidate();
        }
        let mut ticker = lunad::clock::interval(std::time::Duration::from_secs(30 * 60));
        loop {
            ticker.tick().await;
            // No drive backup at all (the usual idle case): no blocking thread.
            let any = backups_db
                .lock()
                .ok()
                .and_then(|c| lunad::db::list_protections(&c).ok())
                .is_none_or(|rows| rows.iter().any(|r| r.kind == lunad::db::PROTECTION_DRIVE));
            if !any {
                continue;
            }
            let db = backups_db.clone();
            let changed = tokio::task::spawn_blocking(move || {
                lunad::backup::drive_backup::run_all(&db, lunad::db::now_unix())
            })
            .await
            .unwrap_or(false);
            if changed {
                backups_health.invalidate();
            }
        }
    }));

    // Scrub and trim only run in the night window: outside it they sleep
    // until it opens instead of waking every few minutes all day.
    let scrub_state = state.clone();
    bg_tasks.push(tokio::spawn(async move {
        loop {
            lunad::clock::sleep(lunad::drives::scrub::next_night_look(
                std::time::Duration::from_secs(10 * 60),
            ))
            .await;
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
        loop {
            lunad::clock::sleep(lunad::drives::scrub::next_night_look(
                std::time::Duration::from_secs(30 * 60),
            ))
            .await;
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
                // Snapshot the registry, then trim without the lock: a trim
                // can take minutes and every request needs that lock.
                let Some(drives) = db.lock().ok().and_then(|c| lunad::db::list_drives(&c).ok())
                else {
                    return;
                };
                lunad::drives::fstrim::fstrim_drives(&drives);
                if let Ok(conn) = db.lock() {
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
            loop {
                // No rooms, nothing to drop: sleep until one opens.
                hub.wait_for_rooms().await;
                tokio::time::sleep(std::time::Duration::from_secs(30)).await;
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
            loop {
                hub.wait_for_sessions().await;
                tokio::time::sleep(std::time::Duration::from_secs(60)).await;
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
            lunad::api::public_limits::limit_public_requests,
        ))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            touch_io_activity,
        ));
    let eurooffice_dir = lunad::packs::dir(&cfg.data_dir, "eurooffice");
    let mut app = axum::Router::new()
        .merge(protected_api)
        // WebDAV sits outside protected_api (it authenticates itself) but is
        // file traffic all the same.
        .merge(
            lunad::files::dav::router()
                .layer(axum::middleware::from_fn_with_state(
                    state.clone(),
                    touch_io_activity,
                ))
                // Closed until Luna has its first account.
                .layer(axum::middleware::from_fn_with_state(
                    state.clone(),
                    lunad::auth::pre_setup_gate,
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
                ))
                // The editor and its socket stay closed until Luna has its
                // first account; `/fonts/` stays open (the web app uses it).
                .layer(axum::middleware::from_fn_with_state(
                    state.clone(),
                    lunad::auth::pre_setup_gate,
                )),
        );
    }
    // Self-hosted diagrams.net webapp — a plain static pack, no dispatcher
    // tricks (unlike EuroOffice the pack's URLs are unversioned and there's
    // no socket). The editor iframe is same-origin and speaks postMessage.
    let drawio_dir = lunad::packs::dir(&cfg.data_dir, "drawio");
    if drawio_dir.is_dir() {
        tracing::info!(dir = %drawio_dir.display(), "serving draw.io assets");
        app = app.merge(
            axum::Router::new()
                .route("/drawio/{*tail}", axum::routing::any(drawio_dispatch))
                .layer(axum::middleware::from_fn(
                    lunad::api::office::pack_security_headers,
                ))
                .layer(axum::middleware::from_fn_with_state(
                    state.clone(),
                    lunad::auth::pre_setup_gate,
                )),
        );
    }
    let app = app
        .with_state(state.clone())
        .fallback(axum::routing::get(|uri: axum::http::Uri| async move {
            lunad::system::staticweb::handle(uri.path())
        }))
        // A no-op unless perf is enabled.
        .layer(axum::middleware::from_fn(lunad::perf::http_timing))
        // Outermost, so a blocked LAN client reaches no route at all.
        .layer(axum::middleware::from_fn_with_state(
            state,
            lunad::auth::lan_guard,
        ));

    let addr: SocketAddr = format!("{}:{}", cfg.host, cfg.port).parse()?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(%addr, product = "Luna", "listening");
    tracing::info!(
        target: lunad::perf::TARGET,
        journey = "D1",
        op = "startup",
        ms = started.elapsed().as_millis() as u64,
        usb_wait_ms = usb_wait.as_millis() as u64,
        "perf"
    );
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await?;
    // Deterministic teardown: a service stop must not leave the managed
    // cloudflared running or the supervisors ticking behind a dead listener.
    shutting_down.store(true, std::sync::atomic::Ordering::Relaxed);
    connect_poll_wake.wake();
    connect.stop_tunnel();
    for task in bg_tasks.into_iter().chain(perf_sampler) {
        task.abort();
    }
    Ok(())
}

/// Static draw.io pack — every `/drawio/**` request serves from the pack
/// directory (the OS image's copy, see `lunad::packs`). Missing files 404
/// rather than falling through to the SPA fallback, so the web app's pack
/// probe (`/drawio/pack.json`) can tell "pack present, file absent" from
/// "no pack".
async fn drawio_dispatch(
    axum::extract::State(state): axum::extract::State<lunad::AppState>,
    axum::extract::Path(tail): axum::extract::Path<String>,
    mut req: axum::extract::Request,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    use tower::ServiceExt;
    let dir = lunad::packs::dir(&state.data_dir, "drawio");
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

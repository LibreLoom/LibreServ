pub mod access;
pub mod api;
pub mod auth;
pub mod backup;
pub mod budget;
pub mod config;
pub mod db;
pub mod dev_mock;
pub mod drives;
pub mod files;
pub mod gallery;
pub mod hibp;
pub mod jobs;
pub mod net;
pub mod office;
pub mod password;
pub mod private;
pub mod rate_limit;
pub mod search_query;
pub mod secrets;
pub mod system;
#[cfg(test)]
pub(crate) mod testutil;
pub mod time;
use std::sync::{Arc, Mutex, MutexGuard};

use rusqlite::Connection;

use crate::drives::DriveManager;

pub type DavHandler = dav_server::DavHandler;

/// Luna's main database connection behind a mutex that survives a panic.
///
/// A plain `Mutex` stays poisoned after any thread panics while holding it,
/// and every later request would fail until lunad restarts — which a user
/// can't do from the UI. `lock` instead rolls back whatever transaction the
/// panicking thread left open and hands the connection on. SQLite keeps the
/// file consistent on its own; only the half-done work is dropped.
pub struct Db(
    Mutex<Connection>,
    Mutex<std::collections::HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
);

impl Db {
    pub fn new(conn: Connection) -> Self {
        Self(Mutex::new(conn), Mutex::default())
    }

    /// The drive's mutation lock. Whoever changes files or trash on a drive
    /// holds it from the check through the change, so two writers to the same
    /// item queue instead of interleaving, while the database lock stays
    /// free for everyone else. Always take it BEFORE the database lock.
    pub fn drive_lock(&self, drive_id: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut locks = self.1.lock().unwrap_or_else(|p| p.into_inner());
        locks.entry(drive_id.to_string()).or_default().clone()
    }

    /// Never returns `Err` — the `LockResult` shape keeps existing call sites
    /// unchanged.
    pub fn lock(&self) -> std::sync::LockResult<MutexGuard<'_, Connection>> {
        Ok(self.0.lock().unwrap_or_else(|poisoned| {
            tracing::error!("recovering the database lock after a panic");
            self.0.clear_poison();
            let conn = poisoned.into_inner();
            if !conn.is_autocommit() {
                let _ = conn.execute_batch("ROLLBACK");
            }
            conn
        }))
    }
}

#[derive(Clone)]
pub struct AppState {
    pub db: Arc<Db>,
    pub drive_manager: Arc<DriveManager>,
    pub job_manager: Arc<crate::jobs::JobManager>,
    pub gallery: Arc<crate::gallery::gallery_indexer::GalleryIndexer>,
    pub auth: Arc<crate::auth::AuthService>,
    pub connect: Arc<crate::net::connect::ConnectService>,
    pub login_limiter: Arc<crate::rate_limit::RateLimiter>,
    pub dav_limiter: Arc<crate::rate_limit::RateLimiter>,
    pub share_limiter: Arc<crate::rate_limit::RateLimiter>,
    pub public_upload_limiter: Arc<crate::rate_limit::RateLimiter>,
    /// Unauthenticated form answers (`POST /s/{token}/respond`).
    pub form_respond_limiter: Arc<crate::rate_limit::RateLimiter>,
    pub share_auth: Arc<crate::rate_limit::ShareAuthGuard>,
    pub data_dir: std::path::PathBuf,
    pub updates: std::sync::Arc<crate::system::updates::UpdateService>,
    pub health_cache: crate::system::system_health::HealthCache,
    pub ram_cache: crate::drives::ram_cache::RamCache,
    pub last_io_activity: std::sync::Arc<std::sync::atomic::AtomicI64>,
    pub scrub_running: std::sync::Arc<std::sync::atomic::AtomicBool>,
    /// Reads whole drives into the file index so search finds every folder.
    pub search_index: Arc<crate::files::search_indexer::SearchIndexer>,
    pub collab: std::sync::Arc<crate::office::collab::CollabHub>,
    pub office_docs: std::sync::Arc<crate::office::office_docs::OfficeDocHub>,
}

impl AppState {
    pub fn new(
        conn: Connection,
        drive_manager: Arc<DriveManager>,
        data_dir: &std::path::Path,
    ) -> Self {
        private::install();
        let db = Arc::new(crate::Db::new(conn));
        let secret =
            crate::secrets::ensure_jwt_secret(data_dir, &db.lock().unwrap()).expect("jwt secret");
        let auth = Arc::new(crate::auth::AuthService::new(
            db.clone(),
            secret,
            data_dir.to_path_buf(),
        ));
        let gallery = crate::gallery::gallery_indexer::GalleryIndexer::start();
        let job_manager = Arc::new(crate::jobs::JobManager::new(db.clone(), gallery.clone()));
        let updates = Arc::new(crate::system::updates::UpdateService::from_db(
            &db.lock().unwrap(),
            data_dir,
        ));
        Self {
            db: db.clone(),
            drive_manager,
            job_manager,
            gallery,
            auth,
            connect: Arc::new(crate::net::connect::ConnectService::new(
                data_dir,
                std::env::var("LUNA_CONNECT_URL").ok(),
            )),
            login_limiter: Arc::new(crate::rate_limit::RateLimiter::new(
                db.clone(),
                std::time::Duration::from_secs(300),
                10,
            )),
            dav_limiter: Arc::new(crate::rate_limit::RateLimiter::new(
                db.clone(),
                std::time::Duration::from_secs(300),
                10,
            )),
            share_limiter: Arc::new(crate::rate_limit::RateLimiter::new(
                db.clone(),
                std::time::Duration::from_secs(60),
                5,
            )),
            // Guest album uploads (token in URL): keep abuse off the USB-backed indexer.
            public_upload_limiter: Arc::new(crate::rate_limit::RateLimiter::new(
                db.clone(),
                std::time::Duration::from_secs(60),
                20,
            )),
            // Form answers arrive one submit at a time; a burst per IP is spam.
            form_respond_limiter: Arc::new(crate::rate_limit::RateLimiter::new(
                db.clone(),
                std::time::Duration::from_secs(60),
                12,
            )),
            share_auth: Arc::new(crate::rate_limit::ShareAuthGuard::new(db)),
            data_dir: data_dir.to_path_buf(),
            updates,
            health_cache: crate::system::system_health::HealthCache::default(),
            ram_cache: crate::drives::ram_cache::RamCache::new(),
            last_io_activity: Arc::new(std::sync::atomic::AtomicI64::new(0)),
            scrub_running: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            search_index: crate::files::search_indexer::SearchIndexer::start(),
            collab: Arc::new(crate::office::collab::CollabHub::new()),
            office_docs: Arc::new(crate::office::office_docs::OfficeDocHub::new()),
        }
    }

    pub fn with_connect(mut self, connect: Arc<crate::net::connect::ConnectService>) -> Self {
        self.connect = connect;
        self
    }

    pub fn with_updates(mut self, updates: Arc<crate::system::updates::UpdateService>) -> Self {
        self.updates = updates;
        self
    }

    pub fn touch_io_activity(&self) {
        self.last_io_activity
            .store(crate::db::now_unix(), std::sync::atomic::Ordering::Relaxed);
    }
}

/// Does a request path move or read file data? Such requests keep the nightly
/// scrub from starting. Matches whole path prefixes: a folder that merely has
/// `/files` in its name (`/api/v1/me/files-backup`) is not file traffic.
pub fn is_io_path(path: &str) -> bool {
    const PREFIXES: [&str; 4] = ["/api/v1/uploads", "/api/v1/jobs", "/s/", "/dav/"];
    if PREFIXES.iter().any(|p| path.starts_with(p)) {
        return true;
    }
    // /api/v1/drives/{id}/files[/...]
    path.strip_prefix("/api/v1/drives/")
        .and_then(|rest| rest.split_once('/'))
        .is_some_and(|(_, tail)| tail == "files" || tail.starts_with("files/"))
}

#[cfg(test)]
mod io_path_tests {
    use super::is_io_path;

    #[test]
    fn counts_file_webdav_upload_job_and_share_traffic() {
        for path in [
            "/api/v1/drives/d1/files",
            "/api/v1/drives/d1/files/content",
            "/api/v1/uploads/abc",
            "/api/v1/jobs",
            "/s/token/file",
            "/dav/d1/photos/a.jpg",
        ] {
            assert!(is_io_path(path), "{path}");
        }
    }

    #[test]
    fn ignores_everything_else() {
        for path in [
            "/api/v1/auth/me",
            "/api/v1/me/files-backup",
            "/api/v1/drives/d1/filesystem",
            "/api/v1/drives",
            "/dashboard/files",
            "/davinci",
        ] {
            assert!(!is_io_path(path), "{path}");
        }
    }
}

#[cfg(test)]
mod db_lock_tests {
    use super::*;

    #[test]
    fn lock_recovers_after_a_panic_mid_transaction() {
        let db = Arc::new(Db::new(Connection::open_in_memory().unwrap()));
        db.lock()
            .unwrap()
            .execute_batch("CREATE TABLE t (v INTEGER)")
            .unwrap();
        let d2 = db.clone();
        let crashed = std::thread::spawn(move || {
            let conn = d2.lock().unwrap();
            conn.execute_batch("BEGIN; INSERT INTO t VALUES (1);")
                .unwrap();
            panic!("simulated crash while holding the lock");
        })
        .join();
        assert!(crashed.is_err());

        let conn = db.lock().expect("a panic must not leave the lock unusable");
        assert!(
            conn.is_autocommit(),
            "the half-done transaction is rolled back"
        );
        let rows: i64 = conn
            .query_row("SELECT count(*) FROM t", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 0);
        conn.execute_batch("INSERT INTO t VALUES (2)").unwrap();
    }
}

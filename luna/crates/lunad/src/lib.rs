pub mod api;
pub mod auth;
pub mod cloud_backup;
pub mod config;
pub mod connect;
pub mod console;
pub mod dav;
pub mod db;
pub mod detect;
pub mod drives;
pub mod exif;
pub mod files;
pub mod gallery;
pub mod heif;
pub mod hotspot;
pub mod index;
pub mod jobs;
pub mod mount;
pub mod net;
pub mod protect;
pub mod rate_limit;
pub mod recovery;
pub mod scrub;
pub mod smart;
pub mod staticweb;
pub mod updates;
pub mod uploads;
pub mod wifi;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use rusqlite::Connection;

use crate::drives::DriveManager;

pub type DavHandler = dav_server::DavHandler;

#[derive(Clone)]
pub struct AppState {
    pub db: Arc<Mutex<Connection>>,
    pub drive_manager: Arc<DriveManager>,
    pub job_manager: Arc<crate::jobs::JobManager>,
    pub dav_handlers: Arc<Mutex<HashMap<String, DavHandler>>>,
    pub wifi: Arc<dyn crate::wifi::WifiProvider>,
    pub auth: Arc<crate::auth::AuthService>,
    pub connect: Arc<crate::connect::ConnectService>,
    pub login_limiter: Arc<crate::rate_limit::RateLimiter>,
    pub dav_limiter: Arc<crate::rate_limit::RateLimiter>,
    pub share_limiter: Arc<crate::rate_limit::RateLimiter>,
    pub thumb_dir: std::path::PathBuf,
    pub hotspot: std::sync::Arc<Mutex<Option<crate::hotspot::CommandHotspot>>>,
    pub updates: std::sync::Arc<crate::updates::UpdateService>,
    pub last_io_activity: std::sync::Arc<std::sync::atomic::AtomicI64>,
    pub scrub_running: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl AppState {
    pub fn new(conn: Connection, drive_manager: Arc<DriveManager>) -> Self {
        let db = Arc::new(Mutex::new(conn));
        let secret =
            crate::auth::AuthService::ensure_secret(&db.lock().unwrap()).expect("jwt secret");
        let auth = Arc::new(crate::auth::AuthService::new(
            db.clone(),
            secret.into_bytes(),
        ));
        let job_manager = Arc::new(crate::jobs::JobManager::new(db.clone()));
        Self {
            db,
            drive_manager,
            job_manager,
            dav_handlers: Arc::new(Mutex::new(HashMap::new())),
            wifi: Arc::new(crate::wifi::NoopProvider),
            auth,
            connect: Arc::new(crate::connect::ConnectService::new(
                std::path::Path::new("/var/lib/luna"),
                std::env::var("LUNA_CONNECT_URL").ok(),
            )),
            login_limiter: Arc::new(crate::rate_limit::RateLimiter::new(
                std::time::Duration::from_secs(300),
                10,
            )),
            dav_limiter: Arc::new(crate::rate_limit::RateLimiter::new(
                std::time::Duration::from_secs(300),
                10,
            )),
            share_limiter: Arc::new(crate::rate_limit::RateLimiter::new(
                std::time::Duration::from_secs(300),
                10,
            )),
            thumb_dir: std::path::PathBuf::from("/var/lib/luna/thumbs"),
            hotspot: Arc::new(Mutex::new(None)),
            updates: Arc::new(crate::updates::UpdateService::from_env()),
            last_io_activity: Arc::new(std::sync::atomic::AtomicI64::new(0)),
            scrub_running: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }

    pub fn with_wifi(mut self, wifi: Arc<dyn crate::wifi::WifiProvider>) -> Self {
        self.wifi = wifi;
        self
    }

    pub fn with_connect(mut self, connect: Arc<crate::connect::ConnectService>) -> Self {
        self.connect = connect;
        self
    }

    pub fn with_thumb_dir(mut self, thumb_dir: std::path::PathBuf) -> Self {
        self.thumb_dir = thumb_dir;
        self
    }

    pub fn with_updates(mut self, updates: Arc<crate::updates::UpdateService>) -> Self {
        self.updates = updates;
        self
    }

    pub fn set_hotspot(&self, hotspot: crate::hotspot::CommandHotspot) {
        *self.hotspot.lock().unwrap() = Some(hotspot);
    }

    pub fn touch_io_activity(&self) {
        self.last_io_activity
            .store(crate::db::now_unix(), std::sync::atomic::Ordering::Relaxed);
    }
}

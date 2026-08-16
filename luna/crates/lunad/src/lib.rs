pub mod api;
pub mod auth;
pub mod ble;
pub mod config;
pub mod connect;
pub mod dav;
pub mod db;
pub mod detect;
pub mod drives;
pub mod files;
pub mod gallery;
pub mod index;
pub mod jobs;
pub mod mount;
pub mod net;
pub mod rate_limit;
pub mod scrub;
pub mod smart;
pub mod staticweb;
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
    pub thumb_dir: std::path::PathBuf,
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
            thumb_dir: std::path::PathBuf::from("/var/lib/luna/thumbs"),
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
}

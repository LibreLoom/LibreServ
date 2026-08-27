pub mod api;
pub mod at_rest;
pub mod auth;
pub mod budget;
pub mod cloud_backup;
pub mod config;
pub mod connect;
pub mod console;
pub mod dav;
mod dav_fs;
pub mod db;
pub mod detect;
pub mod dev_mock;
pub mod dhcp;
pub mod drives;
pub mod exif;
pub mod files;
pub mod fsprobe;
pub mod fstrim;
pub mod gallery;
pub mod heif;
pub mod hotspot;
pub mod index;
pub mod jobs;
pub mod mount;
pub mod net;
pub mod password;
pub mod protect;
pub mod rate_limit;
pub mod recovery;
pub mod scrub;
pub mod secrets;
pub mod smart;
pub mod staticweb;
pub mod summary;
pub mod updates;
pub mod uploads;

#[cfg(test)]
mod runtime_perf;

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
    pub auth: Arc<crate::auth::AuthService>,
    pub connect: Arc<crate::connect::ConnectService>,
    pub login_limiter: Arc<crate::rate_limit::RateLimiter>,
    pub dav_limiter: Arc<crate::rate_limit::RateLimiter>,
    pub share_limiter: Arc<crate::rate_limit::RateLimiter>,
    pub share_auth: Arc<crate::rate_limit::ShareAuthGuard>,
    pub data_dir: std::path::PathBuf,
    pub updates: std::sync::Arc<crate::updates::UpdateService>,
    pub last_io_activity: std::sync::Arc<std::sync::atomic::AtomicI64>,
    pub scrub_running: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl AppState {
    pub fn new(
        conn: Connection,
        drive_manager: Arc<DriveManager>,
        data_dir: &std::path::Path,
    ) -> Self {
        let db = Arc::new(Mutex::new(conn));
        let secret =
            crate::secrets::ensure_jwt_secret(data_dir, &db.lock().unwrap()).expect("jwt secret");
        let auth = Arc::new(crate::auth::AuthService::new(
            db.clone(),
            secret,
            data_dir.to_path_buf(),
        ));
        let job_manager = Arc::new(crate::jobs::JobManager::new(db.clone()));
        Self {
            db: db.clone(),
            drive_manager,
            job_manager,
            dav_handlers: Arc::new(Mutex::new(HashMap::new())),
            auth,
            connect: Arc::new(crate::connect::ConnectService::new(
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
            share_auth: Arc::new(crate::rate_limit::ShareAuthGuard::new(db)),
            data_dir: data_dir.to_path_buf(),
            updates: Arc::new(crate::updates::UpdateService::from_env(data_dir)),
            last_io_activity: Arc::new(std::sync::atomic::AtomicI64::new(0)),
            scrub_running: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }

    pub fn with_connect(mut self, connect: Arc<crate::connect::ConnectService>) -> Self {
        self.connect = connect;
        self
    }

    pub fn with_updates(mut self, updates: Arc<crate::updates::UpdateService>) -> Self {
        self.updates = updates;
        self
    }

    pub fn touch_io_activity(&self) {
        self.last_io_activity
            .store(crate::db::now_unix(), std::sync::atomic::Ordering::Relaxed);
    }
}

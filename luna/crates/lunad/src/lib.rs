pub mod api;
pub mod config;
pub mod dav;
pub mod db;
pub mod detect;
pub mod drives;
pub mod files;
pub mod jobs;
pub mod mount;
pub mod staticweb;
pub mod uploads;

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
}

impl AppState {
    pub fn new(conn: Connection, drive_manager: Arc<DriveManager>) -> Self {
        let db = Arc::new(Mutex::new(conn));
        let job_manager = Arc::new(crate::jobs::JobManager::new(db.clone()));
        Self {
            db,
            drive_manager,
            job_manager,
            dav_handlers: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

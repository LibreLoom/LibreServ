pub mod api;
pub mod config;
pub mod db;
pub mod detect;
pub mod drives;
pub mod mount;
pub mod staticweb;

use std::sync::{Arc, Mutex};

use rusqlite::Connection;

use crate::drives::DriveManager;

#[derive(Clone)]
pub struct AppState {
    pub db: Arc<Mutex<Connection>>,
    pub drive_manager: Arc<DriveManager>,
}

impl AppState {
    pub fn new(conn: Connection, drive_manager: Arc<DriveManager>) -> Self {
        Self {
            db: Arc::new(Mutex::new(conn)),
            drive_manager,
        }
    }
}

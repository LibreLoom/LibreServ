pub mod api;
pub mod config;
pub mod db;
pub mod detect;
pub mod staticweb;

use std::sync::Mutex;

use rusqlite::Connection;

#[derive(Clone)]
pub struct AppState {
    pub db: std::sync::Arc<Mutex<Connection>>,
}

impl AppState {
    pub fn new(conn: Connection) -> Self {
        Self {
            db: std::sync::Arc::new(Mutex::new(conn)),
        }
    }
}

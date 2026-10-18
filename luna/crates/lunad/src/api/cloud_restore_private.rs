//! Private items: restoring private backups from the cloud after the local database is lost.
use axum::Router;

use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
}

//! The Backups folder on a drive: browse, versions, download, restore (plan §4).

use axum::Router;

use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
}

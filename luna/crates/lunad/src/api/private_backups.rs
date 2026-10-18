//! Private items: the owner-facing and admin-facing backup listings and actions.
use axum::Router;

use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
}

//! Drive backups: list, start, run, delete (plan §2, §8).

use axum::Router;

use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
}

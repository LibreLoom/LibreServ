pub mod drives;
pub mod health;
pub mod response;

use axum::Router;

use crate::AppState;

pub mod files;

pub fn router() -> Router<AppState> {
    Router::new()
        .merge(health::router())
        .merge(drives::router())
        .merge(files::router())
}

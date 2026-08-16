pub mod drives;
pub mod health;
pub mod response;

use axum::Router;

use crate::AppState;

pub mod files;
pub mod uploads;

pub fn router() -> Router<AppState> {
    Router::new()
        .merge(health::router())
        .merge(drives::router())
        .merge(files::router())
        .merge(uploads::router())
}

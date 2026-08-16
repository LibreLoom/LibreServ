pub mod drives;
pub mod health;
pub mod network;
pub mod response;
pub mod setup;

use axum::Router;

use crate::AppState;

pub mod files;
pub mod jobs;
pub mod uploads;

pub fn router() -> Router<AppState> {
    Router::new()
        .merge(health::router())
        .merge(network::router())
        .merge(setup::router())
        .merge(drives::router())
        .merge(files::router())
        .merge(uploads::router())
        .merge(jobs::router())
}

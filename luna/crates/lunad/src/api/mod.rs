pub mod auth;
pub mod connect;
pub mod drives;
pub mod grants;
pub mod health;
pub mod network;
pub mod response;
pub mod setup;
pub mod shares;
pub mod users;

use axum::Router;

use crate::AppState;

pub mod files;
pub mod jobs;
pub mod uploads;

pub fn router() -> Router<AppState> {
    Router::new()
        .merge(health::router())
        .merge(auth::router())
        .merge(connect::router())
        .merge(users::router())
        .merge(grants::router())
        .merge(shares::router())
        .merge(network::router())
        .merge(setup::router())
        .merge(drives::router())
        .merge(files::router())
        .merge(uploads::router())
        .merge(jobs::router())
}

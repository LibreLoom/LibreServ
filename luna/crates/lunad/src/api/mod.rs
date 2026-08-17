pub mod auth;
pub mod connect;
pub mod device_tokens;
pub mod drives;
pub mod grants;
pub mod health;
pub mod network;
pub mod protections;
pub mod response;
pub mod search;
pub mod setup;
pub mod shares;
pub mod users;

use axum::Router;

use crate::AppState;

pub mod files;
pub mod gallery;
pub mod jobs;
pub mod uploads;

pub fn router() -> Router<AppState> {
    Router::new()
        .merge(health::router())
        .merge(auth::router())
        .merge(connect::router())
        .merge(device_tokens::router())
        .merge(users::router())
        .merge(grants::router())
        .merge(search::router())
        .merge(protections::router())
        .merge(shares::router())
        .merge(network::router())
        .merge(setup::router())
        .merge(drives::router())
        .merge(files::router())
        .merge(gallery::router())
        .merge(uploads::router())
        .merge(jobs::router())
}

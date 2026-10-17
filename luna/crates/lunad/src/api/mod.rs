pub mod access;
pub mod auth;
pub mod backup_folder;
pub mod backups;
pub mod cloud_backups;
pub mod cloud_phrase;
pub mod cloud_restore;
pub mod cloud_restore_private;
pub mod connect;
pub mod device_tokens;
pub mod drives;
pub mod forms;
pub mod health;
pub mod network;
pub mod private_backups;
pub mod public_limits;
pub mod response;
pub mod search;
pub mod setup;
pub mod updates;
pub mod users;

use axum::Router;

use crate::AppState;

pub mod collab;
pub mod files;
pub mod gallery;
pub mod jobs;
pub mod office;
pub mod office_ws;
pub mod uploads;

pub fn router() -> Router<AppState> {
    Router::new()
        .merge(health::router())
        .merge(auth::router())
        .merge(backups::router())
        .merge(cloud_backups::router())
        .merge(cloud_phrase::router())
        .merge(cloud_restore::router())
        .merge(cloud_restore_private::router())
        .merge(backup_folder::router())
        .merge(private_backups::router())
        .merge(connect::router())
        .merge(device_tokens::router())
        .merge(users::router())
        .merge(search::router())
        .merge(access::router())
        .merge(forms::router())
        .merge(network::router())
        .merge(setup::router())
        .merge(drives::router())
        .merge(collab::router())
        .merge(files::router())
        .merge(gallery::router())
        .merge(uploads::router())
        .merge(jobs::router())
        .merge(updates::router())
        .merge(office::router())
}

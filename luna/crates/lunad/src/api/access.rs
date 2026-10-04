//! Universal access API: one subject/member/link model for files, folders,
//! drives, and albums.
//!
//! Signed-in routes live under `/api/v1/access` (`/api/v1/me/access` is kept
//! for the member dashboard). The public surface is `/s/{token}` — one URL
//! scheme for file, folder, drop-box, and album links. Password-protected
//! links set a short-lived `luna_link_<id>` proof cookie after the first
//! correct `X-Share-Password` so media tags can load without the header.

use std::net::SocketAddr;
use std::path::{Component, Path as FsPath, PathBuf};

use argon2::password_hash::rand_core::RngCore;
use axum::body::Body;
use axum::extract::{ConnectInfo, DefaultBodyLimit, Extension, Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use base64::Engine;
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::AppState;
use crate::access::{
    self, CAP_EDIT, CAP_RESPOND, CAP_SHARE, CAP_UPLOAD, CAP_VIEW, Caps, KIND_ALBUM, KIND_PATH,
    caps_cover, caps_from_str, caps_strictly_cover, caps_to_str, caps_valid_for,
    caps_valid_for_link, clean_subject_path, normalize_subject_kind, normalize_subject_path,
    path_contains,
};
use crate::api::forms::is_form_path;
use crate::api::response::json_error;
use crate::auth::{self, CurrentUser};
use crate::db::{self, AccessLinkRow, AccessMemberRow};
use crate::files::{self, uploads};

/// Same ceiling as signed-in uploads.
const MAX_FILE_BYTES: u64 = 1024 * 1024 * 1024 * 1024; // 1 TiB
/// Proof-cookie lifetime for password-protected links.
const LINK_PROOF_TTL: i64 = 12 * 3600;
/// Keep public album zips bounded for the Pi-class box.
const PUBLIC_ALBUM_ZIP_MAX: usize = 500;

type ApiError = (StatusCode, Json<Value>);

pub fn router() -> Router<AppState> {
    let chunk_max = crate::budget::limits().upload_chunk_bytes;
    Router::new()
        // Signed-in universal access API.
        .route("/api/v1/access/subject", get(subject_state))
        .route("/api/v1/access/members", post(add_member))
        .route(
            "/api/v1/access/members/{id}",
            patch(update_member).delete(remove_member),
        )
        .route("/api/v1/access/links", post(create_link))
        .route(
            "/api/v1/access/links/{id}",
            patch(update_link).delete(remove_link),
        )
        .route("/api/v1/access/mine", get(mine))
        .route("/api/v1/me/access", get(me_access))
        // Public share surface: /s/{token} serves the SPA to browsers and
        // JSON metadata to the page itself; children do the work.
        .route("/s/{token}", get(public_root))
        .route("/s/{token}/list", get(public_list))
        .route("/s/{token}/stat", get(public_stat))
        .route("/s/{token}/mkdir", post(public_mkdir))
        .route("/s/{token}/create", post(public_create))
        .route("/s/{token}/rename", post(public_rename))
        .route("/s/{token}/move", post(public_move))
        .route("/s/{token}/file", get(public_file).delete(public_delete))
        .route("/s/{token}/items", get(public_items))
        .route("/s/{token}/media", get(public_media))
        .route("/s/{token}/zip", get(public_zip))
        .route(
            "/s/{token}/upload",
            post(public_upload_create).layer(DefaultBodyLimit::max(1024 * 1024)),
        )
        .route(
            "/s/{token}/upload/{id}",
            axum::routing::put(public_upload_chunk)
                .layer(DefaultBodyLimit::max(chunk_max))
                .delete(public_upload_cancel),
        )
        .route(
            "/s/{token}/upload/{id}/complete",
            post(public_upload_complete),
        )
}

// ---------------------------------------------------------------------------
// Subject resolution
// ---------------------------------------------------------------------------

/// A resolved shareable subject. For `kind == path`, `exists` is false when
/// the path is gone (member rows may legitimately outlive the folder). For
/// `kind == album`, `root` is the home drive's mount.
struct Subject {
    kind: &'static str,
    drive_id: String,
    path: String,
    album_id: String,
    is_file: bool,
    exists: bool,
    name: String,
    owner: String,
    item_count: u64,
    /// A private item, or inside one, whose owner is a person on this Luna.
    /// Admins get no shortcut here, `owner` is the person who owns it, and
    /// inherited shares don't apply.
    private: bool,
    /// Real path of the private item this sits in (or is), when private.
    wall: Option<String>,
}

/// Is this path a private item, or inside one, that belongs to someone?
fn path_is_private(conn: &rusqlite::Connection, drive_id: &str, path: &str) -> bool {
    private_owner(conn, drive_id, path).is_some()
}

/// `Some(owner user id)` when the path is private to a person this Luna
/// knows. Items whose owner is gone belong to nobody, so no wall stands.
fn private_owner(conn: &rusqlite::Connection, drive_id: &str, path: &str) -> Option<String> {
    private_wall(conn, drive_id, path).map(|b| b.owner)
}

/// The private boundary around a path, when its owner is a person here.
fn private_wall(
    conn: &rusqlite::Connection,
    drive_id: &str,
    path: &str,
) -> Option<crate::private::Boundary> {
    let drive = db::get_drive(conn, drive_id).ok().flatten()?;
    if drive.mount_point.is_empty() {
        return None;
    }
    let root = FsPath::new(&drive.mount_point);
    let real = files::real_rel(root, &normalize_subject_path(path)).into_owned();
    crate::private::boundary_for(root, &real)
        .filter(|b| crate::private::owner_known(conn, &b.owner))
}

/// The refusal for someone with no way in: a private item that isn't theirs
/// doesn't admit it exists.
fn refuse(subj: &Subject, mine: Caps, msg: &'static str) -> ApiError {
    if subj.private && mine & CAP_VIEW == 0 {
        json_error(StatusCode::NOT_FOUND, "Luna can't find that item.")
    } else {
        json_error(StatusCode::FORBIDDEN, msg)
    }
}

/// Does a share on `path` (an ancestor) still apply to this subject? Not
/// when a private item stands between them: only shares at or below its
/// boundary reach in.
fn reaches_in(subj: &Subject, path: &str) -> bool {
    subj.wall.as_deref().is_none_or(|w| path_contains(w, path))
}

fn busy() -> ApiError {
    json_error(
        StatusCode::INTERNAL_SERVER_ERROR,
        "Luna couldn't do that. Try again.",
    )
}

fn resolve_album(
    conn: &rusqlite::Connection,
    drive_id: &str,
    album_id: &str,
) -> Result<(PathBuf, Option<crate::gallery::Album>), ApiError> {
    let drive = db::get_drive(conn, drive_id)
        .map_err(|_| busy())?
        .ok_or_else(|| json_error(StatusCode::NOT_FOUND, "Luna doesn't know this drive."))?;
    if drive.mount_point.is_empty() {
        return Err(json_error(
            StatusCode::NOT_FOUND,
            "This album's drive isn't plugged in right now.",
        ));
    }
    let root = PathBuf::from(&drive.mount_point);
    let album = crate::gallery::get_album(&root, drive_id, album_id).map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't read this album.",
        )
    })?;
    Ok((root, album))
}

fn resolve_subject(
    conn: &rusqlite::Connection,
    kind: &str,
    drive_id: &str,
    path: &str,
    album_id: &str,
) -> Result<Subject, ApiError> {
    let kind = normalize_subject_kind(kind).ok_or_else(|| {
        json_error(
            StatusCode::BAD_REQUEST,
            "Luna doesn't recognize that kind of item.",
        )
    })?;
    let drive_id = drive_id.trim().to_string();
    if drive_id.is_empty() {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "Pick which drive this is on.",
        ));
    }
    match kind {
        KIND_ALBUM => {
            let (_root, album) = resolve_album(conn, &drive_id, album_id)?;
            match album {
                Some(album) => Ok(Subject {
                    kind,
                    drive_id,
                    path: String::new(),
                    album_id: album.id.clone(),
                    is_file: false,
                    exists: true,
                    name: album.name.clone(),
                    owner: album.owner_user_id.clone(),
                    item_count: album.item_count,
                    private: false,
                    wall: None,
                }),
                None => Ok(Subject {
                    kind,
                    drive_id,
                    path: String::new(),
                    album_id: album_id.to_string(),
                    is_file: false,
                    exists: false,
                    name: "Album".into(),
                    owner: String::new(),
                    item_count: 0,
                    private: false,
                    wall: None,
                }),
            }
        }
        _ => {
            let drive = db::get_drive(conn, &drive_id)
                .map_err(|_| busy())?
                .ok_or_else(|| {
                    json_error(StatusCode::NOT_FOUND, "Luna doesn't know this drive.")
                })?;
            let rel = normalize_subject_path(path);
            // Luna-internal names (drive bookkeeping, trash dirs) are never
            // shareable subjects — and neither is the bare `.luna-trash`
            // root, which would read everyone's deletions. Individual trash
            // entries stay shareable (their origin ACL still gates who can
            // mint them).
            if files::is_internal_temp(&rel) || rel == files::TRASH_API_ALIAS {
                return Err(json_error(
                    StatusCode::BAD_REQUEST,
                    "Luna can't share that item.",
                ));
            }
            let base = rel.rsplit('/').next().unwrap_or("").to_string();
            let name = if base.is_empty() {
                drive.label.clone()
            } else {
                base
            };
            let mounted = !drive.mount_point.is_empty();
            let (exists, is_file) = if mounted {
                match files::resolve_any_including_trash(conn, &drive_id, &rel) {
                    Ok((_, meta)) => (true, meta.is_file()),
                    Err(_) => (false, false),
                }
            } else {
                (false, false)
            };
            let wall = private_wall(conn, &drive_id, &rel);
            let private = wall.as_ref().map(|b| b.owner.clone());
            Ok(Subject {
                wall: wall.map(|b| b.path),
                kind,
                drive_id,
                path: rel,
                album_id: String::new(),
                is_file,
                exists,
                name,
                private: private.is_some(),
                owner: private.unwrap_or_default(),
                item_count: 0,
            })
        }
    }
}

/// Capabilities `user` holds on `subj`: everything for admins and album
/// owners, member rows otherwise.
fn my_caps(conn: &rusqlite::Connection, user: &CurrentUser, subj: &Subject) -> Caps {
    // Admins hold everything except other people's private items, which
    // `caps_on_path` decides.
    if user.role == "admin" && !subj.private {
        return access::CAP_MANAGE;
    }
    match subj.kind {
        KIND_ALBUM => {
            if subj.owner == user.id {
                return access::CAP_MANAGE;
            }
            let Ok(rows) = db::list_access_members_for_user(conn, &user.id) else {
                return 0;
            };
            access::member_caps_on_album(&rows, &subj.drive_id, &subj.album_id)
        }
        _ => auth::caps_on_path(user, conn, &subj.drive_id, &subj.path),
    }
}

/// Same, but lenient when the subject itself is gone (drive pulled, album
/// deleted): only admins keep authority, members can't act on ghosts.
fn my_caps_on_row(conn: &rusqlite::Connection, user: &CurrentUser, row: &AccessMemberRow) -> Caps {
    match resolve_subject(
        conn,
        &row.subject_kind,
        &row.drive_id,
        &row.path,
        &row.album_id,
    ) {
        Ok(subj) => my_caps(conn, user, &subj),
        Err(_) if user.role == "admin" => access::CAP_MANAGE,
        Err(_) => 0,
    }
}

fn my_caps_on_link(conn: &rusqlite::Connection, user: &CurrentUser, link: &AccessLinkRow) -> Caps {
    match resolve_subject(
        conn,
        &link.subject_kind,
        &link.drive_id,
        &link.path,
        &link.album_id,
    ) {
        Ok(subj) => my_caps(conn, user, &subj),
        Err(_) if user.role == "admin" => access::CAP_MANAGE,
        Err(_) => 0,
    }
}

/// Intrinsic authority over a subject — held regardless of any access row.
/// Admins hold it everywhere; the album owner on their album. A `full+share` *grant* is still delegated authority, not
/// ownership — grantees rank below this class even at equal caps.
fn is_subject_owner(user: &CurrentUser, subj: &Subject) -> bool {
    (user.role == "admin" && !subj.private) || (!subj.owner.is_empty() && subj.owner == user.id)
}

fn user_names(conn: &rusqlite::Connection) -> std::collections::HashMap<String, String> {
    db::list_users(conn)
        .unwrap_or_default()
        .into_iter()
        .map(|u| {
            let name = if u.display_name.trim().is_empty() {
                u.username.clone()
            } else {
                u.display_name.clone()
            };
            (u.id, name)
        })
        .collect()
}

fn subject_json(subj: &Subject) -> Value {
    json!({
        "kind": subj.kind,
        "drive_id": subj.drive_id,
        "path": subj.path,
        "album_id": subj.album_id,
        "is_file": subj.is_file,
        "exists": subj.exists,
        "name": subj.name,
        "item_count": subj.item_count,
        "private": subj.private,
        // This folder is itself the boundary (vs. an ordinary item inside
        // one) — the difference between "Private folder" and "In a
        // private folder".
        "private_folder": subj.private
            && !subj.is_file
            && subj.wall.as_deref() == Some(subj.path.as_str()),
        // Whose boundary it is, so the sheet knows who may open it back up.
        "owner": subj.owner,
    })
}

fn member_json(row: &AccessMemberRow, names: &std::collections::HashMap<String, String>) -> Value {
    json!({
        "id": row.id,
        "user_id": row.user_id,
        "name": names.get(&row.user_id).cloned().unwrap_or_default(),
        "caps": caps_to_str(row.caps),
        "created_by": row.created_by,
        "shared_by": names.get(&row.created_by).cloned().unwrap_or_default(),
    })
}

/// Link row for a signed-in caller. The token itself only goes to callers
/// who could manage the link — a view-only member must not copy a link that
/// outranks their own access and walk in as a guest with it.
fn link_json(conn: &rusqlite::Connection, user: &CurrentUser, row: &AccessLinkRow) -> Value {
    json!({
        "id": row.id,
        "caps": caps_to_str(row.caps),
        "url": (may_manage_link(conn, user, row) && !row.token.is_empty())
            .then(|| format!("/s/{}", row.token)),
        "has_password": !row.password_hash.is_empty(),
        "expires_at": row.expires_at,
        "created_at": row.created_at,
        "created_by": row.created_by,
        "can_manage": may_manage_link(conn, user, row),
    })
}

mod access_admin;
mod access_public;
mod access_stream;
use access_admin::*;
pub(crate) use access_public::*;
use access_stream::*;

#[cfg(test)]
mod tests;

#[cfg(test)]
mod http_tests;

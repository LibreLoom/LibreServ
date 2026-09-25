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
    self, CAP_EDIT, CAP_RESPOND, CAP_UPLOAD, CAP_VIEW, Caps, KIND_ALBUM, KIND_PATH, caps_cover,
    caps_from_str, caps_to_str, caps_valid_for, caps_valid_for_link, normalize_subject_kind,
    normalize_subject_path, path_contains,
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
}

fn busy() -> ApiError {
    json_error(
        StatusCode::INTERNAL_SERVER_ERROR,
        "Luna's index is busy. Try again.",
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
            "Luna doesn't know that kind of thing.",
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
            let base = rel.rsplit('/').next().unwrap_or("").to_string();
            let name = if base.is_empty() {
                drive.label.clone()
            } else {
                base
            };
            let mounted = !drive.mount_point.is_empty();
            let (exists, is_file) = if mounted {
                match files::resolve_any(conn, &drive_id, &rel) {
                    Ok((_, meta)) => (true, meta.is_file()),
                    Err(_) => (false, false),
                }
            } else {
                (false, false)
            };
            Ok(Subject {
                kind,
                drive_id,
                path: rel,
                album_id: String::new(),
                is_file,
                exists,
                name,
                owner: String::new(),
                item_count: 0,
            })
        }
    }
}

/// Capabilities `user` holds on `subj`: everything for admins and album
/// owners, member rows otherwise.
fn my_caps(conn: &rusqlite::Connection, user: &CurrentUser, subj: &Subject) -> Caps {
    if user.role == "admin" {
        return access::CAP_ALL;
    }
    match subj.kind {
        KIND_ALBUM => {
            if subj.owner == user.id {
                return access::CAP_ALL;
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
    if user.role == "admin" {
        return access::CAP_ALL;
    }
    match resolve_subject(
        conn,
        &row.subject_kind,
        &row.drive_id,
        &row.path,
        &row.album_id,
    ) {
        Ok(subj) => my_caps(conn, user, &subj),
        Err(_) => 0,
    }
}

fn my_caps_on_link(conn: &rusqlite::Connection, user: &CurrentUser, link: &AccessLinkRow) -> Caps {
    if user.role == "admin" {
        return access::CAP_ALL;
    }
    match resolve_subject(
        conn,
        &link.subject_kind,
        &link.drive_id,
        &link.path,
        &link.album_id,
    ) {
        Ok(subj) => my_caps(conn, user, &subj),
        Err(_) => 0,
    }
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

// ---------------------------------------------------------------------------
// Signed-in handlers
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct SubjectQuery {
    kind: String,
    drive_id: String,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    album_id: Option<String>,
}

/// Everything the share sheet needs for one subject: its shape, the caller's
/// capabilities, current members, and current links.
async fn subject_state(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Query(q): Query<SubjectQuery>,
) -> Result<Json<Value>, ApiError> {
    let conn = state.db.lock().map_err(|_| busy())?;
    let subj = resolve_subject(
        &conn,
        &q.kind,
        &q.drive_id,
        q.path.as_deref().unwrap_or(""),
        q.album_id.as_deref().unwrap_or(""),
    )?;
    let mine = my_caps(&conn, &user, &subj);
    if mine == 0 {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "You don't have access to share this.",
        ));
    }
    let names = user_names(&conn);
    let labels = drive_labels(&conn);
    let all_members = db::list_all_access_members(&conn).map_err(|_| busy())?;
    let members = db::list_access_members_for_subject(
        &conn,
        subj.kind,
        &subj.drive_id,
        &subj.path,
        &subj.album_id,
    )
    .map_err(|_| busy())?
    .iter()
    .map(|r| {
        let mut v = member_json(r, &names);
        v["can_manage"] = json!(caps_cover(mine, r.caps));
        v["can_remove"] = json!(r.user_id == user.id || caps_cover(mine, r.caps));
        let mut effective = r.caps;
        if subj.kind == KIND_PATH {
            for other in &all_members {
                if other.user_id == r.user_id
                    && other.subject_kind == KIND_PATH
                    && other.drive_id == subj.drive_id
                    && path_contains(&other.path, &subj.path)
                {
                    effective |= other.caps;
                }
            }
        }
        v["effective_caps"] = json!(caps_to_str(effective));
        v
    })
    .collect::<Vec<_>>();
    let links = db::list_access_links_for_subject(
        &conn,
        subj.kind,
        &subj.drive_id,
        &subj.path,
        &subj.album_id,
    )
    .map_err(|_| busy())?
    .iter()
    .map(|l| link_json(&conn, &user, l))
    .collect::<Vec<_>>();
    let inherited_from = |drive_id: &str, path: &str| {
        let can_inspect = resolve_subject(&conn, KIND_PATH, drive_id, path, "")
            .map(|parent| parent.exists && my_caps(&conn, &user, &parent) != 0)
            .unwrap_or(false);
        json!({
            "kind": KIND_PATH,
            "drive_id": drive_id,
            "path": path,
            "name": if path.is_empty() {
                labels.get(drive_id).cloned().unwrap_or_else(|| drive_id.to_string())
            } else {
                path.rsplit('/').next().unwrap_or(path).to_string()
            },
            "can_inspect": can_inspect,
        })
    };
    let inherited_members = all_members
        .iter()
        .filter(|r| {
            subj.kind == KIND_PATH
                && r.subject_kind == KIND_PATH
                && r.drive_id == subj.drive_id
                && r.path != subj.path
                && path_contains(&r.path, &subj.path)
        })
        .map(|r| {
            let mut v = member_json(r, &names);
            v["inherited_from"] = inherited_from(&r.drive_id, &r.path);
            v
        })
        .collect::<Vec<_>>();
    let inherited_links = db::list_access_links(&conn)
        .map_err(|_| busy())?
        .iter()
        .filter(|l| {
            subj.kind == KIND_PATH
                && l.subject_kind == KIND_PATH
                && l.drive_id == subj.drive_id
                && l.path != subj.path
                && path_contains(&l.path, &subj.path)
                && may_manage_link(&conn, &user, l)
        })
        .map(|l| {
            let mut v = link_json(&conn, &user, l);
            v["inherited_from"] = inherited_from(&l.drive_id, &l.path);
            v
        })
        .collect::<Vec<_>>();
    Ok(Json(json!({
        "subject": subject_json(&subj),
        "my_caps": caps_to_str(mine),
        "members": members,
        "links": links,
        "inherited_members": inherited_members,
        "inherited_links": inherited_links,
    })))
}

#[derive(Deserialize)]
struct MemberBody {
    kind: String,
    drive_id: String,
    #[serde(default)]
    path: String,
    #[serde(default)]
    album_id: String,
    user_id: String,
    caps: String,
}

/// Share a subject with a Luna user. Subset rule: you can only hand out
/// capabilities you hold yourself on that subject.
async fn add_member(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Json(body): Json<MemberBody>,
) -> Result<Json<Value>, ApiError> {
    let conn = state.db.lock().map_err(|_| busy())?;
    let subj = resolve_subject(
        &conn,
        &body.kind,
        &body.drive_id,
        &body.path,
        &body.album_id,
    )?;
    let caps = caps_from_str(&body.caps)
        .ok_or_else(|| json_error(StatusCode::BAD_REQUEST, "That access level doesn't exist."))?;
    if !caps_valid_for(caps, subj.kind, subj.is_file) {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "That access level doesn't apply here.",
        ));
    }
    let mine = my_caps(&conn, &user, &subj);
    if !caps_cover(mine, caps) {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "You can only share access you already have.",
        ));
    }
    let target = db::get_user(&conn, &body.user_id)
        .map_err(|_| busy())?
        .ok_or_else(|| json_error(StatusCode::NOT_FOUND, "Luna doesn't know that person."))?;

    // Same-user row on this subject → just retune it.
    let existing = db::list_access_members_for_subject(
        &conn,
        subj.kind,
        &subj.drive_id,
        &subj.path,
        &subj.album_id,
    )
    .map_err(|_| busy())?
    .into_iter()
    .find(|r| r.user_id == body.user_id);
    let names = user_names(&conn);
    if let Some(row) = existing {
        if !caps_cover(mine, row.caps) {
            return Err(json_error(
                StatusCode::FORBIDDEN,
                "You can't change access wider than your own.",
            ));
        }
        db::update_access_member_caps(&conn, &row.id, caps).map_err(|_| busy())?;
        return Ok(Json(member_json(&AccessMemberRow { caps, ..row }, &names)));
    }

    let row = AccessMemberRow {
        id: Uuid::new_v4().to_string(),
        subject_kind: subj.kind.to_string(),
        drive_id: subj.drive_id.clone(),
        path: subj.path.clone(),
        album_id: subj.album_id.clone(),
        user_id: target.id.clone(),
        caps,
        created_by: user.id.clone(),
    };
    access::create_member(&conn, &row).map_err(|_| busy())?;
    Ok(Json(member_json(&row, &names)))
}

#[derive(Deserialize)]
struct UpdateMemberBody {
    caps: String,
}

async fn update_member(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Path(id): Path<String>,
    Json(body): Json<UpdateMemberBody>,
) -> Result<Json<Value>, ApiError> {
    let conn = state.db.lock().map_err(|_| busy())?;
    let row = db::get_access_member(&conn, &id)
        .map_err(|_| busy())?
        .ok_or_else(|| json_error(StatusCode::NOT_FOUND, "Luna doesn't know this share."))?;
    let subj = resolve_subject(
        &conn,
        &row.subject_kind,
        &row.drive_id,
        &row.path,
        &row.album_id,
    )?;
    let caps = caps_from_str(&body.caps)
        .ok_or_else(|| json_error(StatusCode::BAD_REQUEST, "That access level doesn't exist."))?;
    if !caps_valid_for(caps, subj.kind, subj.is_file) {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "That access level doesn't apply here.",
        ));
    }
    let mine = my_caps(&conn, &user, &subj);
    if !caps_cover(mine, row.caps) || !caps_cover(mine, caps) {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "You can't change access wider than your own.",
        ));
    }
    db::update_access_member_caps(&conn, &id, caps).map_err(|_| busy())?;
    let names = user_names(&conn);
    Ok(Json(member_json(&AccessMemberRow { caps, ..row }, &names)))
}

async fn remove_member(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let conn = state.db.lock().map_err(|_| busy())?;
    let row = db::get_access_member(&conn, &id)
        .map_err(|_| busy())?
        .ok_or_else(|| json_error(StatusCode::NOT_FOUND, "Luna doesn't know this share."))?;
    let mine = my_caps_on_row(&conn, &user, &row);
    // Members can always remove themselves ("leave" a share); managers can
    // remove rows whose caps they fully cover.
    let allowed = row.user_id == user.id || caps_cover(mine, row.caps);
    if !allowed {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "You can't remove access wider than your own.",
        ));
    }
    db::delete_access_member(&conn, &id).map_err(|_| busy())?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct CreateLinkBody {
    kind: String,
    drive_id: String,
    #[serde(default)]
    path: String,
    #[serde(default)]
    album_id: String,
    caps: String,
    password: Option<String>,
    expires_in_days: Option<u32>,
}

fn generate_token() -> String {
    let mut bytes = [0u8; 24];
    argon2::password_hash::rand_core::OsRng.fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// Mint a public link. The raw token is stored on the row so the owner can
/// always come back and copy the address again; lookups still use the hash.
async fn create_link(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Extension(user): Extension<CurrentUser>,
    Json(body): Json<CreateLinkBody>,
) -> Result<Json<Value>, ApiError> {
    if !state.share_limiter.allow(&format!("link:{}", addr.ip())) {
        return Err(json_error(
            StatusCode::TOO_MANY_REQUESTS,
            "Too many new links just now. Wait a minute and try again.",
        ));
    }
    let conn = state.db.lock().map_err(|_| busy())?;
    let subj = resolve_subject(
        &conn,
        &body.kind,
        &body.drive_id,
        &body.path,
        &body.album_id,
    )?;
    if !subj.exists {
        return Err(json_error(
            StatusCode::NOT_FOUND,
            "Luna can't find that to share it.",
        ));
    }
    let caps = caps_from_str(&body.caps)
        .ok_or_else(|| json_error(StatusCode::BAD_REQUEST, "That access level doesn't exist."))?;
    let is_form = subj.is_file && is_form_path(&subj.path);
    if !caps_valid_for_link(caps, subj.kind, subj.is_file, is_form) {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "That access level doesn't apply here.",
        ));
    }
    let mine = my_caps(&conn, &user, &subj);
    if caps == CAP_RESPOND {
        // A respond link lets strangers append to the responses file — the
        // creator needs upload or edit access to allow that.
        if mine & (CAP_UPLOAD | CAP_EDIT) == 0 {
            return Err(json_error(
                StatusCode::FORBIDDEN,
                "You can only share access you already have.",
            ));
        }
    } else if !caps_cover(mine, caps) {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "You can only share access you already have.",
        ));
    }
    let token = generate_token();
    let password_hash = match body.password.as_deref().map(str::trim) {
        Some(pw) if !pw.is_empty() => auth::hash_password(pw).map_err(|_| busy())?,
        _ => String::new(),
    };
    let expires_at = body
        .expires_in_days
        .map(|days| db::now_unix() + days.clamp(1, 3650) as i64 * 86400);
    let row = AccessLinkRow {
        id: Uuid::new_v4().to_string(),
        token_hash: blake3::hash(token.as_bytes()).to_hex().to_string(),
        token: token.clone(),
        subject_kind: subj.kind.to_string(),
        drive_id: subj.drive_id.clone(),
        path: subj.path.clone(),
        album_id: subj.album_id.clone(),
        caps,
        password_hash,
        expires_at,
        created_by: user.id.clone(),
        created_at: db::now_unix(),
    };
    db::insert_access_link(&conn, &row).map_err(|_| busy())?;
    Ok(Json(json!({
        "id": row.id,
        "url": format!("/s/{token}"),
        "token": token,
        "caps": caps_to_str(caps),
        "expires_at": row.expires_at,
    })))
}

fn present_nullable<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

#[derive(Deserialize)]
struct UpdateLinkBody {
    #[serde(default)]
    caps: Option<String>,
    /// Absent = keep, null = clear, string = set a new password.
    #[serde(default, deserialize_with = "present_nullable")]
    password: Option<Option<String>>,
    /// Absent = keep, null = never expires, number = days from now.
    #[serde(default, deserialize_with = "present_nullable")]
    expires_in_days: Option<Option<u32>>,
}

fn may_manage_link(conn: &rusqlite::Connection, user: &CurrentUser, link: &AccessLinkRow) -> bool {
    if user.role == "admin" || link.created_by == user.id {
        return true;
    }
    let mine = my_caps_on_link(conn, user, link);
    // "respond" isn't a capability anyone holds — managing a form's answer
    // link rides on write access to the form, same rule as creating one.
    if link.caps == CAP_RESPOND {
        return mine & (CAP_UPLOAD | CAP_EDIT) != 0;
    }
    caps_cover(mine, link.caps)
}

async fn update_link(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Path(id): Path<String>,
    Json(body): Json<UpdateLinkBody>,
) -> Result<Json<Value>, ApiError> {
    let conn = state.db.lock().map_err(|_| busy())?;
    let mut link = db::get_access_link(&conn, &id)
        .map_err(|_| busy())?
        .ok_or_else(|| json_error(StatusCode::NOT_FOUND, "Luna doesn't know this link."))?;
    if !may_manage_link(&conn, &user, &link) {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "You can't change this link.",
        ));
    }
    let subj = resolve_subject(
        &conn,
        &link.subject_kind,
        &link.drive_id,
        &link.path,
        &link.album_id,
    )?;
    if let Some(raw) = body.caps.as_deref() {
        let caps = caps_from_str(raw).ok_or_else(|| {
            json_error(StatusCode::BAD_REQUEST, "That access level doesn't exist.")
        })?;
        let is_form = subj.is_file && is_form_path(&subj.path);
        if !caps_valid_for_link(caps, subj.kind, subj.is_file, is_form) {
            return Err(json_error(
                StatusCode::BAD_REQUEST,
                "That access level doesn't apply here.",
            ));
        }
        let mine = my_caps(&conn, &user, &subj);
        // "respond" isn't a subset of anyone's held caps — it needs write
        // access to the form instead, matching create_link's rule.
        let allowed = if caps == CAP_RESPOND {
            mine & (CAP_UPLOAD | CAP_EDIT) != 0
        } else {
            caps_cover(mine, caps)
        };
        if !allowed {
            return Err(json_error(
                StatusCode::FORBIDDEN,
                "You can't widen a link past your own access.",
            ));
        }
        link.caps = caps;
    }
    if let Some(pw) = &body.password {
        link.password_hash = match pw.as_deref().map(str::trim) {
            Some(pw) if !pw.is_empty() => auth::hash_password(pw).map_err(|_| busy())?,
            _ => String::new(),
        };
    }
    if let Some(days) = body.expires_in_days {
        link.expires_at = days.map(|d| db::now_unix() + d.clamp(1, 3650) as i64 * 86400);
    }
    db::update_access_link(&conn, &link).map_err(|_| busy())?;
    Ok(Json(link_json(&conn, &user, &link)))
}

async fn remove_link(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let conn = state.db.lock().map_err(|_| busy())?;
    let link = db::get_access_link(&conn, &id)
        .map_err(|_| busy())?
        .ok_or_else(|| json_error(StatusCode::NOT_FOUND, "Luna doesn't know this link."))?;
    if !may_manage_link(&conn, &user, &link) {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "You can't remove this link.",
        ));
    }
    db::delete_access_link(&conn, &id).map_err(|_| busy())?;
    Ok(Json(json!({ "ok": true })))
}

fn drive_labels(conn: &rusqlite::Connection) -> std::collections::HashMap<String, String> {
    db::list_drives(conn)
        .unwrap_or_default()
        .into_iter()
        .map(|d| (d.id, d.label))
        .collect()
}

/// Human name for a member row: album name, folder basename, or drive label.
fn member_row_name(
    conn: &rusqlite::Connection,
    row: &AccessMemberRow,
    labels: &std::collections::HashMap<String, String>,
) -> String {
    if row.subject_kind == KIND_ALBUM {
        if let Ok((_, Some(album))) = resolve_album(conn, &row.drive_id, &row.album_id) {
            return album.name;
        }
        return "Album".into();
    }
    if row.path.is_empty() {
        return labels
            .get(&row.drive_id)
            .cloned()
            .unwrap_or_else(|| row.drive_id.clone());
    }
    row.path.rsplit('/').next().unwrap_or(&row.path).to_string()
}

fn member_row_json(
    conn: &rusqlite::Connection,
    row: &AccessMemberRow,
    labels: &std::collections::HashMap<String, String>,
    names: &std::collections::HashMap<String, String>,
) -> Value {
    let resolved = resolve_subject(
        conn,
        &row.subject_kind,
        &row.drive_id,
        &row.path,
        &row.album_id,
    )
    .ok();
    let is_file = resolved.as_ref().map(|s| s.is_file).unwrap_or(false);
    let exists = resolved.as_ref().map(|s| s.exists).unwrap_or(false);
    json!({
        "id": row.id,
        "kind": row.subject_kind,
        "drive_id": row.drive_id,
        "drive_label": labels.get(&row.drive_id).cloned().unwrap_or_default(),
        "path": row.path,
        "album_id": row.album_id,
        "name": member_row_name(conn, row, labels),
        "is_file": is_file,
        "exists": exists,
        "caps": caps_to_str(row.caps),
        "created_by": row.created_by,
        "shared_by": names.get(&row.created_by).cloned().unwrap_or_default(),
    })
}

/// Things shared with the signed-in user, reduced to access roots.
async fn me_access(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
) -> Result<Json<Vec<Value>>, ApiError> {
    let conn = state.db.lock().map_err(|_| busy())?;
    let rows = db::list_access_members_for_user(&conn, &user.id).map_err(|_| busy())?;
    let labels = drive_labels(&conn);
    let names = user_names(&conn);
    let roots = access::member_access_roots(rows);
    Ok(Json(
        roots
            .iter()
            .map(|r| member_row_json(&conn, r, &labels, &names))
            .collect(),
    ))
}

/// Sharing inventory: subjects the caller created access rows on (admins see
/// everything), plus everything shared *with* the caller.
async fn mine(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
) -> Result<Json<Value>, ApiError> {
    let conn = state.db.lock().map_err(|_| busy())?;
    let is_admin = user.role == "admin";
    let members = db::list_all_access_members(&conn).map_err(|_| busy())?;
    let links = db::list_access_links(&conn).map_err(|_| busy())?;
    let labels = drive_labels(&conn);
    let names = user_names(&conn);

    // Group rows by subject key, keeping only groups the caller controls:
    // admin sees all; members see subjects where they created a row or hold
    // covering caps on at least one row.
    let mut order: Vec<(String, String, String, String)> = Vec::new();
    let mut group_members: std::collections::HashMap<
        (String, String, String, String),
        Vec<&AccessMemberRow>,
    > = std::collections::HashMap::new();
    let mut group_links: std::collections::HashMap<
        (String, String, String, String),
        Vec<&AccessLinkRow>,
    > = std::collections::HashMap::new();
    let key = |kind: &str, d: &str, p: &str, a: &str| {
        (
            kind.to_string(),
            d.to_string(),
            p.to_string(),
            a.to_string(),
        )
    };
    for m in &members {
        let k = key(&m.subject_kind, &m.drive_id, &m.path, &m.album_id);
        if !group_members.contains_key(&k) {
            order.push(k.clone());
        }
        group_members.entry(k).or_default().push(m);
    }
    for l in &links {
        let k = key(&l.subject_kind, &l.drive_id, &l.path, &l.album_id);
        if !group_links.contains_key(&k) && !group_members.contains_key(&k) {
            order.push(k.clone());
        }
        group_links.entry(k).or_default().push(l);
    }

    let mut sharing: Vec<Value> = Vec::new();
    for k in order {
        let ms = group_members.get(&k).cloned().unwrap_or_default();
        let ls = group_links.get(&k).cloned().unwrap_or_default();
        let controls = is_admin
            || ms.iter().any(|m| m.created_by == user.id)
            || ls.iter().any(|l| l.created_by == user.id)
            || {
                let mine = match resolve_subject(&conn, &k.0, &k.1, &k.2, &k.3) {
                    Ok(subj) => my_caps(&conn, &user, &subj),
                    Err(_) => 0,
                };
                ms.iter().any(|m| caps_cover(mine, m.caps))
                    || ls.iter().any(|l| caps_cover(mine, l.caps))
            };
        if !controls {
            continue;
        }
        let subj = resolve_subject(&conn, &k.0, &k.1, &k.2, &k.3).ok();
        let (name, exists, is_file, item_count) = match &subj {
            Some(s) => (s.name.clone(), s.exists, s.is_file, s.item_count),
            None => (
                if k.0 == KIND_ALBUM {
                    "Album".into()
                } else if k.2.is_empty() {
                    labels.get(&k.1).cloned().unwrap_or_else(|| k.1.clone())
                } else {
                    k.2.rsplit('/').next().unwrap_or(&k.2).to_string()
                },
                false,
                false,
                0,
            ),
        };
        let mine_caps = subj
            .as_ref()
            .map(|s| my_caps(&conn, &user, s))
            .unwrap_or(if is_admin { access::CAP_ALL } else { 0 });
        sharing.push(json!({
            "kind": k.0,
            "drive_id": k.1,
            "drive_label": labels.get(&k.1).cloned().unwrap_or_default(),
            "path": k.2,
            "album_id": k.3,
            "name": name,
            "exists": exists,
            "is_file": is_file,
            "item_count": item_count,
            "my_caps": caps_to_str(mine_caps),
            "members": ms.iter().map(|m| member_json(*m, &names)).collect::<Vec<_>>(),
            "links": ls.iter().map(|l| link_json(&conn, &user, *l)).collect::<Vec<_>>(),
        }));
    }

    // Every explicit row the caller holds — nested grants stay visible so
    // "leave" can never hide access retained through a child.
    let my_rows = db::list_access_members_for_user(&conn, &user.id).map_err(|_| busy())?;
    let with_me: Vec<Value> = my_rows
        .iter()
        .map(|r| member_row_json(&conn, r, &labels, &names))
        .collect();
    Ok(Json(json!({ "sharing": sharing, "with_me": with_me })))
}

// ---------------------------------------------------------------------------
// Public surface (/s/{token})
// ---------------------------------------------------------------------------

fn link_cookie_name(link_id: &str) -> String {
    format!("luna_link_{link_id}")
}

fn link_proof_subject(link: &AccessLinkRow) -> String {
    format!(
        "{}:{}",
        link.id,
        blake3::hash(link.password_hash.as_bytes()).to_hex()
    )
}

fn proof_from_cookie(headers: &HeaderMap, link_id: &str) -> Option<String> {
    let want = format!("{}=", link_cookie_name(link_id));
    headers
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())?
        .split(';')
        .map(str::trim)
        .find_map(|part| part.strip_prefix(&want).map(str::to_string))
}

fn gone() -> ApiError {
    json_error(StatusCode::GONE, "This link has expired or been removed.")
}

fn needs_password() -> ApiError {
    json_error(StatusCode::UNAUTHORIZED, "This link needs its password.")
}

/// Look up a link by raw token, enforce expiry, and check the password via
/// `X-Share-Password` or the proof cookie. Returns the row plus a fresh proof
/// JWT to set as a cookie when the password arrived by header.
pub(crate) fn resolve_public_link(
    state: &AppState,
    ip: &SocketAddr,
    token: &str,
    headers: &HeaderMap,
) -> Result<(AccessLinkRow, Option<String>), ApiError> {
    let link = {
        let conn = state.db.lock().map_err(|_| busy())?;
        db::get_access_link_by_token_hash(
            &conn,
            &blake3::hash(token.as_bytes()).to_hex().to_string(),
        )
        .map_err(|_| busy())?
        .ok_or_else(|| json_error(StatusCode::NOT_FOUND, "This link doesn't exist."))?
    };
    if access::link_expired(&link) {
        return Err(gone());
    }
    if link.password_hash.is_empty() {
        return Ok((link, None));
    }
    if let Some(proof) = proof_from_cookie(headers, &link.id)
        && state
            .auth
            .verify_link_proof(&link_proof_subject(&link), &proof)
    {
        return Ok((link, None));
    }
    let ip = ip.ip().to_string();
    if state.share_auth.is_locked(&link.id, &ip) {
        return Err(json_error(
            StatusCode::TOO_MANY_REQUESTS,
            "Too many wrong passwords. Wait a few minutes and try again.",
        ));
    }
    let provided = headers
        .get("x-share-password")
        .and_then(|v| v.to_str().ok())
        .filter(|s| !s.is_empty());
    let Some(password) = provided else {
        return Err(needs_password());
    };
    let parsed = argon2::password_hash::PasswordHash::new(&link.password_hash).map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't open this link.",
        )
    })?;
    if auth::verify_password_hash(password, &parsed).is_err() {
        state.share_auth.record_failure(&link.id, &ip);
        return Err(needs_password());
    }
    state.share_auth.clear_success(&link.id, &ip);
    let proof = state
        .auth
        .issue_link_proof(&link_proof_subject(&link), LINK_PROOF_TTL)
        .ok();
    Ok((link, proof))
}

/// Attach the proof cookie (when a header password just verified) and the
/// link-wide no-referrer policy to a public response. `link_id` names the
/// cookie; it is unused when `proof` is `None`.
pub(crate) fn finish_public(
    res: Result<Response, ApiError>,
    link_id: &str,
    proof: Option<String>,
    headers: &HeaderMap,
) -> Response {
    let mut res = match res {
        Ok(r) => r,
        Err(e) => e.into_response(),
    };
    if let Some(proof) = proof {
        let mut cookie = format!(
            "{}={}; Path=/s; HttpOnly; SameSite=Lax; Max-Age={LINK_PROOF_TTL}",
            link_cookie_name(link_id),
            proof
        );
        if auth::request_is_https(headers) {
            cookie.push_str("; Secure");
        }
        if let Ok(v) = HeaderValue::from_str(&cookie) {
            res.headers_mut().append(header::SET_COOKIE, v);
        }
    }
    res.headers_mut().insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    // Shared contents must not outlive a permission downgrade in a cache.
    res.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

/// Every public handler follows the same shape: resolve + authenticate the
/// link, run the body, wrap with the proof cookie and no-referrer policy.
pub(crate) async fn run_public<F, Fut>(
    state: &AppState,
    addr: &SocketAddr,
    token: &str,
    headers: &HeaderMap,
    body: F,
) -> Response
where
    F: FnOnce(AppState, AccessLinkRow) -> Fut,
    Fut: std::future::Future<Output = Result<Response, ApiError>>,
{
    match resolve_public_link(state, addr, token, headers) {
        Err(e) => finish_public(Err(e), "", None, headers),
        Ok((link, proof)) => {
            let id = link.id.clone();
            finish_public(body(state.clone(), link).await, &id, proof, headers)
        }
    }
}

fn prefers_html(headers: &HeaderMap) -> bool {
    let accept = headers
        .get(header::ACCEPT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let html = accept.find("text/html");
    let json = accept.find("application/json");
    match (html, json) {
        (Some(h), Some(j)) => h < j,
        (Some(_), None) => true,
        _ => false,
    }
}

fn accept_json(headers: &HeaderMap) -> bool {
    headers
        .get(header::ACCEPT)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|a| a.contains("application/json"))
}

/// Join a path under the link's root. Rejects `..` and absolute paths so a
/// public link cannot walk the rest of the drive.
fn child_under_link(link_path: &str, rel: &str) -> Option<String> {
    let extra = rel.trim();
    if extra.starts_with('/') {
        return None;
    }
    if extra.is_empty() {
        return Some(link_path.trim_start_matches('/').to_string());
    }
    let requested = FsPath::new(extra);
    if requested.is_absolute() {
        return None;
    }
    for component in requested.components() {
        // CurDir slips through too: `path/./` would resolve back to the link
        // root, and callers must never see the root as a mutable child.
        if matches!(
            component,
            Component::ParentDir | Component::Prefix(_) | Component::RootDir | Component::CurDir
        ) {
            return None;
        }
    }
    if link_path.is_empty() {
        Some(extra.to_string())
    } else {
        Some(format!("{}/{}", link_path.trim_end_matches('/'), extra))
    }
}

#[derive(Deserialize)]
struct PublicRootQuery {
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    download: Option<u8>,
    #[serde(default)]
    meta: Option<u8>,
}

async fn public_root(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(token): Path<String>,
    Query(query): Query<PublicRootQuery>,
    headers: HeaderMap,
) -> Response {
    if prefers_html(&headers) && query.download.unwrap_or(0) == 0 && query.meta.unwrap_or(0) == 0 {
        return crate::system::staticweb::handle("");
    }
    run_public(&state, &addr, &token, &headers, async |state, link| {
        public_root_inner(&state, &link, &query, &headers).await
    })
    .await
}

async fn public_root_inner(
    state: &AppState,
    link: &AccessLinkRow,
    query: &PublicRootQuery,
    headers: &HeaderMap,
) -> Result<Response, ApiError> {
    if link.caps & CAP_RESPOND != 0 {
        return crate::api::forms::public_form_document(state, &link.drive_id, &link.path);
    }
    if link.subject_kind == KIND_ALBUM {
        let conn = state.db.lock().map_err(|_| busy())?;
        let (_root, album) = resolve_album(&conn, &link.drive_id, &link.album_id)?;
        let album = album.ok_or_else(gone)?;
        return Ok(Json(json!({
            "kind": "album",
            "name": album.name,
            "item_count": album.item_count,
            "caps": caps_to_str(link.caps),
        }))
        .into_response());
    }
    // Path subjects: upload-only links are drop boxes — never reveal names.
    if link.caps & CAP_VIEW == 0 {
        if query.path.as_deref().is_some_and(|p| !p.trim().is_empty()) {
            return Err(json_error(
                StatusCode::BAD_REQUEST,
                "That folder isn't part of this shared link.",
            ));
        }
        return Ok(Json(json!({
            "kind": "dropbox",
            "caps": caps_to_str(link.caps),
        }))
        .into_response());
    }
    let (meta, rel) = {
        let conn = state.db.lock().map_err(|_| busy())?;
        let rel =
            child_under_link(&link.path, query.path.as_deref().unwrap_or("")).ok_or_else(|| {
                json_error(
                    StatusCode::BAD_REQUEST,
                    "That folder isn't part of this shared link.",
                )
            })?;
        let (_resolved, meta) = files::resolve_any(&conn, &link.drive_id, &rel).map_err(|_| {
            json_error(
                StatusCode::NOT_FOUND,
                "The shared files aren't available right now.",
            )
        })?;
        (meta, rel)
    };
    let name = rel
        .rsplit('/')
        .next()
        .filter(|n| !n.is_empty())
        .unwrap_or("download")
        .to_string();
    if meta.is_dir() {
        return Ok(Json(json!({
            "kind": "folder",
            "name": name,
            "caps": caps_to_str(link.caps),
        }))
        .into_response());
    }
    if query.meta.unwrap_or(0) != 0 || accept_json(headers) {
        return Ok(Json(json!({
            "kind": "file",
            "name": name,
            "size": meta.len(),
            "caps": caps_to_str(link.caps),
        }))
        .into_response());
    }
    serve_file(
        state,
        &link.drive_id,
        &rel,
        query.download.unwrap_or(0) != 0,
    )
    .await
}

#[derive(Deserialize)]
struct PublicListQuery {
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    download: Option<u8>,
}

/// `GET /s/{token}/list?path=` — entries of a folder inside a viewable link.
async fn public_list(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(token): Path<String>,
    Query(query): Query<PublicListQuery>,
    headers: HeaderMap,
) -> Response {
    run_public(&state, &addr, &token, &headers, async |state, link| {
        if link.subject_kind != KIND_PATH || link.caps & CAP_VIEW == 0 {
            return Err(gone());
        }
        let conn = state.db.lock().map_err(|_| busy())?;
        let rel =
            child_under_link(&link.path, query.path.as_deref().unwrap_or("")).ok_or_else(|| {
                json_error(
                    StatusCode::BAD_REQUEST,
                    "That folder isn't part of this shared link.",
                )
            })?;
        let (_resolved, meta) = files::resolve_any(&conn, &link.drive_id, &rel).map_err(|_| {
            json_error(
                StatusCode::NOT_FOUND,
                "The shared folder isn't available right now.",
            )
        })?;
        if !meta.is_dir() {
            // A file link's "folder" is the file itself — the guest file
            // browser lists a one-entry root so the shared file renders like
            // any other row and opens in the real viewer.
            if rel == link.path {
                let entry = files::stat(&conn, &link.drive_id, &rel).map_err(|_| {
                    json_error(
                        StatusCode::NOT_FOUND,
                        "The shared file isn't available right now.",
                    )
                })?;
                return Ok(Json(json!({ "entries": [entry] })).into_response());
            }
            return Err(json_error(StatusCode::BAD_REQUEST, "That isn't a folder."));
        }
        let entries = files::list_dir(&conn, &link.drive_id, &rel).map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't open this folder.",
            )
        })?;
        Ok(Json(json!({
            "entries": entries
                .into_iter()
                .filter(|e| !e.hidden && !files::is_internal_temp(&e.name))
                .collect::<Vec<_>>(),
        }))
        .into_response())
    })
    .await
}

/// `GET /s/{token}/file?path=&download=` — bytes of a file inside the link.
async fn public_file(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(token): Path<String>,
    Query(query): Query<PublicListQuery>,
    headers: HeaderMap,
) -> Response {
    run_public(&state, &addr, &token, &headers, async |state, link| {
        if link.subject_kind != KIND_PATH || link.caps & CAP_VIEW == 0 {
            return Err(gone());
        }
        let rel =
            child_under_link(&link.path, query.path.as_deref().unwrap_or("")).ok_or_else(|| {
                json_error(
                    StatusCode::BAD_REQUEST,
                    "That file isn't part of this shared link.",
                )
            })?;
        let is_file = {
            let conn = state.db.lock().map_err(|_| busy())?;
            files::resolve_any(&conn, &link.drive_id, &rel)
                .map(|(_, m)| m.is_file())
                .map_err(|_| {
                    json_error(
                        StatusCode::NOT_FOUND,
                        "The shared file isn't available right now.",
                    )
                })?
        };
        if !is_file {
            return Err(json_error(
                StatusCode::BAD_REQUEST,
                "That's a folder. Use Download to save it as a zip file.",
            ));
        }
        serve_file(
            &state,
            &link.drive_id,
            &rel,
            query.download.unwrap_or(0) != 0,
        )
        .await
    })
    .await
}

// --- Album public surface --------------------------------------------------

fn album_media_urls(token: &str, drive_id: &str, path: &str) -> (String, String, String) {
    let enc = urlencoding_lite(path);
    let base = format!("/s/{token}/media?drive_id={drive_id}&path={enc}");
    (
        format!("{base}&variant=thumb"),
        format!("{base}&variant=content"),
        format!("{base}&variant=download"),
    )
}

fn urlencoding_lite(input: &str) -> String {
    let mut out = String::new();
    for byte in input.as_bytes() {
        match *byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// Resolve the album a link points at: (home drive root, album).
fn album_for_link(
    conn: &rusqlite::Connection,
    link: &AccessLinkRow,
) -> Result<(PathBuf, crate::gallery::Album), ApiError> {
    let (root, album) = resolve_album(conn, &link.drive_id, &link.album_id)?;
    album.map(|a| (root, a)).ok_or_else(gone)
}

#[derive(Deserialize)]
struct PublicItemsQuery {
    #[serde(default)]
    limit: Option<u32>,
    #[serde(default)]
    offset: Option<u32>,
}

/// `GET /s/{token}/items` — album photo page for the public gallery view.
async fn public_items(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(token): Path<String>,
    Query(query): Query<PublicItemsQuery>,
    headers: HeaderMap,
) -> Response {
    run_public(&state, &addr, &token, &headers, async |state, link| {
        if link.subject_kind != KIND_ALBUM || link.caps & CAP_VIEW == 0 {
            return Err(gone());
        }
        let (mounts, album) = {
            let conn = state.db.lock().map_err(|_| busy())?;
            let (_root, album) = album_for_link(&conn, &link)?;
            let mounts = mounted_drives(&conn);
            (mounts, album)
        };
        let limit = query.limit.unwrap_or(80).clamp(1, 200);
        let offset = query.offset.unwrap_or(0);
        let filter = crate::gallery::ListFilter {
            album_id: Some(album.id.clone()),
            album_home_drive: Some(link.drive_id.clone()),
            ..Default::default()
        };
        let page =
            crate::gallery::list_photos(&mounts, None, &filter, limit, offset).map_err(|_| {
                json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Luna couldn't load photos for this album.",
                )
            })?;
        let items: Vec<Value> = page
            .items
            .into_iter()
            .map(|mut p| {
                let (thumb, content, download) = album_media_urls(&token, &p.drive_id, &p.path);
                p.thumb = thumb;
                let mut v = json!(p);
                if let Some(obj) = v.as_object_mut() {
                    obj.insert("content".into(), json!(content));
                    obj.insert("download".into(), json!(download));
                }
                v
            })
            .collect();
        Ok(Json(json!({
            "kind": "album",
            "name": album.name,
            "item_count": album.item_count,
            "caps": caps_to_str(link.caps),
            "items": items,
            "has_more": page.has_more,
            "next_offset": page.next_offset,
        }))
        .into_response())
    })
    .await
}

#[derive(Deserialize)]
struct PublicMediaQuery {
    drive_id: String,
    path: String,
    #[serde(default)]
    variant: Option<String>,
}

/// `GET /s/{token}/media?drive_id&path&variant=thumb|content|download`.
async fn public_media(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(token): Path<String>,
    Query(query): Query<PublicMediaQuery>,
    headers: HeaderMap,
) -> Response {
    run_public(&state, &addr, &token, &headers, async |state, link| {
        if link.subject_kind != KIND_ALBUM || link.caps & CAP_VIEW == 0 {
            return Err(gone());
        }
        let (home_root, album) = {
            let conn = state.db.lock().map_err(|_| busy())?;
            album_for_link(&conn, &link)?
        };
        if !crate::api::gallery::album_item_allowed(
            &link.drive_id,
            &home_root,
            &album,
            &query.drive_id,
            &query.path,
        ) {
            return Err(json_error(
                StatusCode::FORBIDDEN,
                "That photo is not part of this shared album.",
            ));
        }
        let mount = {
            let conn = state.db.lock().map_err(|_| busy())?;
            let drive = db::get_drive(&conn, &query.drive_id)
                .map_err(|_| busy())?
                .filter(|d| !d.mount_point.is_empty())
                .ok_or_else(|| {
                    json_error(StatusCode::NOT_FOUND, "Luna couldn't find that photo.")
                })?;
            PathBuf::from(&drive.mount_point)
        };
        match query.variant.as_deref().unwrap_or("content") {
            "thumb" => {
                let Some(thumb_path) =
                    crate::gallery::thumb_path(&mount, &query.drive_id, &query.path)
                else {
                    return Err(json_error(
                        StatusCode::NOT_FOUND,
                        "That photo is not part of this shared album.",
                    ));
                };
                if !thumb_path.exists() {
                    let drive_id = query.drive_id.clone();
                    let path = query.path.clone();
                    let mount2 = mount.clone();
                    let _ = tokio::task::spawn_blocking(move || {
                        let src = luna_core::path::resolve_child(&mount2, &path).ok()?;
                        let dest = crate::gallery::thumb_path(&mount2, &drive_id, &path)?;
                        let kind = if crate::gallery::is_video(&src) {
                            "video"
                        } else {
                            "image"
                        };
                        crate::gallery::ensure_thumb(&src, &dest, kind).ok()
                    })
                    .await;
                }
                crate::api::gallery::serve_thumb(thumb_path).await
            }
            "download" => {
                let abs = luna_core::path::resolve_child(&mount, &query.path).map_err(|_| {
                    json_error(StatusCode::NOT_FOUND, "Luna couldn't find that photo.")
                })?;
                let name = abs
                    .file_name()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "download".into());
                let mime = mime_guess::from_path(&name)
                    .first_or_octet_stream()
                    .essence_str()
                    .to_string();
                crate::api::gallery::serve_media_path(abs, &mime, &name, "attachment", &headers)
                    .await
            }
            _ => {
                let (abs, content_type, filename) = crate::api::gallery::resolve_browser_safe_file(
                    &mount,
                    &query.drive_id,
                    &query.path,
                )
                .await?;
                crate::api::gallery::serve_media_path(
                    abs,
                    &content_type,
                    &filename,
                    "inline",
                    &headers,
                )
                .await
            }
        }
    })
    .await
}

/// `GET /s/{token}/zip` — folder link → folder zip; album link → album zip;
/// file link → the file itself.
async fn public_zip(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(token): Path<String>,
    Query(query): Query<PublicListQuery>,
    headers: HeaderMap,
) -> Response {
    run_public(&state, &addr, &token, &headers, async |state, link| {
        if link.caps & CAP_VIEW == 0 {
            return Err(gone());
        }
        if link.subject_kind == KIND_ALBUM {
            return album_zip_response(&state, &link).await;
        }
        let rel =
            child_under_link(&link.path, query.path.as_deref().unwrap_or("")).ok_or_else(|| {
                json_error(
                    StatusCode::BAD_REQUEST,
                    "That folder isn't part of this shared link.",
                )
            })?;
        let is_dir = {
            let conn = state.db.lock().map_err(|_| busy())?;
            files::resolve_any(&conn, &link.drive_id, &rel)
                .map(|(_, m)| m.is_dir())
                .map_err(|_| {
                    json_error(
                        StatusCode::NOT_FOUND,
                        "The shared files aren't available right now.",
                    )
                })?
        };
        if !is_dir {
            return serve_file(&state, &link.drive_id, &rel, true).await;
        }
        folder_zip_response(&state, &link, &rel).await
    })
    .await
}

async fn folder_zip_response(
    state: &AppState,
    link: &AccessLinkRow,
    rel: &str,
) -> Result<Response, ApiError> {
    let zip_name = format!("{}.zip", files::zip_archive_basename(rel));
    let drive_id = link.drive_id.clone();
    let scope = link.path.clone();
    let rel_owned = rel.to_string();
    let state = state.clone();
    crate::api::gallery::stream_zip_response(&zip_name, move |tmp_path| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(tmp_path)
            .map_err(|_| {
                json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Luna couldn't prepare that folder download. Try again.",
                )
            })?;
        let conn = state.db.lock().map_err(|_| busy())?;
        files::write_folder_zip(&conn, &drive_id, &rel_owned, &mut file, |child| {
            path_contains(&scope, child)
        })
        .map(|_| ())
        .map_err(|e| {
            let msg = e.to_string();
            if msg.contains("folder too large") {
                json_error(
                    StatusCode::BAD_REQUEST,
                    "That folder has too many files to download as one zip. Download smaller folders instead.",
                )
            } else {
                json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Luna couldn't prepare that folder download. Try again.",
                )
            }
        })
    })
    .await
}

async fn album_zip_response(state: &AppState, link: &AccessLinkRow) -> Result<Response, ApiError> {
    let (home_root, album) = {
        let conn = state.db.lock().map_err(|_| busy())?;
        album_for_link(&conn, &link)?
    };
    let refs = crate::gallery::list_album_item_refs(&home_root, &album.id).map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't open that album.",
        )
    })?;
    if refs.is_empty() {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "This album has no photos to download yet.",
        ));
    }
    if refs.len() > PUBLIC_ALBUM_ZIP_MAX {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            format!(
                "This album has too many photos to download as one zip (limit {PUBLIC_ALBUM_ZIP_MAX})."
            ),
        ));
    }
    let mut entries: Vec<(String, PathBuf)> = Vec::with_capacity(refs.len());
    {
        let conn = state.db.lock().map_err(|_| busy())?;
        for (drive_id, path) in refs {
            if !crate::api::gallery::album_item_allowed(
                &link.drive_id,
                &home_root,
                &album,
                &drive_id,
                &path,
            ) {
                continue;
            }
            let Ok(Some(drive)) = db::get_drive(&conn, &drive_id) else {
                continue;
            };
            if drive.mount_point.is_empty() {
                continue;
            }
            let mount = PathBuf::from(&drive.mount_point);
            let Ok(abs) = luna_core::path::resolve_child(&mount, &path) else {
                continue;
            };
            if !abs.is_file() {
                continue;
            }
            entries.push((crate::api::gallery::zip_entry_name(&drive_id, &path), abs));
        }
    }
    if entries.is_empty() {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "This album has no photos to download yet.",
        ));
    }
    let zip_name = {
        let base = files::content_disposition_filename(&album.name);
        if base == "download" || base.is_empty() {
            "album.zip".into()
        } else {
            format!("{base}.zip")
        }
    };
    crate::api::gallery::stream_zip_response(&zip_name, move |tmp_path| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(tmp_path)
            .map_err(|_| {
                json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Luna couldn't prepare that download. Try again.",
                )
            })?;
        crate::gallery::write_items_zip(&entries, &mut file, PUBLIC_ALBUM_ZIP_MAX).map_err(|e| {
            let msg = e.to_string();
            if msg.contains("too many files") {
                json_error(
                    StatusCode::BAD_REQUEST,
                    format!(
                        "This album has too many photos to download as one zip (limit {PUBLIC_ALBUM_ZIP_MAX})."
                    ),
                )
            } else {
                json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Luna couldn't prepare that download. Try again.",
                )
            }
        })?;
        Ok(())
    })
    .await
}

// --- Public uploads ---------------------------------------------------------

#[derive(Deserialize)]
struct PublicUploadCreate {
    name: String,
    size: u64,
    /// Subfolder inside a folder link; ignored for drop boxes and albums.
    #[serde(default)]
    path: Option<String>,
}

#[derive(Deserialize)]
struct PublicUploadCompleteQuery {
    overwrite: Option<String>,
    hash: Option<String>,
}

pub(crate) fn require_link_view(link: &AccessLinkRow) -> Result<(), ApiError> {
    if link.caps & CAP_VIEW != 0 {
        Ok(())
    } else {
        Err(json_error(
            StatusCode::FORBIDDEN,
            "This link is for dropping files off — it doesn't open what others have added.",
        ))
    }
}

pub(crate) fn require_link_edit(link: &AccessLinkRow) -> Result<(), ApiError> {
    if link.caps & CAP_EDIT != 0 {
        Ok(())
    } else {
        Err(json_error(
            StatusCode::FORBIDDEN,
            "This link doesn't allow changes. Ask for a link that allows editing.",
        ))
    }
}

fn require_link_upload(link: &AccessLinkRow) -> Result<(), ApiError> {
    if link.caps & CAP_UPLOAD != 0 {
        Ok(())
    } else {
        Err(json_error(
            StatusCode::FORBIDDEN,
            "This link is view-only, so it can't receive files. Ask for a link that allows uploads.",
        ))
    }
}

fn mounted_drives(conn: &rusqlite::Connection) -> Vec<(String, PathBuf)> {
    db::list_drives(conn)
        .unwrap_or_default()
        .into_iter()
        .filter(|d| d.state == "as_is" && !d.mount_point.is_empty())
        .map(|d| (d.id, PathBuf::from(d.mount_point)))
        .collect()
}

/// Where an upload through `link` lands. Folder links: inside the shared
/// folder (or a subfolder the guest browsed to). File links: replace the
/// shared file. Album links: the album's contribution folder. Returns
/// `(drive_id, dest_dir, name_override)`.
fn upload_dest(
    conn: &rusqlite::Connection,
    link: &AccessLinkRow,
    rel: Option<&str>,
) -> Result<(String, String, Option<String>), ApiError> {
    if link.subject_kind == KIND_ALBUM {
        let (root, album) = album_for_link(conn, link)?;
        let contrib = if album.contrib_path.trim().is_empty() {
            crate::gallery::allocate_contrib_dir(&root, &album.id, &album.name).map_err(|_| {
                json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Luna couldn't prepare the upload folder.",
                )
            })?
        } else {
            album.contrib_path.clone()
        };
        std::fs::create_dir_all(root.join(&contrib)).map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't prepare the upload folder.",
            )
        })?;
        return Ok((link.drive_id.clone(), contrib, None));
    }
    let (_resolved, meta) = files::resolve_any(conn, &link.drive_id, &link.path).map_err(|_| {
        json_error(
            StatusCode::NOT_FOUND,
            "The shared folder isn't available right now.",
        )
    })?;
    if meta.is_dir() {
        // Drop boxes always land at the share root — letting a blind uploader
        // name a subfolder would let them probe which folders exist.
        let rel = if link.caps & CAP_VIEW == 0 { None } else { rel };
        let dest = child_under_link(&link.path, rel.unwrap_or("")).ok_or_else(|| {
            json_error(
                StatusCode::BAD_REQUEST,
                "That folder isn't part of this shared link.",
            )
        })?;
        let (_resolved, dest_meta) =
            files::resolve_any(conn, &link.drive_id, &dest).map_err(|_| {
                json_error(
                    StatusCode::NOT_FOUND,
                    "That folder isn't part of this shared link.",
                )
            })?;
        if !dest_meta.is_dir() {
            return Err(json_error(
                StatusCode::BAD_REQUEST,
                "Uploads can only go into a folder.",
            ));
        }
        Ok((link.drive_id.clone(), dest, None))
    } else {
        // Full-access link to a single file: uploading replaces that file.
        let parent = link
            .path
            .rsplit_once('/')
            .map(|(p, _)| p.to_string())
            .unwrap_or_default();
        let name = link
            .path
            .rsplit('/')
            .next()
            .filter(|n| !n.is_empty())
            .ok_or_else(|| {
                json_error(
                    StatusCode::BAD_REQUEST,
                    "Luna can't work out which file this link points at.",
                )
            })?
            .to_string();
        Ok((link.drive_id.clone(), parent, Some(name)))
    }
}

/// The lock-holder key a guest save claims — `guest:{link}:{session}` from
/// `X-Diagram-Session`. A missing or mismatched header is just a different
/// session, which is exactly what the diagram lock conflict check refuses.
fn guest_save_key(link: &AccessLinkRow, headers: &HeaderMap) -> String {
    crate::api::diagram_locks::guest_lock_key(
        &link.id,
        &crate::api::diagram_locks::session_header(headers),
    )
}

/// An upload session belongs to a link when it lands in the link's scope:
/// inside the shared folder tree, replacing the shared file, or in the
/// album's contribution folder.
fn upload_in_link_scope(
    conn: &rusqlite::Connection,
    link: &AccessLinkRow,
    drive_id: &str,
    dest_path: &str,
    name: &str,
) -> bool {
    if link.drive_id != drive_id {
        return false;
    }
    if link.subject_kind == KIND_ALBUM {
        return album_for_link(conn, link)
            .map(|(_, album)| !album.contrib_path.is_empty() && dest_path == album.contrib_path)
            .unwrap_or(false);
    }
    if link.path.is_empty() {
        return true; // whole-drive link covers every folder
    }
    let base = link.path.trim_end_matches('/');
    if dest_path == base || dest_path.starts_with(&format!("{base}/")) {
        return true;
    }
    // File link: the upload lands in the parent dir under the shared name.
    let joined = if dest_path.is_empty() {
        name.to_string()
    } else {
        format!("{}/{}", dest_path.trim_end_matches('/'), name)
    };
    joined == base
}

async fn public_upload_create(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(token): Path<String>,
    headers: HeaderMap,
    Json(body): Json<PublicUploadCreate>,
) -> Response {
    // Guest uploads open writable sessions on real drives; cap how many one
    // address can start so a drop box can't fill the disk with half-uploads.
    if !state.share_limiter.allow(&format!("upload:{}", addr.ip())) {
        return finish_public(
            Err(json_error(
                StatusCode::TOO_MANY_REQUESTS,
                "Too many uploads from this address just now. Wait a minute and try again.",
            )),
            "",
            None,
            &headers,
        );
    }
    run_public(&state, &addr, &token, &headers, async |state, link| {
        require_link_upload(&link)?;
        if body.size > MAX_FILE_BYTES {
            return Err(json_error(
                StatusCode::BAD_REQUEST,
                "Luna can't accept files larger than 1 TB.",
            ));
        }
        let name = files::safe_name(&body.name).map_err(|_| {
            json_error(
                StatusCode::BAD_REQUEST,
                "That file name can't be used. Try renaming it.",
            )
        })?;
        let (drive_id, dest, name_override) = {
            let conn = state.db.lock().map_err(|_| busy())?;
            let (drive_id, dest, name_override) = upload_dest(&conn, &link, body.path.as_deref())?;
            if link.subject_kind == KIND_ALBUM
                && !crate::gallery::is_media(std::path::Path::new(&name))
            {
                return Err(json_error(
                    StatusCode::BAD_REQUEST,
                    "Only photos and videos can go in this album.",
                ));
            }
            (drive_id, dest, name_override)
        };
        let upload = {
            let conn = state.db.lock().map_err(|_| busy())?;
            uploads::create(
                &conn,
                &drive_id,
                &dest,
                name_override.as_deref().unwrap_or(&name),
                body.size,
            )
            .map_err(map_upload_err)?
        };
        Ok(Json(json!({
            "upload_id": upload.id,
            "received": upload.received,
            "size": upload.size,
            "name": upload.name,
        }))
        .into_response())
    })
    .await
}

/// Fetch the upload row and verify it belongs to this link.
fn scoped_upload(
    conn: &rusqlite::Connection,
    link: &AccessLinkRow,
    upload_id: &str,
) -> Result<db::UploadRow, ApiError> {
    let row = uploads::get_row(conn, upload_id).map_err(map_upload_err)?;
    if !upload_in_link_scope(conn, link, &row.drive_id, &row.path, &row.name) {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "That upload isn't part of this link.",
        ));
    }
    Ok(row)
}

async fn public_upload_chunk(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path((token, id)): Path<(String, String)>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    run_public(&state, &addr, &token, &headers, async |state, link| {
        require_link_upload(&link)?;
        {
            let conn = state.db.lock().map_err(|_| busy())?;
            scoped_upload(&conn, &link, &id)?;
        }
        let spec = headers
            .get(header::CONTENT_RANGE)
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| {
                json_error(
                    StatusCode::BAD_REQUEST,
                    "Each chunk needs a Content-Range header (bytes start-end/total).",
                )
            })?;
        let range = spec
            .strip_prefix("bytes ")
            .and_then(|rest| rest.split('/').next())
            .ok_or_else(|| json_error(StatusCode::BAD_REQUEST, "That chunk range isn't valid."))?;
        let (start, end) = crate::api::files::parse_range(&format!("bytes={range}"), MAX_FILE_BYTES)
            .ok_or_else(|| json_error(StatusCode::BAD_REQUEST, "That chunk range isn't valid."))?;
        let expected = (end - start + 1) as usize;
        if body.len() != expected {
            return Err(json_error(
                StatusCode::BAD_REQUEST,
                "The chunk size doesn't match its range.",
            ));
        }
        let chunk_max = crate::budget::limits().upload_chunk_bytes;
        if body.len() > chunk_max {
            return Err(json_error(
                StatusCode::PAYLOAD_TOO_LARGE,
                "That upload chunk is too large for the free memory on this Luna. Try a smaller piece, or free some space and try again.",
            ));
        }
        let received = uploads::write_chunk(&state.db, &id, start, &body).map_err(map_upload_err)?;
        Ok(Json(json!({ "upload_id": id, "received": received })).into_response())
    })
    .await
}

async fn public_upload_complete(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path((token, id)): Path<(String, String)>,
    Query(query): Query<PublicUploadCompleteQuery>,
    headers: HeaderMap,
) -> Response {
    run_public(&state, &addr, &token, &headers, async |state, link| {
        require_link_upload(&link)?;
        let row = {
            let conn = state.db.lock().map_err(|_| busy())?;
            scoped_upload(&conn, &link, &id)?
        };
        // Full-access links may overwrite (that's how "replace this file"
        // works). View-blind links (drop boxes, album contribution) never
        // overwrite silently — a name clash auto-renames, because the guest
        // can't see which names are taken and a bare error would leak one.
        let overwrite = query.overwrite.as_deref() == Some("1") && link.caps & CAP_EDIT != 0;
        let rename_on_conflict = link.caps & CAP_VIEW == 0;
        // HACK (api::diagram_locks): while another editor session holds the
        // diagram lock on the leaf this upload would write, refuse the save —
        // same rule as the member path, keyed by the guest's session header.
        let leaf = crate::gallery::gallery_indexer::join_rel(&row.path, &row.name);
        crate::api::diagram_locks::check_save_allowed(
            &state,
            &guest_save_key(&link, &headers),
            &crate::api::diagram_locks::session_header(&headers),
            &row.drive_id,
            &leaf,
        )?;
        let entry = uploads::complete(
            &state.db,
            &id,
            overwrite,
            rename_on_conflict,
            query.hash.as_deref(),
        )
        .map_err(map_upload_err)?;
        let rel = crate::gallery::gallery_indexer::join_rel(&row.path, &entry.name);
        if link.subject_kind == KIND_ALBUM {
            // Album contributions: index the file and attach it to the album.
            let (root, album) = {
                let conn = state.db.lock().map_err(|_| busy())?;
                album_for_link(&conn, &link)?
            };
            match crate::gallery::index_one(&link.drive_id, &root, &rel) {
                Ok(Some(_)) => {
                    let _ = crate::gallery::add_album_items(
                        &root,
                        &album.id,
                        &[(link.drive_id.clone(), rel.clone())],
                    );
                }
                _ => {
                    let _ = std::fs::remove_file(root.join(&rel));
                    return Err(json_error(
                        StatusCode::BAD_REQUEST,
                        "Only photos and videos can go in this album.",
                    ));
                }
            }
        } else {
            state.gallery.upsert(&row.drive_id, &rel);
        }
        state.touch_io_activity();
        Ok(Json(entry).into_response())
    })
    .await
}

async fn public_upload_cancel(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path((token, id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    run_public(&state, &addr, &token, &headers, async |state, link| {
        require_link_upload(&link)?;
        {
            let conn = state.db.lock().map_err(|_| busy())?;
            scoped_upload(&conn, &link, &id)?;
        }
        uploads::cancel(&state.db, &id).map_err(map_upload_err)?;
        Ok(Json(json!({ "ok": true })).into_response())
    })
    .await
}

// ---------------------------------------------------------------------------
// Guest file operations — the same verbs the signed-in browser has, resolved
// through the link. CAP_VIEW reads, CAP_UPLOAD creates, CAP_EDIT mutates.
// Every path is scoped to the link root: a link can never touch the file or
// folder it points at (renaming or deleting the root would orphan the token).
// ---------------------------------------------------------------------------

/// Resolve a guest-facing `rel` (relative to the link root) to a drive path
/// inside the link. The root itself is a valid read target.
pub(crate) fn readable_child(link: &AccessLinkRow, rel: &str) -> Result<String, ApiError> {
    child_under_link(&link.path, rel.trim()).ok_or_else(|| {
        json_error(
            StatusCode::BAD_REQUEST,
            "That path isn't inside this share.",
        )
    })
}

/// Resolve a guest-facing `relative` path to the drive path of an existing
/// file inside `link` — view capability required, non-path subjects refused,
/// and the canonical target must stay inside the canonical link root.
/// Returns the drive-relative path.
pub(crate) fn link_file(
    state: &AppState,
    link: &AccessLinkRow,
    relative: &str,
) -> Result<String, ApiError> {
    require_link_view(link)?;
    if link.subject_kind != KIND_PATH {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "This link does not open files.",
        ));
    }
    let path = readable_child(link, relative)?;
    let conn = state.db.lock().map_err(|_| busy())?;
    let (root, root_meta) =
        files::resolve_any(&conn, &link.drive_id, &link.path).map_err(map_guest_files_err)?;
    // A file link only ever opens itself — children of a file are refused
    // before the filesystem gets a chance to confuse "file/child" with a
    // sibling path.
    if !root_meta.is_dir() && path != link.path {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "That file is not inside this share.",
        ));
    }
    let (target, _) =
        files::file_path(&conn, &link.drive_id, &path).map_err(map_guest_files_err)?;
    let inside = if root_meta.is_dir() {
        target.starts_with(&root)
    } else {
        target == root
    };
    if !inside {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "That file is not inside this share.",
        ));
    }
    Ok(path)
}

/// `readable_child` for mutations: the link root itself is never mutable.
fn mutable_child(link: &AccessLinkRow, rel: &str) -> Result<String, ApiError> {
    let trimmed = rel.trim().trim_matches('/');
    if trimmed.is_empty() {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "The shared item itself can't be changed through this link.",
        ));
    }
    let joined = readable_child(link, trimmed)?;
    if joined == link.path.trim_end_matches('/') {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "The shared item itself can't be changed through this link.",
        ));
    }
    Ok(joined)
}

/// For upload-only links (no view), a guest can name one item at the shared
/// root but can't navigate — nested paths would leak the drop box's layout.
fn guest_child_for_create(link: &AccessLinkRow, rel: &str) -> Result<String, ApiError> {
    let trimmed = rel.trim().trim_matches('/');
    if link.caps & CAP_VIEW == 0 && trimmed.contains('/') {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "This link only accepts items at the top level.",
        ));
    }
    mutable_child(link, trimmed)
}

fn map_guest_files_err(err: files::FilesError) -> ApiError {
    use std::io::ErrorKind;
    match err {
        files::FilesError::Io(ref e) if e.kind() == ErrorKind::AlreadyExists => json_error(
            StatusCode::CONFLICT,
            "An item with this name is already here. Choose another name.",
        ),
        files::FilesError::Io(ref e) if e.kind() == ErrorKind::NotFound => json_error(
            StatusCode::NOT_FOUND,
            "Luna can't find that anymore. Refresh and try again.",
        ),
        files::FilesError::Path(luna_core::path::PathError::NotFound(_)) => json_error(
            StatusCode::NOT_FOUND,
            "Luna can't find that anymore. Refresh and try again.",
        ),
        files::FilesError::Io(ref e) if e.kind() == ErrorKind::NotADirectory => {
            json_error(StatusCode::BAD_REQUEST, "That destination isn't a folder.")
        }
        files::FilesError::Io(ref e) if e.kind() == ErrorKind::InvalidInput => {
            json_error(StatusCode::BAD_REQUEST, "That name isn't allowed here.")
        }
        _ => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't do that. Check the drive and try again.",
        ),
    }
}

fn invalidate_guest_listing(state: &AppState, drive_id: &str, rel: &str) {
    let parent = rel.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
    state.ram_cache.invalidate_listing(drive_id, parent);
    state.ram_cache.invalidate_listing_tree(drive_id, rel);
}

async fn public_stat(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(token): Path<String>,
    Query(query): Query<PublicListQuery>,
    headers: HeaderMap,
) -> Response {
    run_public(&state, &addr, &token, &headers, async |state, link| {
        require_link_view(&link)?;
        let rel = readable_child(&link, query.path.as_deref().unwrap_or(""))?;
        let stat = {
            let conn = state.db.lock().map_err(|_| busy())?;
            files::stat(&conn, &link.drive_id, &rel).map_err(map_guest_files_err)?
        };
        Ok(Json(json!({
            "name": stat.name,
            "kind": stat.kind,
            "size": stat.size,
            "modified": stat.modified,
            "created": stat.created,
            "hidden": stat.hidden,
            "writable": link.caps & CAP_EDIT != 0 && rel != link.path.trim_end_matches('/'),
            "children": stat.children,
            "totals": stat.totals,
        }))
        .into_response())
    })
    .await
}

#[derive(Deserialize)]
struct PublicWriteBody {
    path: String,
}

async fn public_mkdir(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(token): Path<String>,
    headers: HeaderMap,
    Json(body): Json<PublicWriteBody>,
) -> Response {
    run_public(&state, &addr, &token, &headers, async |state, link| {
        require_link_upload(&link)?;
        let rel = guest_child_for_create(&link, &body.path)?;
        {
            let conn = state.db.lock().map_err(|_| busy())?;
            files::mkdir(&conn, &link.drive_id, &rel).map_err(map_guest_files_err)?;
        }
        invalidate_guest_listing(&state, &link.drive_id, &rel);
        state.touch_io_activity();
        Ok(Json(json!({ "ok": true, "path": rel })).into_response())
    })
    .await
}

async fn public_create(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(token): Path<String>,
    headers: HeaderMap,
    Json(body): Json<PublicWriteBody>,
) -> Response {
    run_public(&state, &addr, &token, &headers, async |state, link| {
        require_link_upload(&link)?;
        let rel = guest_child_for_create(&link, &body.path)?;
        // HACK (api::diagram_locks): creating a .drawio another editor
        // session holds the lock on is refused like any other save.
        crate::api::diagram_locks::check_save_allowed(
            &state,
            &guest_save_key(&link, &headers),
            &crate::api::diagram_locks::session_header(&headers),
            &link.drive_id,
            &rel,
        )?;
        {
            let conn = state.db.lock().map_err(|_| busy())?;
            files::create(&conn, &link.drive_id, &rel).map_err(map_guest_files_err)?;
        }
        invalidate_guest_listing(&state, &link.drive_id, &rel);
        state.touch_io_activity();
        Ok(Json(json!({ "ok": true, "path": rel })).into_response())
    })
    .await
}

#[derive(Deserialize)]
struct PublicRenameBody {
    path: String,
    new_name: String,
}

async fn public_rename(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(token): Path<String>,
    headers: HeaderMap,
    Json(body): Json<PublicRenameBody>,
) -> Response {
    run_public(&state, &addr, &token, &headers, async |state, link| {
        require_link_edit(&link)?;
        let rel = mutable_child(&link, &body.path)?;
        let parent = rel.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
        let new_rel = crate::gallery::gallery_indexer::join_rel(parent, &body.new_name);
        {
            let conn = state.db.lock().map_err(|_| busy())?;
            files::rename(&conn, &link.drive_id, &rel, &body.new_name)
                .map_err(map_guest_files_err)?;
        }
        // Folder renames move many gallery rows; rescan is the safe path.
        let renamed_dir = {
            let conn = state.db.lock().map_err(|_| busy())?;
            files::drive_root(&conn, &link.drive_id)
                .map(|d| PathBuf::from(&d.mount_point).join(&new_rel).is_dir())
                .unwrap_or(false)
        };
        if renamed_dir {
            state.gallery.rescan(&link.drive_id);
        } else {
            state.gallery.rename(&link.drive_id, &rel, &new_rel);
        }
        invalidate_guest_listing(&state, &link.drive_id, &rel);
        invalidate_guest_listing(&state, &link.drive_id, &new_rel);
        state.ram_cache.invalidate_thumb(&link.drive_id, &rel);
        state.touch_io_activity();
        Ok(Json(json!({ "ok": true })).into_response())
    })
    .await
}

async fn public_delete(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(token): Path<String>,
    Query(query): Query<PublicListQuery>,
    headers: HeaderMap,
) -> Response {
    run_public(&state, &addr, &token, &headers, async |state, link| {
        require_link_edit(&link)?;
        let rel = mutable_child(&link, query.path.as_deref().unwrap_or(""))?;
        let trash_path = {
            let conn = state.db.lock().map_err(|_| busy())?;
            files::delete_to_trash(&conn, &link.drive_id, &rel).map_err(map_guest_files_err)?
        };
        state.gallery.remove(&link.drive_id, &rel);
        // Eagerly drop album refs so shared albums update without the indexer.
        if let Ok(conn) = state.db.lock()
            && let Ok(drives) = db::list_drives(&conn)
        {
            let mounts: Vec<(String, PathBuf)> = drives
                .into_iter()
                .filter(|d| d.state == "as_is" && !d.mount_point.is_empty())
                .map(|d| (d.id, PathBuf::from(d.mount_point)))
                .collect();
            crate::gallery::purge_album_item_refs_on_mounts(&mounts, &link.drive_id, &rel);
        }
        invalidate_guest_listing(&state, &link.drive_id, &rel);
        state.ram_cache.invalidate_thumb(&link.drive_id, &rel);
        state.ram_cache.remove_dirty(&link.drive_id, &rel);
        state.touch_io_activity();
        Ok(Json(json!({ "ok": true, "trash_path": trash_path })).into_response())
    })
    .await
}

#[derive(Deserialize)]
struct PublicMoveBody {
    paths: Vec<String>,
    dest: Option<String>,
}

async fn public_move(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(token): Path<String>,
    headers: HeaderMap,
    Json(body): Json<PublicMoveBody>,
) -> Response {
    run_public(&state, &addr, &token, &headers, async |state, link| {
        require_link_edit(&link)?;
        if body.paths.is_empty() {
            return Err(json_error(StatusCode::BAD_REQUEST, "Nothing to move."));
        }
        let dest_dir = readable_child(&link, body.dest.as_deref().unwrap_or(""))?;
        let mut results = Vec::new();
        for rel_guest in &body.paths {
            let rel = mutable_child(&link, rel_guest)?;
            let leaf = rel.rsplit('/').next().unwrap_or(&rel);
            let to_rel = crate::gallery::gallery_indexer::join_rel(&dest_dir, leaf);
            let outcome = {
                let conn = state.db.lock().map_err(|_| busy())?;
                files::move_rel(&conn, &link.drive_id, &rel, &to_rel)
            };
            match outcome {
                Ok(()) => {
                    let moved_dir = {
                        let conn = state.db.lock().map_err(|_| busy())?;
                        files::drive_root(&conn, &link.drive_id)
                            .map(|d| PathBuf::from(&d.mount_point).join(&to_rel).is_dir())
                            .unwrap_or(false)
                    };
                    if moved_dir {
                        state.gallery.rescan(&link.drive_id);
                    } else {
                        state.gallery.rename(&link.drive_id, &rel, &to_rel);
                    }
                    invalidate_guest_listing(&state, &link.drive_id, &rel);
                    invalidate_guest_listing(&state, &link.drive_id, &to_rel);
                    state.ram_cache.invalidate_thumb(&link.drive_id, &rel);
                    results.push(json!({ "path": rel_guest, "ok": true }));
                }
                Err(e) => {
                    let (status, Json(err)) = map_guest_files_err(e);
                    results.push(json!({
                        "path": rel_guest,
                        "ok": false,
                        "status": status.as_u16(),
                        "error": err.get("error").cloned().unwrap_or(json!("Move failed.")),
                    }));
                }
            }
        }
        state.touch_io_activity();
        let all_ok = results.iter().all(|r| r["ok"] == true);
        let status = if all_ok {
            StatusCode::OK
        } else {
            StatusCode::MULTI_STATUS
        };
        Ok((status, Json(json!({ "results": results }))).into_response())
    })
    .await
}

async fn serve_file(
    state: &AppState,
    drive_id: &str,
    rel: &str,
    download: bool,
) -> Result<Response, ApiError> {
    // Open against a re-verified descriptor so a mid-request symlink swap on
    // the drive cannot read outside the jail.
    let (file, path) = {
        let conn = state.db.lock().map_err(|_| busy())?;
        let drive = db::get_drive(&conn, drive_id)
            .map_err(|_| busy())?
            .filter(|d| !d.mount_point.is_empty())
            .ok_or_else(|| {
                json_error(
                    StatusCode::NOT_FOUND,
                    "The shared file isn't available right now.",
                )
            })?;
        let root = PathBuf::from(&drive.mount_point);
        luna_core::path::open_verified(&root, rel).map_err(|_| {
            json_error(
                StatusCode::NOT_FOUND,
                "The shared file isn't available right now.",
            )
        })?
    };
    let file = tokio::fs::File::from_std(file);
    let meta = std::fs::metadata(&path).map_err(|_| {
        json_error(
            StatusCode::NOT_FOUND,
            "The shared file isn't available right now.",
        )
    })?;
    let mime = mime_guess::from_path(&path).first_or_octet_stream();
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "download".into());
    let disposition = if !download && files::inline_safe(mime.as_ref()) {
        "inline"
    } else {
        "attachment"
    };
    let stream = tokio_util::io::ReaderStream::new(file);
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime.as_ref())
        .header(header::CONTENT_LENGTH, meta.len().to_string())
        .header(header::CACHE_CONTROL, "private, no-store")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(
            header::CONTENT_DISPOSITION,
            format!(
                "{disposition}; filename=\"{}\"",
                files::content_disposition_filename(&name)
            ),
        )
        .body(Body::from_stream(stream))
        .map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't open this link.",
            )
        })
}

fn map_upload_err(err: uploads::UploadError) -> ApiError {
    use std::io::ErrorKind;
    match err {
        uploads::UploadError::NotFound => {
            json_error(StatusCode::NOT_FOUND, "Luna doesn't know this upload.")
        }
        uploads::UploadError::NotActive => json_error(
            StatusCode::CONFLICT,
            "This upload is already finished or cancelled.",
        ),
        uploads::UploadError::SizeMismatch => json_error(
            StatusCode::BAD_REQUEST,
            "The upload isn't complete yet. Check the connection and try again.",
        ),
        uploads::UploadError::Files(crate::files::FilesError::Io(e))
            if e.kind() == ErrorKind::AlreadyExists =>
        {
            json_error(
                StatusCode::CONFLICT,
                "A file with this name is already here. Rename it or choose another.",
            )
        }
        uploads::UploadError::Files(crate::files::FilesError::Io(e))
            if e.kind() == ErrorKind::NotADirectory =>
        {
            json_error(StatusCode::BAD_REQUEST, "That destination is not a folder.")
        }
        uploads::UploadError::Io(e) if e.kind() == ErrorKind::AlreadyExists => json_error(
            StatusCode::CONFLICT,
            "A file with this name is already here. Rename it or choose another.",
        ),
        _ => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't finish that upload. Check the drive and try again.",
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::access::CAP_ALL;
    use axum::http::HeaderValue;

    fn link(path: &str, caps: Caps) -> AccessLinkRow {
        AccessLinkRow {
            id: "l1".into(),
            token_hash: "tok".into(),
            token: "t".into(),
            subject_kind: KIND_PATH.into(),
            drive_id: "d1".into(),
            path: path.into(),
            album_id: String::new(),
            caps,
            password_hash: String::new(),
            expires_at: None,
            created_by: "u1".into(),
            created_at: 0,
        }
    }

    #[test]
    fn child_under_link_stays_inside_the_shared_folder() {
        assert_eq!(
            child_under_link("photos/summer", "beach.jpg").as_deref(),
            Some("photos/summer/beach.jpg")
        );
        assert_eq!(child_under_link("photos", "").as_deref(), Some("photos"));
        assert_eq!(child_under_link("", "a/b").as_deref(), Some("a/b"));
        assert!(child_under_link("photos", "../etc").is_none());
        assert!(child_under_link("photos", "/etc/passwd").is_none());
    }

    #[test]
    fn prefers_html_follows_accept_order() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::ACCEPT,
            HeaderValue::from_static("text/html,application/xhtml+xml,application/json"),
        );
        assert!(prefers_html(&headers));
        headers.insert(header::ACCEPT, HeaderValue::from_static("application/json"));
        assert!(!prefers_html(&headers));
    }

    #[test]
    fn upload_scope_covers_whole_drive_links() {
        let dir = tempfile::tempdir().unwrap();
        let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
        let link = link("", CAP_ALL);
        assert!(upload_in_link_scope(
            &conn,
            &link,
            "d1",
            "photos",
            "beach.jpg"
        ));
        assert!(upload_in_link_scope(&conn, &link, "d1", "", "root.txt"));
        assert!(!upload_in_link_scope(
            &conn,
            &link,
            "d2",
            "photos",
            "beach.jpg"
        ));
    }

    #[test]
    fn upload_scope_is_shared_folder_for_folder_links() {
        let dir = tempfile::tempdir().unwrap();
        let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
        let link = link("photos", CAP_VIEW | CAP_UPLOAD);
        assert!(upload_in_link_scope(
            &conn,
            &link,
            "d1",
            "photos",
            "beach.jpg"
        ));
        assert!(upload_in_link_scope(
            &conn,
            &link,
            "d1",
            "photos/summer",
            "beach.jpg"
        ));
        assert!(!upload_in_link_scope(
            &conn,
            &link,
            "d1",
            "photos2024",
            "beach.jpg"
        ));
        assert!(!upload_in_link_scope(
            &conn,
            &link,
            "d1",
            "records",
            "beach.jpg"
        ));
        assert!(!upload_in_link_scope(
            &conn,
            &link,
            "d2",
            "photos",
            "beach.jpg"
        ));
    }

    #[test]
    fn upload_scope_replaces_the_shared_file_for_file_links() {
        let dir = tempfile::tempdir().unwrap();
        let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
        let link = link("photos/beach.jpg", access::CAP_ALL);
        assert!(upload_in_link_scope(
            &conn,
            &link,
            "d1",
            "photos",
            "beach.jpg"
        ));
        assert!(!upload_in_link_scope(
            &conn,
            &link,
            "d1",
            "photos",
            "other.jpg"
        ));
        assert!(!upload_in_link_scope(&conn, &link, "d1", "", "beach.jpg"));
    }
}

#[cfg(test)]
mod http_tests {
    use crate::api;
    use crate::drives::DriveManager;
    use crate::drives::mount::shared_mock;
    use axum::body::Body;
    use axum::extract::ConnectInfo;
    use axum::http::{Method, Request as HttpReq, StatusCode};
    use tower::ServiceExt;

    const CLIENT: std::net::SocketAddr = std::net::SocketAddr::new(
        std::net::IpAddr::V4(std::net::Ipv4Addr::new(127, 0, 0, 1)),
        54321,
    );

    fn test_app(mount: &std::path::Path) -> (tempfile::TempDir, axum::Router) {
        let (dir, app, _state) = test_app_state(mount);
        (dir, app)
    }

    fn test_app_state(
        mount: &std::path::Path,
    ) -> (tempfile::TempDir, axum::Router, crate::AppState) {
        let dir = tempfile::tempdir().unwrap();
        let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
        let prefix = luna_core::marker::pick_prefix(mount).unwrap();
        crate::drives::drive_db::create(
            mount,
            &luna_core::marker::Marker::new("photos", "Photos"),
            &prefix,
        )
        .unwrap();
        crate::db::upsert_drive(
            &conn,
            "photos",
            "Photos",
            "as_is",
            "ext4",
            "sda",
            mount.to_str().unwrap(),
        )
        .unwrap();
        let drive_manager = std::sync::Arc::new(DriveManager::new(shared_mock(), dir.path()));
        let state = crate::AppState::new(conn, drive_manager, dir.path());
        let app = api::router()
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                crate::auth::guard,
            ))
            .with_state(state.clone());
        (dir, app, state)
    }

    fn json_req(
        method: Method,
        uri: &str,
        body: &str,
        cookie: Option<&str>,
        csrf: Option<&str>,
    ) -> HttpReq<Body> {
        let mut builder = HttpReq::builder()
            .method(method)
            .uri(uri)
            .header("content-type", "application/json")
            .header("accept", "application/json");
        if let Some(c) = cookie {
            builder = builder.header("cookie", c);
        }
        if let Some(t) = csrf {
            builder = builder.header("x-csrf-token", t);
        }
        let mut http = builder.body(Body::from(body.to_string())).unwrap();
        http.extensions_mut().insert(ConnectInfo(CLIENT));
        http
    }

    async fn call(app: &axum::Router, r: HttpReq<Body>) -> axum::response::Response {
        app.clone().oneshot(r).await.unwrap()
    }

    async fn body_json(res: axum::response::Response) -> serde_json::Value {
        let body = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        serde_json::from_slice(&body).unwrap()
    }

    /// Register + sign in as the first user (admin). Returns (cookie, csrf).
    async fn admin(app: &axum::Router) -> (String, String) {
        let res = call(
            app,
            json_req(
                Method::POST,
                "/api/v1/auth/register",
                r#"{"username":"max","display_name":"Max","password":"hunter22hunter1"}"#,
                None,
                None,
            ),
        )
        .await;
        assert_eq!(res.status(), 200);
        let res = call(
            app,
            json_req(
                Method::POST,
                "/api/v1/auth/login",
                r#"{"username":"max","password":"hunter22hunter1"}"#,
                None,
                None,
            ),
        )
        .await;
        let mut session = String::new();
        let mut csrf = String::new();
        for value in res.headers().get_all(axum::http::header::SET_COOKIE) {
            let s = value.to_str().unwrap();
            let part = s.split(';').next().unwrap_or("");
            if part.starts_with("luna_session=") {
                session = part.to_string();
            } else if let Some(token) = part.strip_prefix("luna_csrf=") {
                csrf = token.to_string();
            }
        }
        (format!("{session}; luna_csrf={csrf}"), csrf)
    }

    async fn make_link(
        app: &axum::Router,
        cookie: &str,
        csrf: &str,
        body: &str,
    ) -> serde_json::Value {
        let res = call(
            app,
            json_req(
                Method::POST,
                "/api/v1/access/links",
                body,
                Some(cookie),
                Some(csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), 200);
        body_json(res).await
    }

    async fn public_get(app: &axum::Router, uri: &str) -> (StatusCode, serde_json::Value) {
        let res = call(app, json_req(Method::GET, uri, "", None, None)).await;
        let status = res.status();
        (status, body_json(res).await)
    }

    #[tokio::test]
    async fn created_folder_link_resolves_publicly() {
        let mount = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(mount.path().join("family")).unwrap();
        std::fs::write(mount.path().join("family/note.txt"), "hi").unwrap();
        let (_dir, app) = test_app(mount.path());
        let (cookie, csrf) = admin(&app).await;
        let link = make_link(
            &app,
            &cookie,
            &csrf,
            r#"{"kind":"folder","drive_id":"photos","path":"family","caps":"view"}"#,
        )
        .await;
        let token = link["token"].as_str().unwrap();
        let (status, body) = public_get(&app, &format!("/s/{token}?meta=1")).await;
        assert_eq!(status, 200, "{body}");
        assert_eq!(body["kind"], "folder");
        assert_eq!(body["name"], "family");
    }

    #[tokio::test]
    async fn created_file_link_resolves_publicly() {
        let mount = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(mount.path().join("docs")).unwrap();
        std::fs::write(mount.path().join("docs/readme.txt"), "hello").unwrap();
        let (_dir, app) = test_app(mount.path());
        let (cookie, csrf) = admin(&app).await;
        let link = make_link(
            &app,
            &cookie,
            &csrf,
            r#"{"kind":"file","drive_id":"photos","path":"docs/readme.txt","caps":"view"}"#,
        )
        .await;
        let token = link["token"].as_str().unwrap();
        let (status, body) = public_get(&app, &format!("/s/{token}?meta=1")).await;
        assert_eq!(status, 200, "{body}");
        assert_eq!(body["kind"], "file");
        assert_eq!(body["name"], "readme.txt");
    }

    #[tokio::test]
    async fn created_dropbox_link_resolves_publicly() {
        let mount = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(mount.path().join("incoming")).unwrap();
        let (_dir, app) = test_app(mount.path());
        let (cookie, csrf) = admin(&app).await;
        let link = make_link(
            &app,
            &cookie,
            &csrf,
            r#"{"kind":"folder","drive_id":"photos","path":"incoming","caps":"upload"}"#,
        )
        .await;
        let token = link["token"].as_str().unwrap();
        let (status, body) = public_get(&app, &format!("/s/{token}?meta=1")).await;
        assert_eq!(status, 200, "{body}");
        assert_eq!(body["kind"], "dropbox");
    }

    #[tokio::test]
    async fn folder_link_lists_entries() {
        let mount = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(mount.path().join("family")).unwrap();
        std::fs::write(mount.path().join("family/note.txt"), "hi").unwrap();
        let (_dir, app) = test_app(mount.path());
        let (cookie, csrf) = admin(&app).await;
        let link = make_link(
            &app,
            &cookie,
            &csrf,
            r#"{"kind":"folder","drive_id":"photos","path":"family","caps":"view"}"#,
        )
        .await;
        let token = link["token"].as_str().unwrap();
        let (status, body) = public_get(&app, &format!("/s/{token}/list")).await;
        assert_eq!(status, 200, "{body}");
        assert_eq!(body["entries"][0]["name"], "note.txt");
    }

    async fn public_json(
        app: &axum::Router,
        method: Method,
        uri: &str,
        body: &str,
    ) -> (StatusCode, serde_json::Value) {
        let res = call(app, json_req(method, uri, body, None, None)).await;
        let status = res.status();
        (status, body_json(res).await)
    }

    /// Admin-caps folder link over `family/` for the guest-op tests.
    async fn edit_link(app: &axum::Router, caps: &str) -> String {
        let (cookie, csrf) = admin(app).await;
        let link = make_link(
            app,
            &cookie,
            &csrf,
            &format!(r#"{{"kind":"folder","drive_id":"photos","path":"family","caps":"{caps}"}}"#),
        )
        .await;
        link["token"].as_str().unwrap().to_string()
    }

    #[tokio::test]
    async fn guest_stat_reports_in_scope_metadata() {
        let mount = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(mount.path().join("family")).unwrap();
        std::fs::write(mount.path().join("family/note.txt"), "hi").unwrap();
        let (_dir, app) = test_app(mount.path());
        let token = edit_link(&app, "full").await;
        let (status, body) = public_get(&app, &format!("/s/{token}/stat?path=note.txt")).await;
        assert_eq!(status, 200, "{body}");
        assert_eq!(body["name"], "note.txt");
        assert_eq!(body["writable"], true);
        // The link root itself reports not-writable.
        let (status, body) = public_get(&app, &format!("/s/{token}/stat")).await;
        assert_eq!(status, 200, "{body}");
        assert_eq!(body["writable"], false);
    }

    #[tokio::test]
    async fn guest_mkdir_create_rename_move_delete_inside_scope() {
        let mount = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(mount.path().join("family")).unwrap();
        std::fs::write(mount.path().join("family/keep.txt"), "k").unwrap();
        let (_dir, app) = test_app(mount.path());
        let token = edit_link(&app, "full").await;

        let (s, b) = public_json(
            &app,
            Method::POST,
            &format!("/s/{token}/mkdir"),
            r#"{"path":"trips"}"#,
        )
        .await;
        assert_eq!(s, 200, "{b}");
        assert!(mount.path().join("family/trips").is_dir());

        let (s, b) = public_json(
            &app,
            Method::POST,
            &format!("/s/{token}/create"),
            r#"{"path":"trips/plan.md"}"#,
        )
        .await;
        assert_eq!(s, 200, "{b}");
        assert!(mount.path().join("family/trips/plan.md").is_file());

        let (s, b) = public_json(
            &app,
            Method::POST,
            &format!("/s/{token}/rename"),
            r#"{"path":"trips/plan.md","new_name":"route.md"}"#,
        )
        .await;
        assert_eq!(s, 200, "{b}");
        assert!(mount.path().join("family/trips/route.md").is_file());

        let (s, b) = public_json(
            &app,
            Method::POST,
            &format!("/s/{token}/move"),
            r#"{"paths":["keep.txt"],"dest":"trips"}"#,
        )
        .await;
        assert_eq!(s, 200, "{b}");
        assert!(mount.path().join("family/trips/keep.txt").is_file());

        let (s, b) = public_json(
            &app,
            Method::DELETE,
            &format!("/s/{token}/file?path=trips/route.md"),
            "",
        )
        .await;
        assert_eq!(s, 200, "{b}");
        assert!(!mount.path().join("family/trips/route.md").exists());
    }

    #[tokio::test]
    async fn guest_ops_cannot_escape_or_touch_the_link_root() {
        let mount = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(mount.path().join("family")).unwrap();
        std::fs::write(mount.path().join("family/note.txt"), "n").unwrap();
        std::fs::write(mount.path().join("secret.txt"), "s").unwrap();
        let (_dir, app) = test_app(mount.path());
        let token = edit_link(&app, "full").await;

        // Traversal out of scope.
        for (method, uri, body) in [
            (
                Method::DELETE,
                format!("/s/{token}/file?path=../secret.txt"),
                "",
            ),
            (
                Method::POST,
                format!("/s/{token}/rename"),
                r#"{"path":"../secret.txt","new_name":"x"}"#,
            ),
            (
                Method::POST,
                format!("/s/{token}/move"),
                r#"{"paths":["note.txt"],"dest":".."}"#,
            ),
        ] {
            let (s, _) = public_json(&app, method, &uri, body).await;
            assert_eq!(s, 400);
        }
        assert!(mount.path().join("secret.txt").is_file());
        assert!(mount.path().join("family/note.txt").is_file());

        // The shared root itself is not mutable.
        let (s, _) = public_json(&app, Method::DELETE, &format!("/s/{token}/file?path="), "").await;
        assert_eq!(s, 400);
        let (s, _) =
            public_json(&app, Method::DELETE, &format!("/s/{token}/file?path=."), "").await;
        assert_eq!(s, 400);
        assert!(mount.path().join("family").is_dir());
    }

    #[tokio::test]
    async fn guest_view_link_gets_no_write_ops() {
        let mount = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(mount.path().join("family")).unwrap();
        std::fs::write(mount.path().join("family/note.txt"), "n").unwrap();
        let (_dir, app) = test_app(mount.path());
        let token = edit_link(&app, "view").await;

        for (method, uri, body) in [
            (Method::POST, format!("/s/{token}/mkdir"), r#"{"path":"x"}"#),
            (
                Method::POST,
                format!("/s/{token}/rename"),
                r#"{"path":"note.txt","new_name":"y"}"#,
            ),
            (Method::DELETE, format!("/s/{token}/file?path=note.txt"), ""),
            (
                Method::POST,
                format!("/s/{token}/move"),
                r#"{"paths":["note.txt"],"dest":""}"#,
            ),
        ] {
            let (s, _) = public_json(&app, method, &uri, body).await;
            assert_eq!(s, 403);
        }
    }

    #[tokio::test]
    async fn dropbox_link_creates_only_at_top_level() {
        let mount = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(mount.path().join("incoming")).unwrap();
        let (_dir, app) = test_app(mount.path());
        let (cookie, csrf) = admin(&app).await;
        let link = make_link(
            &app,
            &cookie,
            &csrf,
            r#"{"kind":"folder","drive_id":"photos","path":"incoming","caps":"upload"}"#,
        )
        .await;
        let token = link["token"].as_str().unwrap();

        let (s, b) = public_json(
            &app,
            Method::POST,
            &format!("/s/{token}/create"),
            r#"{"path":"hello.txt"}"#,
        )
        .await;
        assert_eq!(s, 200, "{b}");
        let (s, _) = public_json(
            &app,
            Method::POST,
            &format!("/s/{token}/create"),
            r#"{"path":"nested/hello.txt"}"#,
        )
        .await;
        assert_eq!(s, 400);
        // No read-back: stat is view-gated.
        let (s, _) = public_get(&app, &format!("/s/{token}/stat?path=hello.txt")).await;
        assert_eq!(s, 403);
    }

    /// Create a non-admin user and sign in as them. Returns (cookie, csrf, id).
    async fn member(
        app: &axum::Router,
        admin_cookie: &str,
        csrf: &str,
        username: &str,
    ) -> (String, String, String) {
        let res = call(
            app,
            json_req(
                Method::POST,
                "/api/v1/users",
                &format!(r#"{{"username":"{username}","password":"memberpass1{username}"}}"#),
                Some(admin_cookie),
                Some(csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), 200);
        let created = body_json(res).await;
        let id = created["id"].as_str().unwrap().to_string();
        let res = call(
            app,
            json_req(
                Method::POST,
                "/api/v1/auth/login",
                &format!(r#"{{"username":"{username}","password":"memberpass1{username}"}}"#),
                None,
                None,
            ),
        )
        .await;
        assert_eq!(res.status(), 200);
        let mut session = String::new();
        let mut csrf = String::new();
        for value in res.headers().get_all(axum::http::header::SET_COOKIE) {
            let s = value.to_str().unwrap();
            let part = s.split(';').next().unwrap_or("");
            if part.starts_with("luna_session=") {
                session = part.to_string();
            } else if let Some(token) = part.strip_prefix("luna_csrf=") {
                csrf = token.to_string();
            }
        }
        (format!("{session}; luna_csrf={csrf}"), csrf, id)
    }

    async fn add_member(
        app: &axum::Router,
        cookie: &str,
        csrf: &str,
        path: &str,
        user_id: &str,
        caps: &str,
    ) -> serde_json::Value {
        let res = call(
            app,
            json_req(
                Method::POST,
                "/api/v1/access/members",
                &format!(
                    r#"{{"kind":"path","drive_id":"photos","path":"{path}","user_id":"{user_id}","caps":"{caps}"}}"#
                ),
                Some(cookie),
                Some(csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), 200);
        body_json(res).await
    }

    async fn subject(
        app: &axum::Router,
        cookie: &str,
        path: &str,
    ) -> (StatusCode, serde_json::Value) {
        let res = call(
            app,
            json_req(
                Method::GET,
                &format!("/api/v1/access/subject?kind=path&drive_id=photos&path={path}"),
                "",
                Some(cookie),
                None,
            ),
        )
        .await;
        let status = res.status();
        (status, body_json(res).await)
    }

    /// GET against the public surface with an optional password header and
    /// cookie. Returns (status, set-cookie strings, json body).
    async fn public_req(
        app: &axum::Router,
        uri: &str,
        password: Option<&str>,
        cookie: Option<&str>,
    ) -> (StatusCode, Vec<String>, serde_json::Value) {
        let mut builder = HttpReq::builder()
            .method(Method::GET)
            .uri(uri)
            .header("accept", "application/json");
        if let Some(p) = password {
            builder = builder.header("x-share-password", p);
        }
        if let Some(c) = cookie {
            builder = builder.header("cookie", c);
        }
        let mut http = builder.body(Body::from(String::new())).unwrap();
        http.extensions_mut().insert(ConnectInfo(CLIENT));
        let res = call(app, http).await;
        let status = res.status();
        let cookies = res
            .headers()
            .get_all(axum::http::header::SET_COOKIE)
            .iter()
            .map(|v| {
                v.to_str()
                    .unwrap()
                    .split(';')
                    .next()
                    .unwrap_or("")
                    .to_string()
            })
            .collect();
        (status, cookies, body_json(res).await)
    }

    #[tokio::test]
    async fn wider_grant_preserves_explicit_child_rows() {
        let mount = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(mount.path().join("family/kids")).unwrap();
        let (_dir, app) = test_app(mount.path());
        let (cookie, csrf) = admin(&app).await;
        let (mcookie, _mcsrf, sam) = member(&app, &cookie, &csrf, "sam").await;

        // A weak child grant, then a full grant on the parent: the child row
        // must survive (explicit descendants are exceptions, not duplicates).
        add_member(&app, &cookie, &csrf, "family/kids", &sam, "view").await;
        add_member(&app, &cookie, &csrf, "family", &sam, "full").await;

        let (s, st) = subject(&app, &cookie, "family/kids").await;
        assert_eq!(s, 200, "{st}");
        let direct = st["members"].as_array().unwrap();
        assert_eq!(direct.len(), 1, "{st}");
        assert_eq!(direct[0]["caps"], "view");
        assert_eq!(direct[0]["effective_caps"], "full");
        assert_eq!(direct[0]["can_manage"], true);
        let inherited = st["inherited_members"].as_array().unwrap();
        assert_eq!(inherited.len(), 1, "{st}");
        assert_eq!(inherited[0]["caps"], "full");
        assert_eq!(inherited[0]["inherited_from"]["path"], "family");
        assert_eq!(inherited[0]["inherited_from"]["name"], "family");
        // A sibling folder is not an ancestor — nothing leaks sideways.
        std::fs::create_dir_all(mount.path().join("other")).unwrap();
        add_member(&app, &cookie, &csrf, "other", &sam, "view").await;
        let (_, st) = subject(&app, &cookie, "family/kids").await;
        assert_eq!(st["inherited_members"].as_array().unwrap().len(), 1);

        // The member sees every explicit grant, including the retained child.
        let res = call(
            &app,
            json_req(Method::GET, "/api/v1/access/mine", "", Some(&mcookie), None),
        )
        .await;
        let mine = body_json(res).await;
        let paths: Vec<&str> = mine["with_me"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["path"].as_str().unwrap())
            .collect();
        assert!(paths.contains(&"family"), "{mine}");
        assert!(paths.contains(&"family/kids"), "{mine}");
        assert!(paths.contains(&"other"), "{mine}");

        // Roots still collapse to the widest grants for permission math.
        let res = call(
            &app,
            json_req(Method::GET, "/api/v1/me/access", "", Some(&mcookie), None),
        )
        .await;
        let roots = body_json(res).await;
        assert_eq!(roots.as_array().unwrap().len(), 2, "{roots}");

        // Removing the root leaves the explicit child standing.
        let res = call(
            &app,
            json_req(Method::GET, "/api/v1/access/mine", "", Some(&mcookie), None),
        )
        .await;
        let mine = body_json(res).await;
        let root_id = mine["with_me"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["path"] == "family")
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string();
        let res = call(
            &app,
            json_req(
                Method::DELETE,
                &format!("/api/v1/access/members/{root_id}"),
                "",
                Some(&cookie),
                Some(&csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), 200);
        let (_, st) = subject(&app, &cookie, "family/kids").await;
        assert_eq!(st["members"].as_array().unwrap().len(), 1);
        assert_eq!(st["members"][0]["caps"], "view");
        assert_eq!(st["members"][0]["effective_caps"], "view");
        assert!(st["inherited_members"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn inherited_from_flags_parents_the_caller_cannot_open() {
        let mount = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(mount.path().join("family/kids")).unwrap();
        let (_dir, app) = test_app(mount.path());
        let (cookie, csrf) = admin(&app).await;
        let (jcookie, _jcsrf, jules) = member(&app, &cookie, &csrf, "jules").await;
        let (_sc, _scsrf, sam) = member(&app, &cookie, &csrf, "sam").await;
        add_member(&app, &cookie, &csrf, "family", &sam, "full").await;
        add_member(&app, &cookie, &csrf, "family/kids", &jules, "view").await;

        // Jules holds only the child: the parent grant is visible but its
        // subject can't be opened for inspection.
        let (s, st) = subject(&app, &jcookie, "family/kids").await;
        assert_eq!(s, 200, "{st}");
        let inh = st["inherited_members"].as_array().unwrap();
        assert_eq!(inh.len(), 1, "{st}");
        assert_eq!(inh[0]["inherited_from"]["can_inspect"], false, "{st}");

        let (_, st) = subject(&app, &cookie, "family/kids").await;
        assert_eq!(
            st["inherited_members"][0]["inherited_from"]["can_inspect"], true,
            "{st}"
        );
    }

    #[tokio::test]
    async fn inherited_links_only_surface_when_manageable() {
        let mount = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(mount.path().join("family/kids")).unwrap();
        let (_dir, app) = test_app(mount.path());
        let (cookie, csrf) = admin(&app).await;
        let (mcookie, _mcsrf, sam) = member(&app, &cookie, &csrf, "sam").await;
        add_member(&app, &cookie, &csrf, "family/kids", &sam, "view").await;

        // A link wider than the member's own access must not hand them its
        // address; a view link they cover is fine.
        let wide = make_link(
            &app,
            &cookie,
            &csrf,
            r#"{"kind":"folder","drive_id":"photos","path":"family","caps":"full"}"#,
        )
        .await;
        assert!(wide["url"].is_string());

        let (s, st) = subject(&app, &mcookie, "family/kids").await;
        assert_eq!(s, 200, "{st}");
        assert!(st["inherited_links"].as_array().unwrap().is_empty(), "{st}");

        let (_, st) = subject(&app, &cookie, "family/kids").await;
        let inh = st["inherited_links"].as_array().unwrap();
        assert_eq!(inh.len(), 1, "{st}");
        assert_eq!(inh[0]["inherited_from"]["path"], "family");
        assert_eq!(inh[0]["can_manage"], true);
        assert!(inh[0]["url"].is_string());
    }

    #[tokio::test]
    async fn link_patch_distinguishes_absent_from_null() {
        let mount = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(mount.path().join("family")).unwrap();
        let (_dir, app) = test_app(mount.path());
        let (cookie, csrf) = admin(&app).await;
        let link = make_link(
            &app,
            &cookie,
            &csrf,
            r#"{"kind":"folder","drive_id":"photos","path":"family","caps":"view","password":"s3cret-passw0rd","expires_in_days":7}"#,
        )
        .await;
        let id = link["id"].as_str().unwrap();

        // Empty patch keeps password and expiry.
        let res = call(
            &app,
            json_req(
                Method::PATCH,
                &format!("/api/v1/access/links/{id}"),
                "{}",
                Some(&cookie),
                Some(&csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), 200);
        let body = body_json(res).await;
        assert_eq!(body["has_password"], true, "{body}");
        assert!(body["expires_at"].is_number(), "{body}");

        // Explicit null clears both.
        let res = call(
            &app,
            json_req(
                Method::PATCH,
                &format!("/api/v1/access/links/{id}"),
                r#"{"password":null,"expires_in_days":null}"#,
                Some(&cookie),
                Some(&csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), 200);
        let body = body_json(res).await;
        assert_eq!(body["has_password"], false, "{body}");
        assert!(body["expires_at"].is_null(), "{body}");
    }

    #[tokio::test]
    async fn password_change_revokes_proof_cookies() {
        let mount = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(mount.path().join("family")).unwrap();
        let (_dir, app) = test_app(mount.path());
        let (cookie, csrf) = admin(&app).await;
        let link = make_link(
            &app,
            &cookie,
            &csrf,
            r#"{"kind":"folder","drive_id":"photos","path":"family","caps":"view","password":"0ld-passw0rd-ok"}"#,
        )
        .await;
        let id = link["id"].as_str().unwrap().to_string();
        let token = link["token"].as_str().unwrap().to_string();

        // First password check mints a proof cookie; the cookie alone then works.
        let (s, cookies, _) = public_req(
            &app,
            &format!("/s/{token}?meta=1"),
            Some("0ld-passw0rd-ok"),
            None,
        )
        .await;
        assert_eq!(s, 200);
        let proof = cookies
            .iter()
            .find(|c| c.starts_with(&format!("luna_link_{id}=")))
            .cloned()
            .expect("proof cookie");
        let (s, _, _) = public_req(&app, &format!("/s/{token}?meta=1"), None, Some(&proof)).await;
        assert_eq!(s, 200);

        // Rotating the password kills the outstanding proof.
        let res = call(
            &app,
            json_req(
                Method::PATCH,
                &format!("/api/v1/access/links/{id}"),
                r#"{"password":"new-passw0rd-2"}"#,
                Some(&cookie),
                Some(&csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), 200);
        let (s, _, _) = public_req(&app, &format!("/s/{token}?meta=1"), None, Some(&proof)).await;
        assert_eq!(s, 401);
        let (s, cookies, _) = public_req(
            &app,
            &format!("/s/{token}?meta=1"),
            Some("new-passw0rd-2"),
            None,
        )
        .await;
        assert_eq!(s, 200);
        let proof2 = cookies
            .iter()
            .find(|c| c.starts_with(&format!("luna_link_{id}=")))
            .cloned()
            .expect("new proof cookie");
        let (s, _, _) = public_req(&app, &format!("/s/{token}?meta=1"), None, Some(&proof2)).await;
        assert_eq!(s, 200);

        // A removed link rejects everything, proof or not.
        let res = call(
            &app,
            json_req(
                Method::DELETE,
                &format!("/api/v1/access/links/{id}"),
                "",
                Some(&cookie),
                Some(&csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), 200);
        let (s, _, _) = public_req(&app, &format!("/s/{token}?meta=1"), None, Some(&proof2)).await;
        assert_eq!(s, 404);
        let (s, _, _) = public_req(
            &app,
            &format!("/s/{token}?meta=1"),
            Some("new-passw0rd-2"),
            None,
        )
        .await;
        assert_eq!(s, 404);
    }

    // -------------------------------------------------------------------
    // Guest diagram locks + share lifecycle (rename/move/trash/restore)
    // -------------------------------------------------------------------

    /// Stand the app up on a real socket — a WebSocket upgrade only exists
    /// on a live connection (hyper fills `OnUpgrade`), so the lock route
    /// can't be driven through `oneshot`.
    async fn spawn_app(app: axum::Router) -> std::net::SocketAddr {
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .await
            .unwrap();
        });
        addr
    }

    struct WsReply {
        status: u16,
        head: String,
        stream: tokio::net::TcpStream,
        buf: Vec<u8>,
    }

    /// Write a bare-bones upgrade request over TCP and read the response
    /// head — enough HTTP to reach the route, no client library needed.
    async fn ws_connect(
        addr: std::net::SocketAddr,
        path: &str,
        extra_headers: &[(&str, &str)],
    ) -> WsReply {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
        let mut req = format!(
            "GET {path} HTTP/1.1\r\nHost: luna\r\nConnection: upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
        );
        for (k, v) in extra_headers {
            req.push_str(&format!("{k}: {v}\r\n"));
        }
        req.push_str("\r\n");
        stream.write_all(req.as_bytes()).await.unwrap();
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            let n =
                tokio::time::timeout(std::time::Duration::from_secs(5), stream.read(&mut chunk))
                    .await
                    .expect("ws response timed out")
                    .unwrap();
            assert!(n > 0, "connection closed before a response");
            buf.extend_from_slice(&chunk[..n]);
            if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                break;
            }
        }
        let split = buf.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
        let head = String::from_utf8_lossy(&buf[..split]).to_string();
        let status: u16 = head
            .split_whitespace()
            .nth(1)
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        let rest = buf.split_off(split + 4);
        WsReply {
            status,
            head,
            stream,
            buf: rest,
        }
    }

    /// Read one unmasked server→client text frame (the lock messages stay
    /// under 126 bytes, so the short length form is the only one used).
    async fn ws_next_text(reply: &mut WsReply) -> Option<serde_json::Value> {
        use tokio::io::AsyncReadExt;
        loop {
            if reply.buf.len() >= 2 {
                let len = (reply.buf[1] & 0x7f) as usize;
                if reply.buf.len() >= 2 + len {
                    let payload = reply.buf[2..2 + len].to_vec();
                    reply.buf.drain(..2 + len);
                    return serde_json::from_slice(&payload).ok();
                }
            }
            let mut chunk = [0u8; 4096];
            let n = tokio::time::timeout(
                std::time::Duration::from_secs(5),
                reply.stream.read(&mut chunk),
            )
            .await
            .ok()?
            .ok()?;
            if n == 0 {
                return None;
            }
            reply.buf.extend_from_slice(&chunk[..n]);
        }
    }

    /// `luna_link_{id}=<proof>` out of a response head's Set-Cookie line.
    fn proof_from_head(head: &str, id: &str) -> Option<String> {
        let want = format!("luna_link_{id}=");
        head.lines().find_map(|line| {
            line.strip_prefix("set-cookie: ")
                .or_else(|| line.strip_prefix("Set-Cookie: "))
                .and_then(|v| v.split(';').next())
                .filter(|c| c.starts_with(&want))
                .map(str::to_string)
        })
    }

    #[tokio::test]
    async fn guest_lock_ws_upgrades_and_reports_holds_over_a_socket() {
        let mount = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(mount.path().join("docs")).unwrap();
        std::fs::write(mount.path().join("docs/plan.drawio"), "<mxfile/>").unwrap();
        let (_dir, app) = test_app(mount.path());
        let (cookie, csrf) = admin(&app).await;
        let link = make_link(
            &app,
            &cookie,
            &csrf,
            r#"{"kind":"file","drive_id":"photos","path":"docs/plan.drawio","caps":"full"}"#,
        )
        .await;
        let token = link["token"].as_str().unwrap().to_string();
        let addr = spawn_app(app).await;

        let mut first = ws_connect(
            addr,
            &format!("/s/{token}/diagrams/lock/ws?session=s1"),
            &[],
        )
        .await;
        assert_eq!(first.status, 101, "{}", first.head);
        let msg = ws_next_text(&mut first).await.unwrap();
        assert_eq!(msg["type"], "held", "{msg}");

        // A second guest session on the same link learns who holds it.
        let mut second = ws_connect(
            addr,
            &format!("/s/{token}/diagrams/lock/ws?session=s2"),
            &[],
        )
        .await;
        assert_eq!(second.status, 101, "{}", second.head);
        let msg = ws_next_text(&mut second).await.unwrap();
        assert_eq!(msg["type"], "locked", "{msg}");
        assert_eq!(msg["holder"], "A guest");
        assert_eq!(msg["self"], false);
    }

    #[tokio::test]
    async fn guest_lock_ws_rejects_view_only_links_and_bad_targets() {
        let mount = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(mount.path().join("family")).unwrap();
        std::fs::write(mount.path().join("family/plan.drawio"), "<mxfile/>").unwrap();
        std::fs::write(mount.path().join("family/note.txt"), "hi").unwrap();
        let (_dir, app) = test_app(mount.path());
        let (cookie, csrf) = admin(&app).await;
        let view = make_link(
            &app,
            &cookie,
            &csrf,
            r#"{"kind":"folder","drive_id":"photos","path":"family","caps":"view"}"#,
        )
        .await;
        let view_token = view["token"].as_str().unwrap().to_string();
        let full = make_link(
            &app,
            &cookie,
            &csrf,
            r#"{"kind":"folder","drive_id":"photos","path":"family","caps":"full"}"#,
        )
        .await;
        let token = full["token"].as_str().unwrap().to_string();
        let addr = spawn_app(app).await;
        let ws =
            |token: &str, path: &str| format!("/s/{token}/diagrams/lock/ws?path={path}&session=s1");

        // A view link can open the diagram read-only but never holds a lock.
        let res = ws_connect(addr, &ws(&view_token, "plan.drawio"), &[]).await;
        assert_eq!(res.status, 403, "{}", res.head);
        // Escapes, non-diagrams, and missing files are refused pre-upgrade.
        let res = ws_connect(addr, &ws(&token, "../plan.drawio"), &[]).await;
        assert_eq!(res.status, 400, "{}", res.head);
        let res = ws_connect(addr, &ws(&token, "note.txt"), &[]).await;
        assert_eq!(res.status, 400, "{}", res.head);
        let res = ws_connect(addr, &ws(&token, "missing.drawio"), &[]).await;
        assert_eq!(res.status, 404, "{}", res.head);
        // A real in-scope diagram upgrades.
        let mut res = ws_connect(addr, &ws(&token, "plan.drawio"), &[]).await;
        assert_eq!(res.status, 101, "{}", res.head);
        assert_eq!(ws_next_text(&mut res).await.unwrap()["type"], "held");
        // Unknown tokens never reach the handler.
        let res = ws_connect(addr, &ws("nope", "plan.drawio"), &[]).await;
        assert_eq!(res.status, 404, "{}", res.head);
    }

    #[tokio::test]
    async fn guest_lock_ws_authenticates_password_links_by_header_or_proof() {
        let mount = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(mount.path().join("docs")).unwrap();
        std::fs::write(mount.path().join("docs/plan.drawio"), "<mxfile/>").unwrap();
        let (_dir, app) = test_app(mount.path());
        let (cookie, csrf) = admin(&app).await;
        let link = make_link(
            &app,
            &cookie,
            &csrf,
            r#"{"kind":"file","drive_id":"photos","path":"docs/plan.drawio","caps":"full","password":"s3cret-passw0rd"}"#,
        )
        .await;
        let id = link["id"].as_str().unwrap().to_string();
        let token = link["token"].as_str().unwrap().to_string();
        let addr = spawn_app(app).await;
        let ws = |session: &str| format!("/s/{token}/diagrams/lock/ws?session={session}");

        // No credentials at all → password challenge, not an upgrade.
        let res = ws_connect(addr, &ws("s1"), &[]).await;
        assert_eq!(res.status, 401, "{}", res.head);

        // The password header upgrades and mints the proof cookie — which is
        // what a real browser relies on, since WebSocket requests can't set
        // custom headers.
        let res = ws_connect(addr, &ws("s1"), &[("x-share-password", "s3cret-passw0rd")]).await;
        assert_eq!(res.status, 101, "{}", res.head);
        let proof = proof_from_head(&res.head, &id).expect("proof cookie");
        drop(res); // releases the s1 hold

        let mut res = ws_connect(addr, &ws("s2"), &[("cookie", proof.as_str())]).await;
        assert_eq!(res.status, 101, "{}", res.head);
        assert_eq!(ws_next_text(&mut res).await.unwrap()["type"], "held");
    }

    fn public_json_req(
        method: Method,
        uri: &str,
        body: &str,
        session: Option<&str>,
    ) -> HttpReq<Body> {
        let mut builder = HttpReq::builder()
            .method(method)
            .uri(uri)
            .header("content-type", "application/json")
            .header("accept", "application/json");
        if let Some(s) = session {
            builder = builder.header("x-diagram-session", s);
        }
        let mut http = builder.body(Body::from(body.to_string())).unwrap();
        http.extensions_mut().insert(ConnectInfo(CLIENT));
        http
    }

    fn put_chunk(uri: &str, bytes: &[u8]) -> HttpReq<Body> {
        let mut http = HttpReq::builder()
            .method(Method::PUT)
            .uri(uri)
            .header(
                "content-range",
                format!("bytes 0-{}/{}", bytes.len() - 1, bytes.len()),
            )
            .body(Body::from(bytes.to_vec()))
            .unwrap();
        http.extensions_mut().insert(ConnectInfo(CLIENT));
        http
    }

    /// Run one guest upload session for `name` inside the folder link and
    /// complete it, returning the complete-call response.
    async fn guest_upload_save(
        app: &axum::Router,
        token: &str,
        name: &str,
        session: Option<&str>,
    ) -> axum::response::Response {
        let res = call(
            app,
            public_json_req(
                Method::POST,
                &format!("/s/{token}/upload"),
                &format!(r#"{{"name":"{name}","size":4}}"#),
                None,
            ),
        )
        .await;
        assert_eq!(res.status(), 200);
        let up = body_json(res).await;
        let upload_id = up["upload_id"].as_str().unwrap().to_string();
        let res = call(
            app,
            put_chunk(&format!("/s/{token}/upload/{upload_id}"), b"data"),
        )
        .await;
        assert_eq!(res.status(), 200);
        call(
            app,
            public_json_req(
                Method::POST,
                &format!("/s/{token}/upload/{upload_id}/complete?overwrite=1"),
                "",
                session,
            ),
        )
        .await
    }

    #[tokio::test]
    async fn guest_diagram_save_conflicts_with_a_foreign_lock_session() {
        let mount = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(mount.path().join("family")).unwrap();
        std::fs::write(mount.path().join("family/plan.drawio"), "<mxfile/>").unwrap();
        let (_dir, app, state) = test_app_state(mount.path());
        let (cookie, csrf) = admin(&app).await;
        let link = make_link(
            &app,
            &cookie,
            &csrf,
            r#"{"kind":"folder","drive_id":"photos","path":"family","caps":"full"}"#,
        )
        .await;
        let token = link["token"].as_str().unwrap().to_string();
        // A member editor holds the lock — every guest session is foreign.
        state.diagram_locks.acquire_for_test(
            "photos",
            "family/plan.drawio",
            "u-member",
            "s1",
            "Max",
        );
        let res = guest_upload_save(&app, &token, "plan.drawio", Some("sess-b")).await;
        assert_eq!(res.status(), StatusCode::CONFLICT);
        let body = body_json(res).await;
        assert_eq!(body["code"], "diagram_locked");
        assert_eq!(body["holder"], "Max");
        // The create path enforces the same rule.
        let res = call(
            &app,
            public_json_req(
                Method::POST,
                &format!("/s/{token}/create"),
                r#"{"path":"plan.drawio"}"#,
                Some("sess-b"),
            ),
        )
        .await;
        assert_eq!(res.status(), StatusCode::CONFLICT);
        let body = body_json(res).await;
        assert_eq!(body["code"], "diagram_locked");
    }

    #[tokio::test]
    async fn guest_diagram_save_lands_for_the_lock_holder() {
        let mount = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(mount.path().join("family")).unwrap();
        std::fs::write(mount.path().join("family/plan.drawio"), "<mxfile/>").unwrap();
        let (_dir, app, state) = test_app_state(mount.path());
        let (cookie, csrf) = admin(&app).await;
        let link = make_link(
            &app,
            &cookie,
            &csrf,
            r#"{"kind":"folder","drive_id":"photos","path":"family","caps":"full"}"#,
        )
        .await;
        let id = link["id"].as_str().unwrap().to_string();
        let token = link["token"].as_str().unwrap().to_string();
        // The guest's own editing session holds the lock.
        state.diagram_locks.acquire_for_test(
            "photos",
            "family/plan.drawio",
            &crate::api::diagram_locks::guest_lock_key(&id, "sess-a"),
            "sess-a",
            "A guest",
        );
        // A save claiming another session is refused like any foreign save;
        // the upload session stays usable for the real holder's retry.
        let res = guest_upload_save(&app, &token, "plan.drawio", None).await;
        assert_eq!(res.status(), StatusCode::CONFLICT);
        let res = guest_upload_save(&app, &token, "plan.drawio", Some("sess-a")).await;
        assert_eq!(res.status(), 200);
        assert_eq!(
            std::fs::read(mount.path().join("family/plan.drawio")).unwrap(),
            b"data"
        );
    }

    #[tokio::test]
    async fn rename_retargets_member_and_link_rows() {
        let mount = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(mount.path().join("family/kids")).unwrap();
        let (_dir, app, state) = test_app_state(mount.path());
        let (cookie, csrf) = admin(&app).await;
        let (_mcookie, _mcsrf, sam) = member(&app, &cookie, &csrf, "sam").await;
        add_member(&app, &cookie, &csrf, "family", &sam, "view").await;
        let link = make_link(
            &app,
            &cookie,
            &csrf,
            r#"{"kind":"folder","drive_id":"photos","path":"family/kids","caps":"view"}"#,
        )
        .await;
        let token = link["token"].as_str().unwrap().to_string();
        let res = call(
            &app,
            json_req(
                Method::POST,
                "/api/v1/drives/photos/files/rename",
                r#"{"path":"family","new_name":"kin"}"#,
                Some(&cookie),
                Some(&csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), 200);
        // The link kept working at the new path.
        let (status, body) = public_get(&app, &format!("/s/{token}?meta=1")).await;
        assert_eq!(status, 200, "{body}");
        assert_eq!(body["kind"], "folder");
        assert_eq!(body["name"], "kids");
        // And the member grant moved with the folder.
        let conn = state.db.lock().unwrap();
        let rows = crate::db::list_access_members_for_user(&conn, &sam).unwrap();
        assert!(
            rows.iter()
                .any(|r| r.drive_id == "photos" && r.path == "kin"),
            "{rows:?}"
        );
    }

    /// Poll a job until it leaves "running" (or time out).
    async fn wait_job(app: &axum::Router, cookie: &str, id: &str) -> serde_json::Value {
        for _ in 0..100 {
            let res = call(
                app,
                json_req(
                    Method::GET,
                    &format!("/api/v1/jobs/{id}"),
                    "",
                    Some(cookie),
                    None,
                ),
            )
            .await;
            let job = body_json(res).await;
            if job["state"].as_str() != Some("running") {
                return job;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        panic!("job {id} did not finish");
    }

    async fn enqueue_move(
        app: &axum::Router,
        cookie: &str,
        csrf: &str,
        from_drive: &str,
        from_path: &str,
        to_drive: &str,
        to_path: &str,
    ) -> serde_json::Value {
        let res = call(
            app,
            json_req(
                Method::POST,
                "/api/v1/jobs",
                &format!(
                    r#"{{"kind":"move","from_drive":"{from_drive}","from_path":"{from_path}","to_drive":"{to_drive}","to_path":"{to_path}"}}"#
                ),
                Some(cookie),
                Some(csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), 200);
        let job = body_json(res).await;
        let done = wait_job(app, cookie, job["id"].as_str().unwrap()).await;
        assert_eq!(done["state"], "done", "{done}");
        done
    }

    #[tokio::test]
    async fn move_retargets_share_rows() {
        let mount = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(mount.path().join("family")).unwrap();
        std::fs::create_dir_all(mount.path().join("archive")).unwrap();
        let (_dir, app, state) = test_app_state(mount.path());
        let (cookie, csrf) = admin(&app).await;
        let link = make_link(
            &app,
            &cookie,
            &csrf,
            r#"{"kind":"folder","drive_id":"photos","path":"family","caps":"view"}"#,
        )
        .await;
        let token = link["token"].as_str().unwrap().to_string();
        enqueue_move(
            &app, &cookie, &csrf, "photos", "family", "photos", "archive",
        )
        .await;
        let (status, body) = public_get(&app, &format!("/s/{token}?meta=1")).await;
        assert_eq!(status, 200, "{body}");
        assert_eq!(body["kind"], "folder");
        let conn = state.db.lock().unwrap();
        let link_row = crate::db::get_access_link(&conn, link["id"].as_str().unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(link_row.path, "archive/family");
    }

    #[tokio::test]
    async fn cross_drive_move_retargets_share_rows() {
        let mount = tempfile::tempdir().unwrap();
        let mount_b = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(mount.path().join("family")).unwrap();
        let (_dir, app, state) = test_app_state(mount.path());
        // A second adopted drive — same filesystem, so the job still renames
        // but the rows must follow it to the other drive id.
        let prefix = luna_core::marker::pick_prefix(mount_b.path()).unwrap();
        crate::drives::drive_db::create(
            mount_b.path(),
            &luna_core::marker::Marker::new("backup", "Backup"),
            &prefix,
        )
        .unwrap();
        {
            let conn = state.db.lock().unwrap();
            crate::db::upsert_drive(
                &conn,
                "backup",
                "Backup",
                "as_is",
                "ext4",
                "sdb",
                mount_b.path().to_str().unwrap(),
            )
            .unwrap();
        }
        let (cookie, csrf) = admin(&app).await;
        let link = make_link(
            &app,
            &cookie,
            &csrf,
            r#"{"kind":"folder","drive_id":"photos","path":"family","caps":"view"}"#,
        )
        .await;
        let token = link["token"].as_str().unwrap().to_string();
        enqueue_move(&app, &cookie, &csrf, "photos", "family", "backup", "").await;
        let (status, body) = public_get(&app, &format!("/s/{token}?meta=1")).await;
        assert_eq!(status, 200, "{body}");
        assert_eq!(body["kind"], "folder");
        let conn = state.db.lock().unwrap();
        let link_row = crate::db::get_access_link(&conn, link["id"].as_str().unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(
            (link_row.drive_id.as_str(), link_row.path.as_str()),
            ("backup", "family")
        );
    }

    #[tokio::test]
    async fn rename_form_file_keeps_respond_link() {
        let mount = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(mount.path().join("docs")).unwrap();
        std::fs::write(
            mount.path().join("docs/rsvp.lunaform"),
            r#"{"version":1,"title":"RSVP","questions":[]}"#,
        )
        .unwrap();
        let (_dir, app) = test_app(mount.path());
        let (cookie, csrf) = admin(&app).await;
        let link = make_link(
            &app,
            &cookie,
            &csrf,
            r#"{"kind":"file","drive_id":"photos","path":"docs/rsvp.lunaform","caps":"respond"}"#,
        )
        .await;
        let token = link["token"].as_str().unwrap().to_string();
        let res = call(
            &app,
            json_req(
                Method::POST,
                "/api/v1/drives/photos/files/rename",
                r#"{"path":"docs/rsvp.lunaform","new_name":"party.lunaform"}"#,
                Some(&cookie),
                Some(&csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), 200);
        let (status, body) = public_get(&app, &format!("/s/{token}?meta=1")).await;
        assert_eq!(status, 200, "{body}");
        assert_eq!(body["kind"], "form");
    }

    #[tokio::test]
    async fn trash_revokes_the_file_link_and_restore_does_not_revive_it() {
        let mount = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(mount.path().join("family")).unwrap();
        std::fs::write(mount.path().join("family/note.txt"), "hi").unwrap();
        let (_dir, app) = test_app(mount.path());
        let (cookie, csrf) = admin(&app).await;
        let file_link = make_link(
            &app,
            &cookie,
            &csrf,
            r#"{"kind":"file","drive_id":"photos","path":"family/note.txt","caps":"view"}"#,
        )
        .await;
        let file_token = file_link["token"].as_str().unwrap().to_string();
        let folder_link = make_link(
            &app,
            &cookie,
            &csrf,
            r#"{"kind":"folder","drive_id":"photos","path":"family","caps":"view"}"#,
        )
        .await;
        let folder_token = folder_link["token"].as_str().unwrap().to_string();

        let res = call(
            &app,
            json_req(
                Method::DELETE,
                "/api/v1/drives/photos/files?path=family/note.txt",
                "",
                Some(&cookie),
                Some(&csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), 200);
        let body = body_json(res).await;
        let trash_path = body["trash_path"].as_str().unwrap().to_string();

        // The trashed file's link is dead; the parent's is untouched.
        let (status, _) = public_get(&app, &format!("/s/{file_token}?meta=1")).await;
        assert_eq!(status, 404);
        let (status, body) = public_get(&app, &format!("/s/{folder_token}?meta=1")).await;
        assert_eq!(status, 200, "{body}");

        // Restoring the file must not resurrect its grants.
        let res = call(
            &app,
            json_req(
                Method::POST,
                "/api/v1/drives/photos/files/restore",
                &format!(r#"{{"path":"{trash_path}","dest":"family/note.txt"}}"#),
                Some(&cookie),
                Some(&csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), 200);
        let (status, _) = public_get(&app, &format!("/s/{file_token}?meta=1")).await;
        assert_eq!(status, 404);
    }
}

use std::path::PathBuf;

use axum::extract::{DefaultBodyLimit, Extension, Multipart, Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post, put};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::AppState;
use crate::api::response::json_error;
use crate::gallery::{self, ListFilter};

const THUMB_CACHE_CONTROL: &str = "private, no-store";

#[derive(Deserialize)]
struct GalleryQuery {
    #[serde(default)]
    drive_id: Option<String>,
    limit: Option<u32>,
    offset: Option<u32>,
    #[serde(default)]
    q: Option<String>,
    from: Option<i64>,
    to: Option<i64>,
    #[serde(default)]
    favorites: Option<bool>,
    #[serde(default)]
    album_id: Option<String>,
    #[serde(default)]
    album_home: Option<String>,
    #[serde(default)]
    place: Option<String>,
}

#[derive(Deserialize)]
struct ThumbQuery {
    drive_id: String,
    path: String,
}

#[derive(Deserialize, Default)]
struct ScanBody {
    #[serde(default)]
    drive_id: Option<String>,
}

#[derive(Deserialize)]
struct FavoriteBody {
    drive_id: String,
    path: String,
}

#[derive(Deserialize)]
struct CreateAlbumBody {
    name: String,
    #[serde(default)]
    home_drive_id: Option<String>,
}

#[derive(Deserialize)]
struct PatchAlbumBody {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    shared: Option<bool>,
    #[serde(default)]
    allow_uploads: Option<bool>,
}

#[derive(Deserialize)]
struct AlbumItemsBody {
    items: Vec<AlbumItemRef>,
}

#[derive(Deserialize)]
struct AlbumItemRef {
    drive_id: String,
    path: String,
}

#[derive(Deserialize)]
struct MemberBody {
    user_id: String,
    #[serde(default = "contributor_role")]
    role: String,
}

fn contributor_role() -> String {
    "contributor".into()
}

#[derive(Deserialize)]
struct InviteBody {
    #[serde(default = "viewer_role")]
    role: String,
    expires_in_days: Option<i64>,
}

fn viewer_role() -> String {
    "viewer".into()
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/gallery", get(timeline))
        .route("/api/v1/gallery/places", get(places))
        .route("/api/v1/gallery/thumb", get(thumb))
        .route("/api/v1/gallery/scan", post(scan))
        .route(
            "/api/v1/gallery/favorites",
            put(put_favorite).delete(delete_favorite),
        )
        .route(
            "/api/v1/gallery/albums",
            get(list_albums).post(create_album),
        )
        .route(
            "/api/v1/gallery/albums/{home}/{id}",
            get(get_album).patch(patch_album).delete(delete_album),
        )
        .route(
            "/api/v1/gallery/albums/{home}/{id}/items",
            post(add_items).delete(remove_item),
        )
        .route(
            "/api/v1/gallery/albums/{home}/{id}/members",
            get(list_members).put(put_member),
        )
        .route(
            "/api/v1/gallery/albums/{home}/{id}/members/{user_id}",
            delete(delete_member),
        )
        .route(
            "/api/v1/gallery/albums/{home}/{id}/invites",
            post(create_invite),
        )
        .route(
            "/api/v1/gallery/albums/{home}/{id}/invites/{invite_id}",
            delete(delete_invite),
        )
        .route("/api/v1/public/albums/{token}", get(public_album))
        .route(
            "/api/v1/public/albums/{token}/thumb",
            get(public_thumb),
        )
        .route(
            "/api/v1/public/albums/{token}/upload",
            post(public_upload).layer(DefaultBodyLimit::max(64 * 1024 * 1024)),
        )
}

fn accessible_mounts(
    state: &AppState,
    user: &crate::auth::CurrentUser,
    only: Option<&str>,
) -> Result<Vec<(String, PathBuf)>, (StatusCode, Json<Value>)> {
    let conn = state.db.lock().map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna's index is busy. Try again.",
        )
    })?;
    let drives = crate::db::list_drives(&conn).map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't list your drives.",
        )
    })?;
    let mut out = Vec::new();
    for drive in drives {
        if let Some(id) = only
            && drive.id != id
        {
            continue;
        }
        if drive.state != "as_is" || drive.mount_point.is_empty() {
            continue;
        }
        if !crate::auth::has_drive_access(user, &conn, &drive.id) {
            continue;
        }
        out.push((drive.id, PathBuf::from(drive.mount_point)));
    }
    Ok(out)
}

fn all_mounted(state: &AppState) -> Result<Vec<(String, PathBuf)>, (StatusCode, Json<Value>)> {
    let conn = state.db.lock().map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna's index is busy. Try again.",
        )
    })?;
    let drives = crate::db::list_drives(&conn).map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't list your drives.",
        )
    })?;
    Ok(drives
        .into_iter()
        .filter(|d| d.state == "as_is" && !d.mount_point.is_empty())
        .map(|d| (d.id, PathBuf::from(d.mount_point)))
        .collect())
}

fn resolve_mount(
    state: &AppState,
    drive_id: &str,
) -> Result<PathBuf, (StatusCode, Json<Value>)> {
    let conn = state.db.lock().map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna's index is busy. Try again.",
        )
    })?;
    let drive = crate::db::get_drive(&conn, drive_id)
        .map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't open this drive.",
            )
        })?
        .ok_or_else(|| json_error(StatusCode::NOT_FOUND, "Luna doesn't know that drive."))?;
    if drive.mount_point.is_empty() {
        return Err(json_error(
            StatusCode::NOT_FOUND,
            "This drive isn't mounted.",
        ));
    }
    Ok(PathBuf::from(drive.mount_point))
}

async fn timeline(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Query(query): Query<GalleryQuery>,
) -> Result<Json<gallery::GalleryPage>, (StatusCode, Json<Value>)> {
    if let Some(drive_id) = query.drive_id.as_deref() {
        let conn = state.db.lock().map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna's index is busy. Try again.",
            )
        })?;
        if !crate::auth::has_drive_access(&user, &conn, drive_id) {
            return Err(json_error(
                StatusCode::FORBIDDEN,
                "You don't have permission to view this drive.",
            ));
        }
    }
    let mounts = accessible_mounts(&state, &user, None)?;
    let limit = query.limit.unwrap_or(80).clamp(1, 500);
    let offset = query.offset.unwrap_or(0);
    let filter = ListFilter {
        q: query.q.filter(|s| !s.trim().is_empty()),
        from: query.from,
        to: query.to,
        favorites_user: if query.favorites.unwrap_or(false) {
            Some(user.id.clone())
        } else {
            None
        },
        album_id: query.album_id,
        album_home_drive: query.album_home,
        place: query.place,
        user_id: Some(user.id.clone()),
    };
    let page = gallery::list_photos(
        &mounts,
        query.drive_id.as_deref(),
        &filter,
        limit,
        offset,
    )
    .map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't open the gallery.",
        )
    })?;
    let conn = state.db.lock().map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna's index is busy. Try again.",
        )
    })?;
    let items = page
        .items
        .into_iter()
        .filter(|photo| crate::auth::can_access(&user, &conn, &photo.drive_id, &photo.path, false))
        .collect::<Vec<_>>();
    Ok(Json(gallery::GalleryPage {
        has_more: page.has_more,
        next_offset: page.next_offset,
        items,
    }))
}

async fn places(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
) -> Result<Json<Vec<gallery::PlaceCluster>>, (StatusCode, Json<Value>)> {
    let mounts = accessible_mounts(&state, &user, None)?;
    let places = gallery::list_places(&mounts).map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't open Places.",
        )
    })?;
    Ok(Json(places))
}

async fn scan(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Json(body): Json<ScanBody>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let mounts = accessible_mounts(&state, &user, body.drive_id.as_deref())?;
    tokio::task::spawn_blocking(move || {
        for (id, mount) in mounts {
            let _ = gallery::scan_drive(&id, &mount);
        }
    });
    Ok(Json(
        json!({ "started": true, "message": "Luna is building your photo gallery in the background." }),
    ))
}

async fn thumb(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Query(query): Query<ThumbQuery>,
) -> Result<Response, (StatusCode, Json<Value>)> {
    {
        let conn = state.db.lock().map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna's index is busy. Try again.",
            )
        })?;
        if !crate::auth::can_access(&user, &conn, &query.drive_id, &query.path, false) {
            return Err(json_error(
                StatusCode::FORBIDDEN,
                "You don't have permission to view this.",
            ));
        }
    }
    let root = resolve_mount(&state, &query.drive_id)?;
    let thumb_path = gallery::thumb_path(&root, &query.drive_id, &query.path);
    if !thumb_path.exists() {
        let (drive_id, path) = (query.drive_id.clone(), query.path.clone());
        let root2 = root.clone();
        tokio::task::spawn_blocking(move || -> Result<(), ()> {
            let src = luna_core::path::resolve_child(&root2, &path).map_err(|_| ())?;
            let dest = gallery::thumb_path(&root2, &drive_id, &path);
            let kind = if gallery::is_video(&src) {
                "video"
            } else {
                "image"
            };
            gallery::ensure_thumb(&src, &dest, kind).map_err(|_| ())?;
            Ok(())
        })
        .await
        .map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't build the thumbnail.",
            )
        })?
        .map_err(|_| {
            json_error(
                StatusCode::NOT_FOUND,
                "Luna couldn't make a thumbnail for this photo.",
            )
        })?;
    }
    serve_thumb(thumb_path).await
}

async fn serve_thumb(path: PathBuf) -> Result<Response, (StatusCode, Json<Value>)> {
    let file = tokio::fs::File::open(&path)
        .await
        .map_err(|_| json_error(StatusCode::NOT_FOUND, "This thumbnail isn't ready yet."))?;
    let meta = std::fs::metadata(&path)
        .map_err(|_| json_error(StatusCode::NOT_FOUND, "This thumbnail isn't ready yet."))?;
    let stream = tokio_util::io::ReaderStream::new(file);
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(axum::http::header::CONTENT_TYPE, "image/jpeg")
        .header(axum::http::header::CONTENT_LENGTH, meta.len().to_string())
        .header(axum::http::header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(axum::http::header::CACHE_CONTROL, THUMB_CACHE_CONTROL)
        .body(axum::body::Body::from_stream(stream))
        .unwrap()
        .into_response())
}

async fn put_favorite(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Json(body): Json<FavoriteBody>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    {
        let conn = state.db.lock().map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna's index is busy. Try again.",
            )
        })?;
        if !crate::auth::can_access(&user, &conn, &body.drive_id, &body.path, false) {
            return Err(json_error(
                StatusCode::FORBIDDEN,
                "You don't have permission to favorite this.",
            ));
        }
    }
    let root = resolve_mount(&state, &body.drive_id)?;
    gallery::set_favorite(&root, &user.id, &body.path, true).map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't save that favorite.",
        )
    })?;
    Ok(Json(json!({ "ok": true })))
}

async fn delete_favorite(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Json(body): Json<FavoriteBody>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let root = resolve_mount(&state, &body.drive_id)?;
    gallery::set_favorite(&root, &user.id, &body.path, false).map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't remove that favorite.",
        )
    })?;
    Ok(Json(json!({ "ok": true })))
}

async fn list_albums(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
) -> Result<Json<Vec<gallery::Album>>, (StatusCode, Json<Value>)> {
    let mounts = accessible_mounts(&state, &user, None)?;
    let albums = gallery::list_albums(&mounts, &user.id).map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't list albums.",
        )
    })?;
    Ok(Json(albums))
}

async fn create_album(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Json(body): Json<CreateAlbumBody>,
) -> Result<Json<gallery::Album>, (StatusCode, Json<Value>)> {
    let name = body.name.trim();
    if name.is_empty() {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "Give this album a name.",
        ));
    }
    let mounts = accessible_mounts(&state, &user, None)?;
    let (drive_id, root) = if let Some(id) = body.home_drive_id.as_deref() {
        mounts
            .into_iter()
            .find(|(d, _)| d == id)
            .ok_or_else(|| {
                json_error(
                    StatusCode::FORBIDDEN,
                    "You don't have a writable drive for this album.",
                )
            })?
    } else {
        mounts.into_iter().next().ok_or_else(|| {
            json_error(
                StatusCode::BAD_REQUEST,
                "Plug in a drive before creating an album.",
            )
        })?
    };
    let album = gallery::create_album(&root, &drive_id, &user.id, name).map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't create that album.",
        )
    })?;
    let _ = std::fs::create_dir_all(root.join(&album.contrib_path));
    Ok(Json(album))
}

async fn get_album(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Path((home, id)): Path<(String, String)>,
) -> Result<Json<gallery::Album>, (StatusCode, Json<Value>)> {
    let root = resolve_mount(&state, &home)?;
    let album = gallery::get_album(&root, &home, &id)
        .map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't open that album.",
            )
        })?
        .ok_or_else(|| json_error(StatusCode::NOT_FOUND, "Luna doesn't know that album."))?;
    if !gallery::user_can_access_album(&root, &album, &user.id).unwrap_or(false) {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "You don't have permission to view this album.",
        ));
    }
    Ok(Json(album))
}

async fn patch_album(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Path((home, id)): Path<(String, String)>,
    Json(body): Json<PatchAlbumBody>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let root = resolve_mount(&state, &home)?;
    let album = gallery::get_album(&root, &home, &id)
        .map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't open that album.",
            )
        })?
        .ok_or_else(|| json_error(StatusCode::NOT_FOUND, "Luna doesn't know that album."))?;
    if album.owner_user_id != user.id {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Only the album owner can change these settings.",
        ));
    }
    gallery::update_album(
        &root,
        &id,
        body.name.as_deref().map(str::trim).filter(|s| !s.is_empty()),
        body.shared,
        body.allow_uploads,
    )
    .map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't update that album.",
        )
    })?;
    Ok(Json(json!({ "ok": true })))
}

async fn delete_album(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Path((home, id)): Path<(String, String)>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let root = resolve_mount(&state, &home)?;
    let album = gallery::get_album(&root, &home, &id)
        .map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't open that album.",
            )
        })?
        .ok_or_else(|| json_error(StatusCode::NOT_FOUND, "Luna doesn't know that album."))?;
    if album.owner_user_id != user.id {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Only the album owner can delete this album.",
        ));
    }
    gallery::delete_album(&root, &id).map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't delete that album.",
        )
    })?;
    Ok(Json(json!({ "ok": true })))
}

async fn add_items(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Path((home, id)): Path<(String, String)>,
    Json(body): Json<AlbumItemsBody>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let root = resolve_mount(&state, &home)?;
    let album = gallery::get_album(&root, &home, &id)
        .map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't open that album.",
            )
        })?
        .ok_or_else(|| json_error(StatusCode::NOT_FOUND, "Luna doesn't know that album."))?;
    if !gallery::user_can_access_album(&root, &album, &user.id).unwrap_or(false) {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "You don't have permission to change this album.",
        ));
    }
    let items: Vec<(String, String)> = body
        .items
        .into_iter()
        .map(|i| (i.drive_id, i.path))
        .collect();
    gallery::add_album_items(&root, &id, &items).map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't add those photos to the album.",
        )
    })?;
    Ok(Json(json!({ "ok": true })))
}

async fn remove_item(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Path((home, id)): Path<(String, String)>,
    Json(body): Json<AlbumItemRef>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let root = resolve_mount(&state, &home)?;
    let album = gallery::get_album(&root, &home, &id)
        .map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't open that album.",
            )
        })?
        .ok_or_else(|| json_error(StatusCode::NOT_FOUND, "Luna doesn't know that album."))?;
    if album.owner_user_id != user.id
        && !gallery::user_can_contribute(&root, &album, &user.id).unwrap_or(false)
    {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "You don't have permission to change this album.",
        ));
    }
    gallery::remove_album_item(&root, &id, &body.drive_id, &body.path).map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't remove that photo from the album.",
        )
    })?;
    Ok(Json(json!({ "ok": true })))
}

async fn list_members(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Path((home, id)): Path<(String, String)>,
) -> Result<Json<Vec<gallery::AlbumMember>>, (StatusCode, Json<Value>)> {
    let root = resolve_mount(&state, &home)?;
    let album = gallery::get_album(&root, &home, &id)
        .map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't open that album.",
            )
        })?
        .ok_or_else(|| json_error(StatusCode::NOT_FOUND, "Luna doesn't know that album."))?;
    if !gallery::user_can_access_album(&root, &album, &user.id).unwrap_or(false) {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "You don't have permission to view this album.",
        ));
    }
    let members = gallery::list_members(&root, &id).map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't list album members.",
        )
    })?;
    Ok(Json(members))
}

async fn put_member(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Path((home, id)): Path<(String, String)>,
    Json(body): Json<MemberBody>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let root = resolve_mount(&state, &home)?;
    let album = gallery::get_album(&root, &home, &id)
        .map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't open that album.",
            )
        })?
        .ok_or_else(|| json_error(StatusCode::NOT_FOUND, "Luna doesn't know that album."))?;
    if album.owner_user_id != user.id {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Only the album owner can invite people.",
        ));
    }
    let role = if body.role == "contributor" {
        "contributor"
    } else {
        "viewer"
    };
    gallery::upsert_member(&root, &id, &body.user_id, role).map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't update album members.",
        )
    })?;
    Ok(Json(json!({ "ok": true })))
}

async fn delete_member(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Path((home, id, user_id)): Path<(String, String, String)>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let root = resolve_mount(&state, &home)?;
    let album = gallery::get_album(&root, &home, &id)
        .map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't open that album.",
            )
        })?
        .ok_or_else(|| json_error(StatusCode::NOT_FOUND, "Luna doesn't know that album."))?;
    if album.owner_user_id != user.id && user.id != user_id {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Only the album owner can remove members.",
        ));
    }
    gallery::remove_member(&root, &id, &user_id).map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't remove that member.",
        )
    })?;
    Ok(Json(json!({ "ok": true })))
}

async fn create_invite(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Path((home, id)): Path<(String, String)>,
    Json(body): Json<InviteBody>,
) -> Result<Json<gallery::AlbumInvite>, (StatusCode, Json<Value>)> {
    let root = resolve_mount(&state, &home)?;
    let album = gallery::get_album(&root, &home, &id)
        .map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't open that album.",
            )
        })?
        .ok_or_else(|| json_error(StatusCode::NOT_FOUND, "Luna doesn't know that album."))?;
    if album.owner_user_id != user.id {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Only the album owner can create invite links.",
        ));
    }
    let role = if body.role == "contributor" {
        "contributor"
    } else {
        "viewer"
    };
    let expires = body.expires_in_days.map(|d| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|t| t.as_secs() as i64 + d * 86400)
            .unwrap_or(0)
    });
    // Mark album shared when creating an invite.
    let _ = gallery::update_album(&root, &id, None, Some(true), None);
    let invite = gallery::create_invite(&root, &id, role, expires, None).map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't create that invite link.",
        )
    })?;
    Ok(Json(invite))
}

async fn delete_invite(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Path((home, id, invite_id)): Path<(String, String, String)>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let root = resolve_mount(&state, &home)?;
    let album = gallery::get_album(&root, &home, &id)
        .map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't open that album.",
            )
        })?
        .ok_or_else(|| json_error(StatusCode::NOT_FOUND, "Luna doesn't know that album."))?;
    if album.owner_user_id != user.id {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Only the album owner can remove invite links.",
        ));
    }
    gallery::delete_invite(&root, &invite_id).map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't remove that invite link.",
        )
    })?;
    Ok(Json(json!({ "ok": true })))
}

async fn public_album(
    State(state): State<AppState>,
    Path(token): Path<String>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let mounts = all_mounted(&state)?;
    let found = gallery::find_invite(&mounts, &token).map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't open that shared album.",
        )
    })?;
    let Some((home, root, invite, album)) = found else {
        return Err(json_error(
            StatusCode::NOT_FOUND,
            "This shared album link is not valid or has expired.",
        ));
    };
    let filter = ListFilter {
        album_id: Some(album.id.clone()),
        album_home_drive: Some(home.clone()),
        ..Default::default()
    };
    let page = gallery::list_photos(&mounts, None, &filter, 200, 0).map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't load photos for this album.",
        )
    })?;
    let can_upload = album.allow_uploads && invite.role == "contributor";
    // Rewrite thumbs to public URLs so guests can load previews without signing in.
    let items: Vec<Value> = page
        .items
        .into_iter()
        .map(|mut p| {
            if !p.thumb.is_empty() {
                p.thumb = format!(
                    "/api/v1/public/albums/{token}/thumb?drive_id={}&path={}",
                    p.drive_id,
                    urlencoding_lite(&p.path)
                );
            }
            json!(p)
        })
        .collect();
    Ok(Json(json!({
        "album": album,
        "home_drive_id": home,
        "invite_role": invite.role,
        "can_upload": can_upload,
        "contrib_path": album.contrib_path,
        "items": items,
        "mount_exists": root.exists(),
    })))
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

#[derive(Deserialize)]
struct PublicThumbQuery {
    drive_id: String,
    path: String,
}

async fn public_thumb(
    State(state): State<AppState>,
    Path(token): Path<String>,
    Query(query): Query<PublicThumbQuery>,
) -> Result<Response, (StatusCode, Json<Value>)> {
    let mounts = all_mounted(&state)?;
    let found = gallery::find_invite(&mounts, &token).map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't open that shared album.",
        )
    })?;
    let Some((home, root, _invite, album)) = found else {
        return Err(json_error(
            StatusCode::NOT_FOUND,
            "This shared album link is not valid or has expired.",
        ));
    };
    // Allow thumbs for items in the album, or files under the contrib folder.
    let in_album = {
        let conn = gallery::open_drive_db(&root).map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't open that album.",
            )
        })?;
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM album_items WHERE album_id = ?1 AND drive_id = ?2 AND path = ?3",
                rusqlite::params![album.id, query.drive_id, query.path],
                |row| row.get(0),
            )
            .unwrap_or(0);
        n > 0
    };
    let under_contrib = query.drive_id == home
        && (query.path == album.contrib_path
            || query.path.starts_with(&format!("{}/", album.contrib_path)));
    if !in_album && !under_contrib {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "That photo is not part of this shared album.",
        ));
    }
    let mount = resolve_mount(&state, &query.drive_id)?;
    let thumb_path = gallery::thumb_path(&mount, &query.drive_id, &query.path);
    if !thumb_path.exists() {
        let drive_id = query.drive_id.clone();
        let path = query.path.clone();
        let mount2 = mount.clone();
        let _ = tokio::task::spawn_blocking(move || {
            let src = luna_core::path::resolve_child(&mount2, &path).ok()?;
            let dest = gallery::thumb_path(&mount2, &drive_id, &path);
            let kind = if gallery::is_video(&src) {
                "video"
            } else {
                "image"
            };
            gallery::ensure_thumb(&src, &dest, kind).ok()
        })
        .await;
    }
    serve_thumb(thumb_path).await
}

async fn public_upload(
    State(state): State<AppState>,
    Path(token): Path<String>,
    mut multipart: Multipart,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let mounts = all_mounted(&state)?;
    let found = gallery::find_invite(&mounts, &token).map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't open that shared album.",
        )
    })?;
    let Some((home, root, invite, album)) = found else {
        return Err(json_error(
            StatusCode::NOT_FOUND,
            "This shared album link is not valid or has expired.",
        ));
    };
    if !(album.allow_uploads && invite.role == "contributor") {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "This shared album does not allow uploads.",
        ));
    }
    let contrib = root.join(&album.contrib_path);
    std::fs::create_dir_all(&contrib).map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't prepare the upload folder.",
        )
    })?;
    let mut saved = Vec::new();
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|_| json_error(StatusCode::BAD_REQUEST, "Could not read the upload."))?
    {
        let name = field
            .file_name()
            .map(|s| s.to_string())
            .unwrap_or_else(|| "photo.jpg".into());
        let safe: String = name
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ' '))
            .take(120)
            .collect();
        let safe = if safe.is_empty() {
            "photo.jpg".into()
        } else {
            safe
        };
        let bytes = field.bytes().await.map_err(|_| {
            json_error(
                StatusCode::BAD_REQUEST,
                "Could not read the uploaded file.",
            )
        })?;
        let dest_rel = format!("{}/{}", album.contrib_path, safe);
        let dest = root.join(&dest_rel);
        if let Some(parent) = dest.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        tokio::fs::write(&dest, &bytes).await.map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't save the upload.",
            )
        })?;
        if let Ok(Some(photo)) = gallery::index_one(&home, &root, &dest_rel) {
            let _ = gallery::add_album_items(
                &root,
                &album.id,
                &[(home.clone(), dest_rel.clone())],
            );
            saved.push(photo);
        }
    }
    if saved.is_empty() {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "No photos or videos were uploaded. Try again with a picture or video file.",
        ));
    }
    Ok(Json(json!({ "ok": true, "items": saved })))
}

#[cfg(test)]
mod tests {
    use super::THUMB_CACHE_CONTROL;
    #[test]
    fn thumbs_are_private() {
        assert_eq!(THUMB_CACHE_CONTROL, "private, no-store");
        assert!(!THUMB_CACHE_CONTROL.contains("public"));
    }
}

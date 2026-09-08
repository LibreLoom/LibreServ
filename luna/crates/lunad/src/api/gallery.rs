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

type ApiError = (StatusCode, Json<Value>);
type DriveMounts = Vec<(String, PathBuf)>;

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
    archived: Option<bool>,
    #[serde(default)]
    album_id: Option<String>,
    #[serde(default)]
    album_home: Option<String>,
    #[serde(default)]
    place: Option<String>,
    /// Comma-separated west,south,east,north bounds for map cluster selection.
    #[serde(default)]
    place_bbox: Option<String>,
}

fn parse_place_bbox(raw: &str) -> Option<[f64; 4]> {
    let parts: Vec<f64> = raw
        .split(',')
        .filter_map(|s| s.trim().parse().ok())
        .collect();
    if parts.len() != 4 {
        return None;
    }
    Some([parts[0], parts[1], parts[2], parts[3]])
}

#[derive(Deserialize)]
struct ThumbQuery {
    drive_id: String,
    path: String,
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
    #[serde(default)]
    allow_uploads: Option<bool>,
}

fn viewer_role() -> String {
    "viewer".into()
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/gallery", get(timeline))
        .route("/api/v1/gallery/places", get(places))
        .route("/api/v1/gallery/thumb", get(thumb))
        .route("/api/v1/gallery/status", get(status))
        .route("/api/v1/gallery/rescan", post(rescan))
        .route(
            "/api/v1/gallery/favorites",
            put(put_favorite).delete(delete_favorite),
        )
        .route(
            "/api/v1/gallery/archive",
            put(put_archive).delete(delete_archive),
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
            get(list_invites).post(create_invite),
        )
        .route(
            "/api/v1/gallery/albums/{home}/{id}/invites/{invite_id}",
            delete(delete_invite),
        )
        .route("/api/v1/public/albums/{token}", get(public_album))
        .route("/api/v1/public/albums/{token}/thumb", get(public_thumb))
        .route(
            "/api/v1/public/albums/{token}/upload",
            post(public_upload).layer(DefaultBodyLimit::max(64 * 1024 * 1024)),
        )
}

fn accessible_mounts(
    state: &AppState,
    user: &crate::auth::CurrentUser,
    only: Option<&str>,
) -> Result<DriveMounts, ApiError> {
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

fn writable_mounts(
    state: &AppState,
    user: &crate::auth::CurrentUser,
    only: Option<&str>,
) -> Result<DriveMounts, ApiError> {
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
        if !crate::auth::has_write_on_drive(user, &conn, &drive.id) {
            continue;
        }
        out.push((drive.id, PathBuf::from(drive.mount_point)));
    }
    Ok(out)
}

fn all_mounted(state: &AppState) -> Result<DriveMounts, ApiError> {
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

fn resolve_mount(state: &AppState, drive_id: &str) -> Result<PathBuf, (StatusCode, Json<Value>)> {
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
    let mut offset = query.offset.unwrap_or(0);
    let viewing_album = query.album_id.is_some();
    let archived = query.archived.unwrap_or(false);
    let filter = ListFilter {
        q: query.q.filter(|s| !s.trim().is_empty()),
        from: query.from,
        to: query.to,
        favorites_user: if query.favorites.unwrap_or(false) {
            Some(user.id.clone())
        } else {
            None
        },
        album_id: query.album_id.clone(),
        album_home_drive: query.album_home.clone(),
        place: query.place,
        place_bbox: query.place_bbox.as_deref().and_then(parse_place_bbox),
        user_id: Some(user.id.clone()),
        archived_user: if archived {
            Some(user.id.clone())
        } else {
            None
        },
        // Library and favorites hide archived; album view still shows album items.
        exclude_archived_user: if !archived && !viewing_album {
            Some(user.id.clone())
        } else {
            None
        },
    };

    // Keep fetching until we fill `limit` ACL-visible items or run out of pages.
    let mut items = Vec::new();
    let mut has_more = false;
    let mut next_offset = offset;
    let mut cur = offset;
    for _ in 0..5 {
        let page = gallery::list_photos(
            &mounts,
            query.drive_id.as_deref(),
            &filter,
            limit,
            cur,
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
        items.extend(page.items.into_iter().filter(|photo| {
            crate::auth::can_access(&user, &conn, &photo.drive_id, &photo.path, false)
        }));
        drop(conn);
        next_offset = page.next_offset;
        has_more = page.has_more;
        if items.len() as u32 >= limit || !page.has_more {
            break;
        }
        cur = page.next_offset;
    }
    if items.len() as u32 > limit {
        items.truncate(limit as usize);
        has_more = true;
    }
    Ok(Json(gallery::GalleryPage {
        has_more,
        next_offset,
        items,
    }))
}

async fn places(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
) -> Result<Json<Vec<gallery::PlaceMarker>>, (StatusCode, Json<Value>)> {
    let mounts = accessible_mounts(&state, &user, None)?;
    let markers = gallery::list_place_markers(&mounts).map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't open Places.",
        )
    })?;
    let conn = state.db.lock().map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna's index is busy. Try again.",
        )
    })?;
    let markers = markers
        .into_iter()
        .filter(|m| {
            // marker.id is "{drive_id}:{path}"
            let Some((drive_id, path)) = m.id.split_once(':') else {
                return false;
            };
            crate::auth::can_access(&user, &conn, drive_id, path, false)
        })
        .collect::<Vec<_>>();
    Ok(Json(markers))
}

async fn status(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
) -> Json<Value> {
    let st = state.gallery.status();
    let mut drive_label: Option<String> = None;
    let mut drive_id = st.drive_id.clone();
    if let Ok(conn) = state.db.lock()
        && let Some(id) = drive_id.as_deref()
        && let Ok(Some(row)) = crate::db::get_drive(&conn, id)
    {
        // Only expose a drive the caller can see.
        if crate::auth::has_drive_access(&user, &conn, id) {
            drive_label = Some(row.label);
        } else {
            drive_id = None;
        }
    }
    Json(json!({
        "scanning": st.scanning,
        "pending": st.pending,
        "busy": st.busy,
        "phase": st.phase,
        "drive_id": drive_id,
        "drive_label": drive_label,
        "found_count": st.found_count,
        "last_error": st.last_error,
    }))
}

/// Enqueue a catch-up gallery scan for every drive the caller can access.
/// Used by Photos → Look again and by `seed-mock-drives.sh` after refreshing fixtures.
async fn rescan(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
) -> Result<Json<Value>, ApiError> {
    let mounts = accessible_mounts(&state, &user, None)?;
    if mounts.is_empty() {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "No drives are ready to look through. Add a drive on the Drives page first.",
        ));
    }
    let mut queued = 0usize;
    for (id, mount) in mounts {
        // Ensure the indexer knows this mount (idempotent re-arm) then rescan.
        state.gallery.watch_mount(&id, mount);
        queued += 1;
    }
    Ok(Json(json!({
        "ok": true,
        "queued": queued,
        "busy": true,
    })))
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
                "Luna couldn't make a thumbnail for this file.",
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

async fn put_archive(
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
                "You don't have permission to archive this.",
            ));
        }
    }
    let root = resolve_mount(&state, &body.drive_id)?;
    gallery::set_archived(&root, &user.id, &body.path, true).map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't archive that photo.",
        )
    })?;
    Ok(Json(json!({ "ok": true })))
}

async fn delete_archive(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Json(body): Json<FavoriteBody>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let root = resolve_mount(&state, &body.drive_id)?;
    gallery::set_archived(&root, &user.id, &body.path, false).map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't unarchive that photo.",
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
    let mounts = writable_mounts(&state, &user, None)?;
    if mounts.is_empty() {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "You need write access on a drive before creating an album.",
        ));
    }
    let (drive_id, root) = if let Some(id) = body.home_drive_id.as_deref() {
        mounts.into_iter().find(|(d, _)| d == id).ok_or_else(|| {
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
        body.name
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty()),
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
    let can_add = album.owner_user_id == user.id
        || gallery::user_can_contribute(&root, &album, &user.id).unwrap_or(false);
    if !can_add {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "You don't have permission to add photos to this album.",
        ));
    }
    let conn = state.db.lock().map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna's index is busy. Try again.",
        )
    })?;
    let mut allowed = Vec::new();
    let mut forbidden = 0usize;
    for item in body.items {
        if crate::auth::can_access(&user, &conn, &item.drive_id, &item.path, false) {
            allowed.push((item.drive_id, item.path));
        } else {
            forbidden += 1;
        }
    }
    drop(conn);
    if allowed.is_empty() {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "None of those photos can be added — you don't have permission to view them.",
        ));
    }
    gallery::add_album_items(&root, &id, &allowed).map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't add those photos to the album.",
        )
    })?;
    Ok(Json(json!({
        "ok": true,
        "added": allowed.len(),
        "skipped_forbidden": forbidden,
    })))
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

async fn list_invites(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Path((home, id)): Path<(String, String)>,
) -> Result<Json<Vec<gallery::AlbumInvite>>, (StatusCode, Json<Value>)> {
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
            "You don't have permission to view this album's invite links.",
        ));
    }
    let invites = gallery::list_invites(&root, &id).map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't list invite links.",
        )
    })?;
    Ok(Json(invites))
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
    let days = body.expires_in_days.unwrap_or(30).max(1);
    let expires = Some(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|t| t.as_secs() as i64 + days * 86400)
            .unwrap_or(0),
    );
    // Mark album shared when creating an invite. Only touch allow_uploads when
    // the client sends it — do not infer uploads from contributor role alone.
    let _ = gallery::update_album(&root, &id, None, Some(true), body.allow_uploads);
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
    let under_contrib = !album.contrib_path.is_empty()
        && query.drive_id == home
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
    let contrib_path = if album.contrib_path.trim().is_empty() {
        gallery::allocate_contrib_dir(&root, &album.id, &album.name).map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't prepare the upload folder.",
            )
        })?
    } else {
        album.contrib_path.clone()
    };
    let contrib = root.join(&contrib_path);
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
        if !gallery::is_media(std::path::Path::new(&safe)) {
            continue;
        }
        let bytes = field.bytes().await.map_err(|_| {
            json_error(StatusCode::BAD_REQUEST, "Could not read the uploaded file.")
        })?;
        let unique = format!("{}_{}", uuid::Uuid::new_v4(), safe);
        let dest_rel = format!("{}/{}", contrib_path, unique);
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
        match gallery::index_one(&home, &root, &dest_rel) {
            Ok(Some(photo)) => {
                let _ =
                    gallery::add_album_items(&root, &album.id, &[(home.clone(), dest_rel.clone())]);
                saved.push(photo);
            }
            _ => {
                let _ = std::fs::remove_file(&dest);
            }
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
    use crate::drives::DriveManager;
    use crate::mount::shared_mock;
    use crate::{AppState, db};
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    #[test]
    fn thumbs_are_private() {
        assert_eq!(THUMB_CACHE_CONTROL, "private, no-store");
        assert!(!THUMB_CACHE_CONTROL.contains("public"));
    }

    #[tokio::test]
    async fn status_includes_phase_and_compat_busy_fields() {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        let drive_manager = std::sync::Arc::new(DriveManager::new(shared_mock(), dir.path()));
        let state = AppState::new(conn, drive_manager, dir.path());
        let auth = state.auth.clone();
        let user = auth
            .register("Gale", "Gale", "hunter22hunter1", "admin")
            .unwrap();
        let token = auth.issue(&user).unwrap();
        let router = axum::Router::new()
            .merge(super::router())
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                crate::auth::guard,
            ))
            .with_state(state);
        let response = router
            .oneshot(
                Request::builder()
                    .uri("/api/v1/gallery/status")
                    .header("Authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert!(v["busy"].is_boolean());
        assert!(v["scanning"].is_boolean());
        assert!(v["pending"].is_number());
        assert_eq!(v["phase"], "idle");
        assert!(v.get("found_count").is_some());
        assert!(v.get("drive_id").is_some());
        assert!(v.get("drive_label").is_some());
        assert!(v.get("last_error").is_some());
    }

    #[tokio::test]
    async fn rescan_queues_accessible_mounts() {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        let mount = dir.path().join("photos-vol");
        std::fs::create_dir_all(&mount).unwrap();
        db::upsert_drive(
            &conn,
            "d-photos",
            "Family Photos",
            "as_is",
            "ext4",
            "sdz",
            mount.to_str().unwrap(),
        )
        .unwrap();
        let drive_manager = std::sync::Arc::new(DriveManager::new(shared_mock(), dir.path()));
        let state = AppState::new(conn, drive_manager, dir.path());
        let auth = state.auth.clone();
        let user = auth
            .register("Rescan", "Rescan", "hunter22hunter1", "admin")
            .unwrap();
        let token = auth.issue(&user).unwrap();
        let router = axum::Router::new()
            .merge(super::router())
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                crate::auth::guard,
            ))
            .with_state(state.clone());
        let response = router
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/gallery/rescan")
                    .header("Authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["ok"], true);
        assert_eq!(v["queued"], 1);
        assert!(state.gallery.is_watching("d-photos"));
        assert!(state.gallery.pending() || state.gallery.status().busy);
    }
}

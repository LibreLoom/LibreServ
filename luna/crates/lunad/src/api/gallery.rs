use std::path::{Path as FsPath, PathBuf};

use axum::body::Body;
use axum::extract::{DefaultBodyLimit, Extension, Multipart, Path, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post, put};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio_util::io::ReaderStream;

use crate::AppState;
use crate::api::response::json_error;
use crate::gallery::{self, ListFilter};

const THUMB_CACHE_CONTROL: &str = "private, max-age=3600, must-revalidate";
const PUBLIC_ALBUM_ZIP_MAX: usize = 500;
const GALLERY_DOWNLOAD_ZIP_MAX: usize = 200;

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
    /// Restrict to `"image"` or `"video"`.
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    camera_make: Option<String>,
    #[serde(default)]
    camera_model: Option<String>,
    #[serde(default)]
    lens: Option<String>,
    iso_min: Option<u32>,
    iso_max: Option<u32>,
    focal_min: Option<f64>,
    focal_max: Option<f64>,
    /// `0` = flash off, `1` = flash on.
    flash: Option<i64>,
    #[serde(default)]
    orientation: Option<String>,
    #[serde(default)]
    has_gps: Option<bool>,
    #[serde(default)]
    format: Option<String>,
    hour_from: Option<u32>,
    hour_to: Option<u32>,
    min_megapixels: Option<f64>,
    min_duration: Option<u32>,
    max_duration: Option<u32>,
    #[serde(default)]
    undated: Option<bool>,
    /// `"none"` | `"any"` — album membership on the same drive DB only.
    #[serde(default)]
    album_membership: Option<String>,
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
    #[serde(default)]
    locked: Option<bool>,
    /// Optional album cover path (relative to the cover drive).
    #[serde(default)]
    cover_path: Option<String>,
    /// Drive that holds `cover_path`. Defaults to the album home when omitted with cover_path.
    #[serde(default)]
    cover_drive_id: Option<String>,
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

#[derive(Deserialize)]
struct PublicAlbumQuery {
    limit: Option<u32>,
    offset: Option<u32>,
}

#[derive(Deserialize)]
struct GalleryDownloadBody {
    items: Vec<AlbumItemRef>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/gallery", get(timeline))
        .route("/api/v1/gallery/places", get(places))
        .route("/api/v1/gallery/cameras", get(cameras))
        .route("/api/v1/gallery/filter-facets", get(filter_facets))
        .route("/api/v1/gallery/duplicates", get(duplicates))
        .route("/api/v1/gallery/thumb", get(thumb))
        .route("/api/v1/gallery/preview", get(preview))
        .route("/api/v1/gallery/download", post(download_zip))
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
        .route("/api/v1/public/albums/{token}/content", get(public_content))
        .route(
            "/api/v1/public/albums/{token}/download",
            get(public_download),
        )
        .route("/api/v1/public/albums/{token}/zip", get(public_zip))
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
    let offset = query.offset.unwrap_or(0);
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
        kind: query
            .kind
            .as_deref()
            .map(str::trim)
            .filter(|s| *s == "image" || *s == "video")
            .map(str::to_string),
        camera_make: query.camera_make.filter(|s| !s.trim().is_empty()),
        camera_model: query.camera_model.filter(|s| !s.trim().is_empty()),
        lens: query.lens.filter(|s| !s.trim().is_empty()),
        iso_min: query.iso_min,
        iso_max: query.iso_max,
        focal_min: query.focal_min,
        focal_max: query.focal_max,
        flash: query.flash.filter(|v| *v == 0 || *v == 1),
        orientation: query
            .orientation
            .as_deref()
            .map(str::trim)
            .map(str::to_ascii_lowercase)
            .filter(|s| s == "landscape" || s == "portrait" || s == "square"),
        has_gps: query.has_gps,
        format: query.format.filter(|s| !s.trim().is_empty()),
        hour_from: query.hour_from.filter(|h| *h <= 23),
        hour_to: query.hour_to.filter(|h| *h <= 23),
        min_megapixels: query.min_megapixels.filter(|v| *v > 0.0),
        min_duration: query.min_duration,
        max_duration: query.max_duration,
        undated: query.undated,
        album_membership: query
            .album_membership
            .as_deref()
            .map(str::trim)
            .map(str::to_ascii_lowercase)
            .filter(|s| s == "none" || s == "any"),
    };

    // Keep fetching until we fill `limit` ACL-visible items or run out of pages.
    let mut items = Vec::new();
    let mut has_more = false;
    let mut next_offset = offset;
    let mut cur = offset;
    for _ in 0..5 {
        let page = gallery::list_photos(&mounts, query.drive_id.as_deref(), &filter, limit, cur)
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

async fn cameras(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let mounts = accessible_mounts(&state, &user, None)?;
    let cameras = gallery::list_cameras(&mounts).map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't list cameras.",
        )
    })?;
    Ok(Json(json!({ "cameras": cameras })))
}

async fn filter_facets(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
) -> Result<Json<gallery::FilterFacets>, (StatusCode, Json<Value>)> {
    let mounts = accessible_mounts(&state, &user, None)?;
    let facets = gallery::list_filter_facets(&mounts).map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't load photo filters.",
        )
    })?;
    Ok(Json(facets))
}

#[derive(Deserialize)]
struct DuplicatesQuery {
    limit: Option<u32>,
}

/// Possible duplicates: same file name + byte size across accessible drives.
async fn duplicates(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Query(query): Query<DuplicatesQuery>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let mounts = accessible_mounts(&state, &user, None)?;
    let limit = query.limit.unwrap_or(50).clamp(1, 200);
    let mut groups = gallery::list_duplicates(&mounts, limit).map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't look for duplicate photos.",
        )
    })?;
    // Drop items the user cannot access.
    let conn = state.db.lock().map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna's index is busy. Try again.",
        )
    })?;
    for group in &mut groups {
        group
            .items
            .retain(|p| crate::auth::can_access(&user, &conn, &p.drive_id, &p.path, false));
    }
    groups.retain(|g| g.items.len() > 1);
    Ok(Json(json!({ "groups": groups })))
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
    headers: axum::http::HeaderMap,
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
    if let Some(cached) = state.ram_cache.get_thumb(&query.drive_id, &query.path) {
        return serve_thumb_bytes(cached.bytes, cached.mtime_secs, cached.etag, &headers);
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
    serve_thumb_file(&state, &query.drive_id, &query.path, thumb_path, &headers).await
}

async fn serve_thumb_file(
    state: &AppState,
    drive_id: &str,
    rel: &str,
    path: PathBuf,
    headers: &axum::http::HeaderMap,
) -> Result<Response, (StatusCode, Json<Value>)> {
    let meta = std::fs::metadata(&path)
        .map_err(|_| json_error(StatusCode::NOT_FOUND, "This thumbnail isn't ready yet."))?;
    let mtime_secs = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let etag = crate::ram_cache::thumb_etag(meta.len(), mtime_secs);
    if let Some(if_none_match) = headers
        .get(axum::http::header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        && if_none_match.split(',').any(|c| c.trim() == etag)
    {
        return Ok(Response::builder()
            .status(StatusCode::NOT_MODIFIED)
            .header(axum::http::header::ETAG, etag)
            .header(axum::http::header::CACHE_CONTROL, THUMB_CACHE_CONTROL)
            .body(axum::body::Body::empty())
            .unwrap()
            .into_response());
    }
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|_| json_error(StatusCode::NOT_FOUND, "This thumbnail isn't ready yet."))?;
    state
        .ram_cache
        .put_thumb(drive_id, rel, bytes.clone(), mtime_secs);
    serve_thumb_bytes(
        std::sync::Arc::from(bytes.into_boxed_slice()),
        mtime_secs,
        etag,
        headers,
    )
}

fn serve_thumb_bytes(
    bytes: std::sync::Arc<[u8]>,
    _mtime_secs: u64,
    etag: String,
    headers: &axum::http::HeaderMap,
) -> Result<Response, (StatusCode, Json<Value>)> {
    if let Some(if_none_match) = headers
        .get(axum::http::header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        && if_none_match.split(',').any(|c| c.trim() == etag)
    {
        return Ok(Response::builder()
            .status(StatusCode::NOT_MODIFIED)
            .header(axum::http::header::ETAG, etag)
            .header(axum::http::header::CACHE_CONTROL, THUMB_CACHE_CONTROL)
            .body(axum::body::Body::empty())
            .unwrap()
            .into_response());
    }
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(axum::http::header::CONTENT_TYPE, "image/jpeg")
        .header(axum::http::header::CONTENT_LENGTH, bytes.len().to_string())
        .header(axum::http::header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(axum::http::header::CACHE_CONTROL, THUMB_CACHE_CONTROL)
        .header(axum::http::header::ETAG, etag)
        .body(axum::body::Body::from(bytes.to_vec()))
        .unwrap()
        .into_response())
}

async fn serve_thumb(path: PathBuf) -> Result<Response, (StatusCode, Json<Value>)> {
    // Public album thumbs still use the on-disk path; validators without RAM.
    let meta = std::fs::metadata(&path)
        .map_err(|_| json_error(StatusCode::NOT_FOUND, "This thumbnail isn't ready yet."))?;
    let mtime_secs = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let etag = crate::ram_cache::thumb_etag(meta.len(), mtime_secs);
    let file = tokio::fs::File::open(&path)
        .await
        .map_err(|_| json_error(StatusCode::NOT_FOUND, "This thumbnail isn't ready yet."))?;
    let stream = tokio_util::io::ReaderStream::new(file);
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(axum::http::header::CONTENT_TYPE, "image/jpeg")
        .header(axum::http::header::CONTENT_LENGTH, meta.len().to_string())
        .header(axum::http::header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(axum::http::header::CACHE_CONTROL, THUMB_CACHE_CONTROL)
        .header(axum::http::header::ETAG, etag)
        .body(axum::body::Body::from_stream(stream))
        .unwrap()
        .into_response())
}

/// Guest may see this file when it is in album_items or under the contrib folder.
fn album_item_allowed(
    home: &str,
    root: &FsPath,
    album: &gallery::Album,
    drive_id: &str,
    path: &str,
) -> bool {
    let in_album = {
        let Ok(conn) = gallery::open_drive_db(root) else {
            return false;
        };
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM album_items WHERE album_id = ?1 AND drive_id = ?2 AND path = ?3",
                rusqlite::params![album.id, drive_id, path],
                |row| row.get(0),
            )
            .unwrap_or(0);
        n > 0
    };
    let under_contrib = !album.contrib_path.is_empty()
        && drive_id == home
        && (path == album.contrib_path || path.starts_with(&format!("{}/", album.contrib_path)));
    in_album || under_contrib
}

fn public_media_urls(token: &str, drive_id: &str, path: &str) -> (String, String, String) {
    let enc = urlencoding_lite(path);
    let thumb = format!("/api/v1/public/albums/{token}/thumb?drive_id={drive_id}&path={enc}");
    let content = format!("/api/v1/public/albums/{token}/content?drive_id={drive_id}&path={enc}");
    let download = format!("/api/v1/public/albums/{token}/download?drive_id={drive_id}&path={enc}");
    (thumb, content, download)
}

fn resolve_public_invite(
    state: &AppState,
    token: &str,
) -> Result<(String, PathBuf, gallery::AlbumInvite, gallery::Album), ApiError> {
    let mounts = all_mounted(state)?;
    let found = gallery::find_invite(&mounts, token).map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't open that shared album.",
        )
    })?;
    found.ok_or_else(|| {
        json_error(
            StatusCode::NOT_FOUND,
            "This shared album link is not valid or has expired.",
        )
    })
}

/// Browser-safe media path: HEIC → JPEG preview; everything else → original.
async fn resolve_browser_safe_file(
    mount: &FsPath,
    drive_id: &str,
    rel: &str,
) -> Result<(PathBuf, String, String), ApiError> {
    let src = luna_core::path::resolve_child(mount, rel)
        .map_err(|_| json_error(StatusCode::NOT_FOUND, "Luna couldn't find that photo."))?;
    let original_name = src
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "photo".into());
    if gallery::is_heic_image(&src) {
        let thumb = gallery::thumb_path(mount, drive_id, rel);
        let mount2 = mount.to_path_buf();
        let rel2 = rel.to_string();
        let thumb2 = thumb.clone();
        let jpeg = tokio::task::spawn_blocking(move || {
            let src = luna_core::path::resolve_child(&mount2, &rel2).map_err(|_| ())?;
            gallery::ensure_heic_preview_jpeg(&src, &thumb2).map_err(|_| ())?;
            Ok::<PathBuf, ()>(thumb2)
        })
        .await
        .map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't prepare a preview for this photo.",
            )
        })?
        .map_err(|_| {
            json_error(
                StatusCode::NOT_FOUND,
                "Luna couldn't make a preview for this photo.",
            )
        })?;
        let preview_name = {
            let stem = FsPath::new(&original_name)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("photo");
            format!("{stem}.jpg")
        };
        return Ok((jpeg, "image/jpeg".into(), preview_name));
    }
    let mime = mime_guess::from_path(&original_name)
        .first_or_octet_stream()
        .essence_str()
        .to_string();
    Ok((src, mime, original_name))
}

async fn serve_media_path(
    abs: PathBuf,
    content_type: &str,
    filename: &str,
    disposition: &str,
    headers: &HeaderMap,
) -> Result<Response, ApiError> {
    let meta = std::fs::metadata(&abs)
        .map_err(|_| json_error(StatusCode::NOT_FOUND, "Luna couldn't find that photo."))?;
    if !meta.is_file() {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "Luna can only open photo and video files here.",
        ));
    }
    let total = meta.len();
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let etag = format!("\"{total:x}-{modified:x}\"");
    if let Some(if_none_match) = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        && if_none_match.split(',').any(|c| c.trim() == etag)
    {
        return Ok(Response::builder()
            .status(StatusCode::NOT_MODIFIED)
            .header(header::ETAG, etag)
            .body(Body::empty())
            .unwrap());
    }

    let mut file = tokio::fs::File::open(&abs).await.map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't open this file. Try again.",
        )
    })?;

    let (status, stream_len, content_range) =
        match headers.get(header::RANGE).and_then(|v| v.to_str().ok()) {
            Some(spec) => match parse_byte_range(spec, total) {
                Some((start, end)) => (
                    StatusCode::PARTIAL_CONTENT,
                    end - start + 1,
                    Some(format!("bytes {start}-{end}/{total}")),
                ),
                None => {
                    return Err(json_error(
                        StatusCode::RANGE_NOT_SATISFIABLE,
                        "Luna couldn't understand that download range.",
                    ));
                }
            },
            None => (StatusCode::OK, total, None),
        };

    if status == StatusCode::PARTIAL_CONTENT {
        let start = content_range
            .as_deref()
            .and_then(|r| {
                r.strip_prefix("bytes ")
                    .and_then(|s| s.split('-').next())
                    .and_then(|s| s.parse().ok())
            })
            .unwrap_or(0);
        file.seek(std::io::SeekFrom::Start(start))
            .await
            .map_err(|_| {
                json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Luna couldn't read this file. Try again.",
                )
            })?;
    }

    let stream = ReaderStream::new(file.take(stream_len));
    let mut builder = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CONTENT_LENGTH, stream_len.to_string())
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::ETAG, etag)
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::CACHE_CONTROL, "private, no-store")
        .header(
            header::CONTENT_DISPOSITION,
            format!(
                "{disposition}; filename=\"{}\"",
                crate::files::content_disposition_filename(filename)
            ),
        );
    if let Some(range) = content_range {
        builder = builder.header(header::CONTENT_RANGE, range);
    }
    Ok(builder.body(Body::from_stream(stream)).unwrap())
}

fn parse_byte_range(spec: &str, total: u64) -> Option<(u64, u64)> {
    let spec = spec.trim();
    let rest = spec.strip_prefix("bytes=")?;
    let (start_s, end_s) = rest.split_once('-')?;
    if start_s.is_empty() {
        let suffix: u64 = end_s.parse().ok()?;
        if suffix == 0 || total == 0 {
            return None;
        }
        let start = total.saturating_sub(suffix);
        return Some((start, total - 1));
    }
    let start: u64 = start_s.parse().ok()?;
    if start >= total {
        return None;
    }
    let end = if end_s.is_empty() {
        total - 1
    } else {
        end_s.parse::<u64>().ok()?.min(total - 1)
    };
    if end < start {
        return None;
    }
    Some((start, end))
}

struct ZipBody {
    stream: ReaderStream<tokio::fs::File>,
    _keep: tempfile::NamedTempFile,
}

impl futures_util::Stream for ZipBody {
    type Item = Result<bytes::Bytes, std::io::Error>;

    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        std::pin::Pin::new(&mut self.stream).poll_next(cx)
    }
}

async fn stream_zip_response(
    zip_name: &str,
    build: impl FnOnce(&std::path::Path) -> Result<(), ApiError> + Send + 'static,
) -> Result<Response, ApiError> {
    let tmp = tempfile::NamedTempFile::new().map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't prepare that download. Try again.",
        )
    })?;
    let tmp_path = tmp.path().to_path_buf();
    let build_path = tmp_path.clone();
    tokio::task::spawn_blocking(move || build(&build_path))
        .await
        .map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't prepare that download. Try again.",
            )
        })??;

    let async_file = tokio::fs::File::open(&tmp_path).await.map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't prepare that download. Try again.",
        )
    })?;
    let len = async_file.metadata().await.map(|m| m.len()).unwrap_or(0);
    let stream = ReaderStream::new(async_file);
    let body = Body::from_stream(ZipBody { stream, _keep: tmp });
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/zip")
        .header(header::CONTENT_LENGTH, len.to_string())
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::CACHE_CONTROL, "private, no-store")
        .header(
            header::CONTENT_DISPOSITION,
            format!(
                "attachment; filename=\"{}\"",
                crate::files::content_disposition_filename(zip_name)
            ),
        )
        .body(body)
        .unwrap())
}

fn zip_entry_name(drive_id: &str, path: &str) -> String {
    let clean = path.trim().replace('\\', "/").trim_matches('/').to_string();
    format!("{drive_id}/{clean}")
}

async fn preview(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Query(query): Query<ThumbQuery>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
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
    let (abs, content_type, filename) =
        resolve_browser_safe_file(&root, &query.drive_id, &query.path).await?;
    serve_media_path(abs, &content_type, &filename, "inline", &headers).await
}

async fn download_zip(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Json(body): Json<GalleryDownloadBody>,
) -> Result<Response, ApiError> {
    if body.items.is_empty() {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "Choose at least one photo to download.",
        ));
    }
    if body.items.len() > GALLERY_DOWNLOAD_ZIP_MAX {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            format!(
                "You can download up to {GALLERY_DOWNLOAD_ZIP_MAX} photos at once. Select fewer and try again."
            ),
        ));
    }
    {
        let conn = state.db.lock().map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna's index is busy. Try again.",
            )
        })?;
        for item in &body.items {
            if !crate::auth::can_access(&user, &conn, &item.drive_id, &item.path, false) {
                return Err(json_error(
                    StatusCode::FORBIDDEN,
                    "You don't have permission to download one of these photos.",
                ));
            }
        }
    }

    let mut entries: Vec<(String, PathBuf)> = Vec::with_capacity(body.items.len());
    for item in &body.items {
        let root = resolve_mount(&state, &item.drive_id)?;
        let abs = luna_core::path::resolve_child(&root, &item.path).map_err(|_| {
            json_error(
                StatusCode::NOT_FOUND,
                "Luna couldn't find one of those photos.",
            )
        })?;
        if !abs.is_file() {
            continue;
        }
        entries.push((zip_entry_name(&item.drive_id, &item.path), abs));
    }
    if entries.is_empty() {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "None of those photos could be downloaded.",
        ));
    }

    stream_zip_response("photos.zip", move |tmp_path| {
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
        gallery::write_items_zip(&entries, &mut file, GALLERY_DOWNLOAD_ZIP_MAX).map_err(|e| {
            let msg = e.to_string();
            if msg.contains("too many files") {
                json_error(
                    StatusCode::BAD_REQUEST,
                    format!(
                        "You can download up to {GALLERY_DOWNLOAD_ZIP_MAX} photos at once. Select fewer and try again."
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
    let cover = match (
        body.cover_path
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty()),
        body.cover_drive_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty()),
    ) {
        (Some(path), Some(drive)) => Some((drive.to_string(), path.to_string())),
        (Some(path), None) => Some((home.clone(), path.to_string())),
        (None, None) => None,
        (None, Some(_)) => {
            return Err(json_error(
                StatusCode::BAD_REQUEST,
                "Pick a photo path when setting the album cover.",
            ));
        }
    };
    gallery::update_album(
        &root,
        &id,
        body.name
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty()),
        body.shared,
        body.allow_uploads,
        body.locked,
        cover,
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
    let _ = gallery::update_album(&root, &id, None, Some(true), body.allow_uploads, None, None);
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
    Query(query): Query<PublicAlbumQuery>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let mounts = all_mounted(&state)?;
    let (home, root, invite, album) = resolve_public_invite(&state, &token)?;
    let limit = query.limit.unwrap_or(80).clamp(1, 200);
    let offset = query.offset.unwrap_or(0);
    let filter = ListFilter {
        album_id: Some(album.id.clone()),
        album_home_drive: Some(home.clone()),
        ..Default::default()
    };
    let page = gallery::list_photos(&mounts, None, &filter, limit, offset).map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't load photos for this album.",
        )
    })?;
    let can_upload = album.allow_uploads && invite.role == "contributor";
    let items: Vec<Value> = page
        .items
        .into_iter()
        .map(|mut p| {
            let (thumb, content, download) = public_media_urls(&token, &p.drive_id, &p.path);
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
        "album": album,
        "home_drive_id": home,
        "invite_role": invite.role,
        "can_upload": can_upload,
        "contrib_path": album.contrib_path,
        "items": items,
        "has_more": page.has_more,
        "next_offset": page.next_offset,
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
    let (home, root, _invite, album) = resolve_public_invite(&state, &token)?;
    if !album_item_allowed(&home, &root, &album, &query.drive_id, &query.path) {
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

async fn public_content(
    State(state): State<AppState>,
    Path(token): Path<String>,
    Query(query): Query<PublicThumbQuery>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let (home, root, _invite, album) = resolve_public_invite(&state, &token)?;
    if !album_item_allowed(&home, &root, &album, &query.drive_id, &query.path) {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "That photo is not part of this shared album.",
        ));
    }
    let mount = resolve_mount(&state, &query.drive_id)?;
    let (abs, content_type, filename) =
        resolve_browser_safe_file(&mount, &query.drive_id, &query.path).await?;
    serve_media_path(abs, &content_type, &filename, "inline", &headers).await
}

async fn public_download(
    State(state): State<AppState>,
    Path(token): Path<String>,
    Query(query): Query<PublicThumbQuery>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let (home, root, _invite, album) = resolve_public_invite(&state, &token)?;
    if !album_item_allowed(&home, &root, &album, &query.drive_id, &query.path) {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "That photo is not part of this shared album.",
        ));
    }
    let mount = resolve_mount(&state, &query.drive_id)?;
    let abs = luna_core::path::resolve_child(&mount, &query.path)
        .map_err(|_| json_error(StatusCode::NOT_FOUND, "Luna couldn't find that photo."))?;
    let name = abs
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "download".into());
    let mime = mime_guess::from_path(&name)
        .first_or_octet_stream()
        .essence_str()
        .to_string();
    serve_media_path(abs, &mime, &name, "attachment", &headers).await
}

async fn public_zip(
    State(state): State<AppState>,
    Path(token): Path<String>,
) -> Result<Response, ApiError> {
    let (home, root, _invite, album) = resolve_public_invite(&state, &token)?;
    let refs = gallery::list_album_item_refs(&root, &album.id).map_err(|_| {
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
    for (drive_id, path) in refs {
        if !album_item_allowed(&home, &root, &album, &drive_id, &path) {
            continue;
        }
        let Ok(mount) = resolve_mount(&state, &drive_id) else {
            continue;
        };
        let Ok(abs) = luna_core::path::resolve_child(&mount, &path) else {
            continue;
        };
        if !abs.is_file() {
            continue;
        }
        entries.push((zip_entry_name(&drive_id, &path), abs));
    }
    if entries.is_empty() {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "This album has no photos to download yet.",
        ));
    }

    let zip_name = {
        let base = crate::files::content_disposition_filename(&album.name);
        if base == "download" || base.is_empty() {
            "album.zip".into()
        } else {
            format!("{base}.zip")
        }
    };

    stream_zip_response(&zip_name, move |tmp_path| {
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
        gallery::write_items_zip(&entries, &mut file, PUBLIC_ALBUM_ZIP_MAX).map_err(|e| {
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
        assert!(THUMB_CACHE_CONTROL.starts_with("private"));
        assert!(!THUMB_CACHE_CONTROL.contains("public"));
        assert!(THUMB_CACHE_CONTROL.contains("max-age="));
        assert!(THUMB_CACHE_CONTROL.contains("must-revalidate"));
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

    #[test]
    fn album_item_allowed_matches_items_and_contrib() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let album = crate::gallery::create_album(root, "home", "u1", "Shared").unwrap();
        crate::gallery::add_album_items(root, &album.id, &[("d1".into(), "a.jpg".into())]).unwrap();
        let mut album = crate::gallery::get_album(root, "home", &album.id)
            .unwrap()
            .unwrap();
        album.contrib_path = "Shared Photos/Shared".into();
        assert!(super::album_item_allowed(
            "home", root, &album, "d1", "a.jpg"
        ));
        assert!(!super::album_item_allowed(
            "home",
            root,
            &album,
            "d1",
            "other.jpg"
        ));
        assert!(super::album_item_allowed(
            "home",
            root,
            &album,
            "home",
            "Shared Photos/Shared/guest.jpg"
        ));
        assert!(!super::album_item_allowed(
            "home",
            root,
            &album,
            "other",
            "Shared Photos/Shared/guest.jpg"
        ));
    }

    #[test]
    fn write_items_zip_packs_files() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.jpg");
        let b = dir.path().join("b.png");
        std::fs::write(&a, b"aaa").unwrap();
        std::fs::write(&b, b"bbbb").unwrap();
        let zip_path = dir.path().join("out.zip");
        let file = std::fs::File::create(&zip_path).unwrap();
        let n = crate::gallery::write_items_zip(
            &[("d1/a.jpg".into(), a), ("d1/b.png".into(), b)],
            file,
            10,
        )
        .unwrap();
        assert_eq!(n, 2);
        assert!(zip_path.metadata().unwrap().len() > 20);
    }
}

use std::path::{Path as FsPath, PathBuf};

use axum::body::Body;
use axum::extract::{Extension, Path, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio_util::io::ReaderStream;

use crate::AppState;
use crate::api::response::json_error;
use crate::gallery::{self, ListFilter};

const THUMB_CACHE_CONTROL: &str = "private, max-age=3600, must-revalidate";
const GALLERY_DOWNLOAD_ZIP_MAX: usize = 200;

type ApiError = (StatusCode, Json<Value>);
type DriveMounts = Vec<(String, PathBuf)>;

fn is_admin(user: &crate::auth::CurrentUser) -> bool {
    user.role == "admin"
}

/// The capabilities `user` holds on this album through the universal access
/// model: everything for admins and the owner, member rows otherwise.
fn album_caps(
    state: &AppState,
    user: &crate::auth::CurrentUser,
    home: &str,
    album: &gallery::Album,
) -> crate::access::Caps {
    if is_admin(user) || album.owner_user_id == user.id {
        return crate::access::CAP_ALL;
    }
    let Ok(conn) = state.db.lock() else {
        return 0;
    };
    let Ok(rows) = crate::db::list_access_members_for_user(&conn, &user.id) else {
        return 0;
    };
    crate::access::member_caps_on_album(&rows, home, &album.id)
}

fn can_manage_album(user: &crate::auth::CurrentUser, album: &gallery::Album) -> bool {
    is_admin(user) || album.owner_user_id == user.id
}

fn can_view_album(
    state: &AppState,
    user: &crate::auth::CurrentUser,
    home: &str,
    album: &gallery::Album,
) -> bool {
    album_caps(state, user, home, album) & crate::access::CAP_VIEW != 0
}

fn can_contribute_album(
    state: &AppState,
    user: &crate::auth::CurrentUser,
    home: &str,
    album: &gallery::Album,
) -> bool {
    album_caps(state, user, home, album) & crate::access::CAP_UPLOAD != 0
}

/// Viewable path prefixes per drive for Members. `None` means Admin
/// (unrestricted); a missing drive key denies every path on that drive.
fn path_grants_for_user(
    state: &AppState,
    user: &crate::auth::CurrentUser,
) -> Result<Option<std::collections::HashMap<String, Vec<String>>>, ApiError> {
    if is_admin(user) {
        return Ok(None);
    }
    let conn = state.db.lock().map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna's index is busy. Try again.",
        )
    })?;
    let rows = crate::db::list_access_members_for_user(&conn, &user.id).map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't check your folder access.",
        )
    })?;
    let mut map: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
    for r in rows {
        if r.subject_kind == crate::access::KIND_PATH && r.caps & crate::access::CAP_VIEW != 0 {
            map.entry(r.drive_id).or_default().push(r.path);
        }
    }
    Ok(Some(map))
}

/// Path access, Admin, or album membership (for viewing shared album photos).
fn can_view_gallery_path(
    state: &AppState,
    user: &crate::auth::CurrentUser,
    drive_id: &str,
    path: &str,
) -> Result<bool, ApiError> {
    let conn = state.db.lock().map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna's index is busy. Try again.",
        )
    })?;
    if crate::auth::has_cap(user, &conn, drive_id, path, crate::access::CAP_VIEW) {
        return Ok(true);
    }
    // Album members see items (and contribution folders) through the album
    // even without a filesystem grant — the album itself is the access.
    Ok(crate::access::path_visible_via_album(
        &conn,
        &user.id,
        drive_id,
        path,
        |home, album_id| {
            let Ok(Some(drive)) = crate::db::get_drive(&conn, home) else {
                return false;
            };
            if drive.mount_point.is_empty() {
                return false;
            }
            let root = PathBuf::from(&drive.mount_point);
            let Ok(Some(album)) = gallery::get_album(&root, home, album_id) else {
                return false;
            };
            album_item_allowed(home, &root, &album, drive_id, path)
        },
    ))
}

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
    /// `MM-DD` match on the capture date — "on this day" across years. Pair
    /// with `to` to keep today's own photos out.
    #[serde(default)]
    month_day: Option<String>,
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
            "/api/v1/gallery/albums",
            get(list_albums).post(create_album),
        )
        .route(
            "/api/v1/gallery/albums/{home}/{id}",
            get(get_album).patch(patch_album).delete(delete_album),
        )
        .route(
            "/api/v1/gallery/albums/{home}/{id}/items",
            get(list_items).post(add_items).delete(remove_item),
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
    let album_id = query
        .album_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let album_home = query
        .album_home
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    // Album view needs both ids before we widen mounts or skip folder grants.
    // A lone album_id used to mount every drive and skip can_access — refuse that.
    let viewing_album = match (album_id, album_home) {
        (None, None) => false,
        (Some(album_id), Some(home)) => {
            let root = resolve_mount(&state, home)?;
            let album = gallery::get_album(&root, home, album_id)
                .map_err(|_| {
                    json_error(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "Luna couldn't open that album.",
                    )
                })?
                .ok_or_else(|| {
                    json_error(StatusCode::NOT_FOUND, "Luna doesn't know that album.")
                })?;
            if !can_view_album(&state, &user, home, &album) {
                return Err(json_error(
                    StatusCode::FORBIDDEN,
                    "You don't have permission to view this album.",
                ));
            }
            true
        }
        _ => {
            return Err(json_error(
                StatusCode::BAD_REQUEST,
                "To open an album, Luna needs both the album and which drive keeps it.",
            ));
        }
    };

    if let Some(drive_id) = query.drive_id.as_deref() {
        // Album view authorizes via album membership above; library still needs a drive grant.
        if !viewing_album {
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
    }
    // Album view: include every mounted drive so Members can see album items
    // without a folder grant. Library view stays grant-scoped.
    let mounts = if viewing_album {
        all_mounted(&state)?
    } else {
        accessible_mounts(&state, &user, None)?
    };
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
        album_id: query.album_id.clone(),
        album_home_drive: query.album_home.clone(),
        place: query.place,
        place_bbox: query.place_bbox.as_deref().and_then(parse_place_bbox),
        user_id: Some(user.id.clone()),
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
        month_day: query.month_day.filter(|s| !s.trim().is_empty()),
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
            if viewing_album {
                return true;
            }
            crate::auth::has_cap(
                &user,
                &conn,
                &photo.drive_id,
                &photo.path,
                crate::access::CAP_VIEW,
            )
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
            crate::auth::has_cap(&user, &conn, drive_id, path, crate::access::CAP_VIEW)
        })
        .collect::<Vec<_>>();
    Ok(Json(markers))
}

async fn cameras(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let mounts = accessible_mounts(&state, &user, None)?;
    let grants = path_grants_for_user(&state, &user)?;
    let cameras = gallery::list_cameras(&mounts, grants.as_ref()).map_err(|_| {
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
    let grants = path_grants_for_user(&state, &user)?;
    let facets = gallery::list_filter_facets(&mounts, grants.as_ref()).map_err(|_| {
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
        group.items.retain(|p| {
            crate::auth::has_cap(&user, &conn, &p.drive_id, &p.path, crate::access::CAP_VIEW)
        });
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
    // Scan errors keep a "{drive}" placeholder — name the drive when the
    // caller may see it, otherwise stay generic.
    let mut last_error = st.last_error.clone();
    if last_error.as_deref().is_some_and(|m| m.contains("{drive}")) {
        let label = st.error_drive_id.as_deref().and_then(|id| {
            let conn = state.db.lock().ok()?;
            crate::db::get_drive(&conn, id)
                .ok()
                .flatten()
                .filter(|_| crate::auth::has_drive_access(&user, &conn, id))
                .map(|row| row.label)
        });
        let name = label.map_or_else(|| "this drive".to_string(), |l| format!("\"{l}\""));
        last_error = last_error.map(|m| m.replace("{drive}", &name));
    }
    Json(json!({
        "scanning": st.scanning,
        "pending": st.pending,
        "busy": st.busy,
        "phase": st.phase,
        "drive_id": drive_id,
        "drive_label": drive_label,
        "found_count": st.found_count,
        "last_error": last_error,
    }))
}

/// Enqueue a catch-up gallery scan for every drive the caller can access.
/// Used by Photos → Look again.
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
    if !can_view_gallery_path(&state, &user, &query.drive_id, &query.path)? {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "You don't have permission to view this.",
        ));
    }
    if let Some(cached) = state.ram_cache.get_thumb(&query.drive_id, &query.path) {
        return serve_thumb_bytes(cached.bytes, cached.mtime_secs, cached.etag, &headers);
    }
    let root = resolve_mount(&state, &query.drive_id)?;
    let Some(thumb_path) = gallery::thumb_path(&root, &query.drive_id, &query.path) else {
        return Err(json_error(
            StatusCode::NOT_FOUND,
            "Luna couldn't find that photo.",
        ));
    };
    if !thumb_path.exists() {
        let (drive_id, path) = (query.drive_id.clone(), query.path.clone());
        let root2 = root.clone();
        tokio::task::spawn_blocking(move || -> Result<(), ()> {
            let src = luna_core::path::resolve_child(&root2, &path).map_err(|_| ())?;
            let dest = gallery::thumb_path(&root2, &drive_id, &path).ok_or(())?;
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
    let etag = crate::drives::ram_cache::thumb_etag(meta.len(), mtime_secs);
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

pub(crate) async fn serve_thumb(path: PathBuf) -> Result<Response, (StatusCode, Json<Value>)> {
    // Public album thumbs still use the on-disk path; validators without RAM.
    let meta = std::fs::metadata(&path)
        .map_err(|_| json_error(StatusCode::NOT_FOUND, "This thumbnail isn't ready yet."))?;
    let mtime_secs = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let etag = crate::drives::ram_cache::thumb_etag(meta.len(), mtime_secs);
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
pub(crate) fn album_item_allowed(
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

/// Browser-safe media path: HEIC → JPEG preview; everything else → original.
pub(crate) async fn resolve_browser_safe_file(
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
        let thumb = gallery::thumb_path(mount, drive_id, rel)
            .ok_or_else(|| json_error(StatusCode::NOT_FOUND, "Luna couldn't find that photo."))?;
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

pub(crate) async fn serve_media_path(
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

pub(crate) async fn stream_zip_response(
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

pub(crate) fn zip_entry_name(drive_id: &str, path: &str) -> String {
    let clean = path.trim().replace('\\', "/").trim_matches('/').to_string();
    format!("{drive_id}/{clean}")
}

async fn preview(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Query(query): Query<ThumbQuery>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    if !can_view_gallery_path(&state, &user, &query.drive_id, &query.path)? {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "You don't have permission to view this.",
        ));
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
        for item in &body.items {
            if !can_view_gallery_path(&state, &user, &item.drive_id, &item.path)? {
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
        if !crate::auth::has_cap(
            &user,
            &conn,
            &body.drive_id,
            &body.path,
            crate::access::CAP_VIEW,
        ) {
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
    // Scan every mounted drive so Members still see albums they own or joined
    // even without a folder grant on that drive. SQL still filters by membership.
    let mounts = all_mounted(&state)?;
    let member_ids = {
        let conn = state.db.lock().map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna's index is busy. Try again.",
            )
        })?;
        let rows = crate::db::list_access_members_for_user(&conn, &user.id).map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't check your album access.",
            )
        })?;
        let mut map: std::collections::HashMap<String, std::collections::HashSet<String>> =
            std::collections::HashMap::new();
        for r in rows {
            if r.subject_kind == crate::access::KIND_ALBUM && r.caps & crate::access::CAP_VIEW != 0
            {
                map.entry(r.drive_id).or_default().insert(r.album_id);
            }
        }
        map
    };
    let albums =
        gallery::list_albums(&mounts, &user.id, &member_ids, is_admin(&user)).map_err(|_| {
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
    if !can_view_album(&state, &user, &home, &album) {
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
    if !can_manage_album(&user, &album) {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Only the album owner or an Admin can change these settings.",
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
    if !can_manage_album(&user, &album) {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Only the album owner or an Admin can delete this album.",
        ));
    }
    gallery::delete_album(&root, &id).map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't delete that album.",
        )
    })?;
    // Members and links on this album die with it.
    if let Ok(conn) = state.db.lock() {
        let _ =
            crate::db::delete_access_for_subject(&conn, crate::access::KIND_ALBUM, &home, "", &id);
    }
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
    let can_add = can_contribute_album(&state, &user, &home, &album);
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
        if crate::auth::has_cap(
            &user,
            &conn,
            &item.drive_id,
            &item.path,
            crate::access::CAP_VIEW,
        ) {
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
    if !can_contribute_album(&state, &user, &home, &album) {
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

/// `GET …/items` — the photo refs an album holds, so the web UI can show
/// which albums a selection already belongs to before applying changes.
async fn list_items(
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
    if !can_view_album(&state, &user, &home, &album) {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "You don't have permission to view this album.",
        ));
    }
    let items = gallery::list_album_item_refs(&root, &id).map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't list that album's photos.",
        )
    })?;
    Ok(Json(json!(
        items
            .into_iter()
            .map(|(drive_id, path)| json!({ "drive_id": drive_id, "path": path }))
            .collect::<Vec<_>>()
    )))
}

#[cfg(test)]
mod tests {
    use super::THUMB_CACHE_CONTROL;
    use crate::drives::DriveManager;
    use crate::drives::mount::shared_mock;
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
    async fn status_names_the_failing_drive_in_last_error() {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        db::upsert_drive(
            &conn,
            "d-photos",
            "Family Photos",
            "as_is",
            "ext4",
            "sdz",
            "/mnt/d-photos",
        )
        .unwrap();
        let drive_manager = std::sync::Arc::new(DriveManager::new(shared_mock(), dir.path()));
        let state = AppState::new(conn, drive_manager, dir.path());
        let auth = state.auth.clone();
        let user = auth
            .register("Err", "Err", "hunter22hunter1", "admin")
            .unwrap();
        let token = auth.issue(&user).unwrap();
        state.gallery.debug_set_error(
            "d-photos",
            "Luna couldn't finish looking through {drive}. Try looking through it again, or unplug the drive and plug it back in.",
        );
        let make_router = || {
            axum::Router::new()
                .merge(super::router())
                .layer(axum::middleware::from_fn_with_state(
                    state.clone(),
                    crate::auth::guard,
                ))
                .with_state(state.clone())
        };
        let get_status = |router: axum::Router| {
            let token = token.clone();
            async move {
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
                serde_json::from_slice::<serde_json::Value>(&bytes).unwrap()
            }
        };

        let v = get_status(make_router()).await;
        let msg = v["last_error"].as_str().unwrap();
        assert!(
            msg.contains("\"Family Photos\""),
            "last_error should name the drive, got: {msg}"
        );
        assert!(!msg.contains("{drive}"));

        // A drive the caller cannot resolve falls back to a generic reference.
        state
            .gallery
            .debug_set_error("d-gone", "Luna couldn't finish looking through {drive}.");
        let v = get_status(make_router()).await;
        let msg = v["last_error"].as_str().unwrap();
        assert!(msg.contains("this drive"), "got: {msg}");
        assert!(!msg.contains("{drive}"));
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
        crate::drives::drive_db::create(
            root,
            &luna_core::marker::Marker::new("home", "Home"),
            &luna_core::marker::pick_prefix(root).unwrap(),
        )
        .unwrap();
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

    #[tokio::test]
    async fn member_album_id_without_home_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        let mount = dir.path().join("photos-vol");
        std::fs::create_dir_all(&mount).unwrap();
        let png = image::RgbaImage::from_pixel(4, 4, image::Rgba([9, 9, 9, 255]));
        png.save(mount.join("secret.png")).unwrap();
        let prefix = luna_core::marker::pick_prefix(&mount).unwrap();
        crate::drives::drive_db::create(
            &mount,
            &luna_core::marker::Marker::new("d-photos", "Family Photos"),
            &prefix,
        )
        .unwrap();
        crate::gallery::scan_drive("d-photos", &mount).unwrap();
        let album = crate::gallery::create_album(&mount, "d-photos", "owner", "Private").unwrap();
        crate::gallery::add_album_items(
            &mount,
            &album.id,
            &[("d-photos".into(), "secret.png".into())],
        )
        .unwrap();
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
        // First account is always Admin; Member must be the second user.
        let _admin = auth
            .register("Admin", "Admin", "hunter22hunter1", "admin")
            .unwrap();
        let member = auth
            .register("Member", "Member", "hunter22hunter1", "user")
            .unwrap();
        assert_eq!(member.role, "user");
        let token = auth.issue(&member).unwrap();
        let router = axum::Router::new()
            .merge(super::router())
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                crate::auth::guard,
            ))
            .with_state(state);

        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/v1/gallery?album_id={}", album.id))
                    .header("Authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::BAD_REQUEST,
            "album_id alone must not open the full library"
        );

        let response = router
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/api/v1/gallery?album_id={}&album_home=d-photos",
                        album.id
                    ))
                    .header("Authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::FORBIDDEN,
            "non-members must not view albums they were not invited to"
        );
    }
}

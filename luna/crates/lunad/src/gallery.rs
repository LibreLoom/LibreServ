//! Photo gallery: index tables live in the per-drive `.luna` microdb.
//!
//! Thumbnails live in `{drive}/.lunathumbs/`. Gallery SQLite never touches the
//! OS eMMC / `luna.db`. JPEG/PNG/GIF use the `image` crate; HEIC uses embedded
//! JPEG or Alpine `heif-dec`; video thumbs use optional `ffmpeg`. Originals
//! are never rewritten.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use image::{ImageFormat, ImageReader};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

const THUMB_MAX: u32 = 400;
const IMAGE_EXTS: &[&str] = &["jpg", "jpeg", "png", "gif", "heic", "heif", "hif"];
const VIDEO_EXTS: &[&str] = &["mp4", "mov", "m4v", "webm"];
const BATCH_UPSERT: usize = 64;

/// Per-drive thumbnail directory on the photo's own mount (not the OS eMMC).
pub const THUMBS_DIR_NAME: &str = ".lunathumbs";
/// Per-drive gallery DB + library metadata (not the OS eMMC).
pub const GALLERY_DIR_NAME: &str = ".lunagallery";
/// Shared-album contribution uploads land here on the album's home drive.
pub const SHARED_ALBUMS_DIR_NAME: &str = ".luna-shared-albums";
/// Top-level user-accessible folder for shared album uploads on the home drive.
pub const USER_SHARED_ALBUMS_DIR: &str = "Shared Photos";

#[derive(Debug, Clone, Serialize)]
pub struct Photo {
    pub drive_id: String,
    pub path: String,
    pub name: String,
    pub size: u64,
    pub taken_at: i64,
    pub width: u32,
    pub height: u32,
    pub thumb: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lat: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lon: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub place_label: Option<String>,
    #[serde(default)]
    pub camera_make: String,
    #[serde(default)]
    pub camera_model: String,
    #[serde(default)]
    pub lens: String,
    #[serde(default)]
    pub iso: u32,
    #[serde(default)]
    pub focal_mm: f64,
    /// `-1` unknown, `0` off, `1` on.
    #[serde(default = "flash_unknown")]
    pub flash: i64,
    #[serde(default)]
    pub duration_secs: u32,
    #[serde(default)]
    pub favorited: bool,
}

fn flash_unknown() -> i64 {
    -1
}

// Keep serde's `default = "flash_unknown"` reachable for rustc unused checks.
const _: fn() -> i64 = flash_unknown;

#[derive(Debug, Default)]
pub struct ScanReport {
    pub found: u64,
    pub thumbnailed: u64,
    pub failed: u64,
    pub pruned: u64,
}

#[derive(Debug, Clone, Default)]
pub struct ListFilter {
    pub q: Option<String>,
    pub from: Option<i64>,
    pub to: Option<i64>,
    pub favorites_user: Option<String>,
    pub album_id: Option<String>,
    pub album_home_drive: Option<String>,
    pub place: Option<String>,
    /// Map viewport filter: min_lon, min_lat, max_lon, max_lat (WGS84 degrees).
    pub place_bbox: Option<[f64; 4]>,
    pub user_id: Option<String>,
    /// Only photos this user has archived.
    pub archived_user: Option<String>,
    /// Hide photos this user has archived (library / favorites views).
    pub exclude_archived_user: Option<String>,
    /// Restrict to `"image"` or `"video"` when set.
    pub kind: Option<String>,
    /// Exact camera make filter (case-insensitive).
    pub camera_make: Option<String>,
    /// Exact camera model filter (case-insensitive).
    pub camera_model: Option<String>,
    /// Exact lens model filter (case-insensitive).
    pub lens: Option<String>,
    pub iso_min: Option<u32>,
    pub iso_max: Option<u32>,
    pub focal_min: Option<f64>,
    pub focal_max: Option<f64>,
    /// `0` = flash off, `1` = flash on.
    pub flash: Option<i64>,
    /// `landscape` | `portrait` | `square` from width/height.
    pub orientation: Option<String>,
    pub has_gps: Option<bool>,
    /// Path extension without dot (`jpg`, `heic`, `mp4`, …). `jpeg` matches `jpg`.
    pub format: Option<String>,
    /// Inclusive UTC hour-of-day (0–23) on effective capture time.
    pub hour_from: Option<u32>,
    pub hour_to: Option<u32>,
    pub min_megapixels: Option<f64>,
    pub min_duration: Option<u32>,
    pub max_duration: Option<u32>,
    /// Only rows with no EXIF capture date (`taken_at = 0` in the index).
    pub undated: Option<bool>,
    /// Album membership on the **same drive DB only**: `"none"` | `"any"`.
    /// Cross-drive album membership (album home on another mount) is not scanned.
    pub album_membership: Option<String>,
}

/// One group of likely duplicate photos (same size + file name).
#[derive(Debug, Clone, Serialize)]
pub struct DuplicateGroup {
    pub key: String,
    pub size: u64,
    pub name: String,
    pub items: Vec<Photo>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GalleryPage {
    pub items: Vec<Photo>,
    pub next_offset: u32,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct PlaceCluster {
    pub key: String,
    pub label: String,
    pub count: u64,
    pub lat: f64,
    pub lon: f64,
    pub cover_thumb: String,
}

/// One GPS-tagged photo for map clustering (leaf node at max zoom).
#[derive(Debug, Clone, Serialize)]
pub struct PlaceMarker {
    pub key: String,
    pub id: String,
    pub label: String,
    pub lat: f64,
    pub lon: f64,
    pub cover_thumb: String,
}

/// Distinct camera make/model pair with how many indexed photos use it.
#[derive(Debug, Clone, Serialize)]
pub struct CameraCount {
    pub make: String,
    pub model: String,
    pub count: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct LensCount {
    pub lens: String,
    pub count: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct FormatCount {
    pub ext: String,
    pub count: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct NumRange {
    pub min: f64,
    pub max: f64,
}

/// Aggregated filter facet values across accessible mounts.
#[derive(Debug, Clone, Serialize)]
pub struct FilterFacets {
    pub cameras: Vec<CameraCount>,
    pub lenses: Vec<LensCount>,
    pub formats: Vec<FormatCount>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub iso_range: Option<NumRange>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub focal_range: Option<NumRange>,
}

pub fn is_image(path: &Path) -> bool {
    ext_in(path, IMAGE_EXTS)
}

pub fn is_video(path: &Path) -> bool {
    ext_in(path, VIDEO_EXTS)
}

pub fn is_media(path: &Path) -> bool {
    is_image(path) || is_video(path)
}

fn ext_in(path: &Path, exts: &[&str]) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| exts.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

pub fn thumbs_dir(drive_root: &Path) -> PathBuf {
    drive_root.join(THUMBS_DIR_NAME)
}

pub fn gallery_dir(drive_root: &Path) -> PathBuf {
    drive_root.join(GALLERY_DIR_NAME)
}

pub fn gallery_db_path(drive_root: &Path) -> PathBuf {
    crate::drive_db::path_for(drive_root)
}

pub fn shared_albums_dir(drive_root: &Path) -> PathBuf {
    drive_root.join(SHARED_ALBUMS_DIR_NAME)
}

pub fn thumb_path(drive_root: &Path, drive_id: &str, rel: &str) -> PathBuf {
    let key = format!("{drive_id}:{rel}");
    let hash = blake3::hash(key.as_bytes()).to_hex().to_string();
    thumbs_dir(drive_root).join(format!("{hash}.jpg"))
}

pub fn thumb_url(drive_id: &str, rel: &str) -> String {
    format!(
        "/api/v1/gallery/thumb?drive_id={drive_id}&path={}",
        urlencode(rel)
    )
}

pub fn skip_gallery_dir(name: &str) -> bool {
    name == THUMBS_DIR_NAME
        || name == GALLERY_DIR_NAME
        || name == SHARED_ALBUMS_DIR_NAME
        || name == ".luna-trash"
        || name == crate::protect::PROTECTED_DIR
        || name == ".luna"
}

/// Open (or create) the on-drive `.luna` microdb (gallery tables included).
/// Never under OS data_dir.
pub fn open_drive_db(drive_root: &Path) -> anyhow::Result<Connection> {
    crate::drive_db::open(drive_root)
}

struct PendingUpsert {
    path: String,
    name: String,
    size: i64,
    mtime: i64,
    taken_at: i64,
    kind: String,
    width: u32,
    height: u32,
    lat: Option<f64>,
    lon: Option<f64>,
    place_label: String,
    camera_make: String,
    camera_model: String,
    lens: String,
    iso: u32,
    focal_mm: f64,
    flash: i64,
    duration_secs: u32,
    has_thumb: bool,
}

fn flash_to_i64(flash: Option<bool>) -> i64 {
    match flash {
        Some(true) => 1,
        Some(false) => 0,
        None => -1,
    }
}

fn path_ext_lower(path: &str) -> String {
    Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default()
}

fn normalize_format_ext(raw: &str) -> String {
    let e = raw.trim().trim_start_matches('.').to_ascii_lowercase();
    if e == "jpeg" { "jpg".into() } else { e }
}

/// Walk one drive and refresh its on-drive photo index + thumbnails.
pub fn scan_drive(drive_id: &str, root: &Path) -> anyhow::Result<ScanReport> {
    let thumb_dir = thumbs_dir(root);
    std::fs::create_dir_all(&thumb_dir)?;
    let mut conn = open_drive_db(root)?;
    let mut report = ScanReport::default();
    let mut seen = HashSet::new();
    let mut pending: Vec<PendingUpsert> = Vec::with_capacity(BATCH_UPSERT);
    let mut stack = vec![root.to_path_buf()];

    while let Some(dir) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };
            let meta = match std::fs::symlink_metadata(entry.path()) {
                Ok(m) => m,
                Err(_) => continue,
            };
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if skip_gallery_dir(&name) {
                    continue;
                }
                stack.push(entry.path());
                continue;
            }
            if !meta.is_file() || !is_media(&entry.path()) {
                continue;
            }
            let path_buf = entry.path();
            let Some(rel) = path_buf.strip_prefix(root).ok().and_then(|p| p.to_str()) else {
                continue;
            };
            let rel = rel.replace('\\', "/");
            seen.insert(rel.clone());
            let file_name = entry.file_name();
            let Some(name) = file_name.to_str() else {
                continue;
            };
            let name = name.to_string();
            let size = meta.len() as i64;
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            let kind = if is_video(&path_buf) {
                "video"
            } else {
                "image"
            };

            let dest = thumb_path(root, drive_id, &rel);
            if let Ok(Some((old_size, old_mtime, old_has_thumb))) = photo_cache_row(&conn, &rel)
                && old_size == size
                && old_mtime == mtime
                && old_has_thumb
                && dest.exists()
            {
                report.found += 1;
                continue;
            }

            let limits = crate::budget::limits();
            if (size as u64) > limits.source_max_bytes {
                report.found += 1;
                report.failed += 1;
                pending.push(PendingUpsert {
                    path: rel,
                    name,
                    size,
                    mtime,
                    taken_at: 0,
                    kind: kind.to_string(),
                    width: 0,
                    height: 0,
                    lat: None,
                    lon: None,
                    place_label: String::new(),
                    camera_make: String::new(),
                    camera_model: String::new(),
                    lens: String::new(),
                    iso: 0,
                    focal_mm: 0.0,
                    flash: -1,
                    duration_secs: 0,
                    has_thumb: false,
                });
                flush_if_full(&mut conn, &mut pending)?;
                continue;
            }

            let meta = crate::exif::capture_meta(&path_buf).unwrap_or_default();
            // `0` means no EXIF capture date; list/sort fall back to mtime.
            let taken_at = meta.taken_at.unwrap_or(0);
            let lat = meta.lat;
            let lon = meta.lon;
            let camera_make = meta.camera_make.unwrap_or_default();
            let camera_model = meta.camera_model.unwrap_or_default();
            let lens = meta.lens.unwrap_or_default();
            let iso = meta.iso.unwrap_or(0);
            let focal_mm = meta.focal_mm.unwrap_or(0.0);
            let flash = flash_to_i64(meta.flash);
            let place_label = match (lat, lon) {
                (Some(la), Some(lo)) => place_label_for(la, lo),
                _ => String::new(),
            };

            let mut width = 0;
            let mut height = 0;
            let mut has_thumb = false;
            match ensure_thumb(&path_buf, &dest, kind) {
                Ok((w, h, made)) => {
                    width = w;
                    height = h;
                    has_thumb = dest.exists();
                    report.found += 1;
                    if made {
                        report.thumbnailed += 1;
                    }
                }
                Err(_) => {
                    report.found += 1;
                    report.failed += 1;
                }
            }

            let duration_secs = if kind == "video" {
                probe_video_duration_secs(&path_buf)
            } else {
                0
            };

            pending.push(PendingUpsert {
                path: rel,
                name,
                size,
                mtime,
                taken_at,
                kind: kind.to_string(),
                width,
                height,
                lat,
                lon,
                place_label,
                camera_make,
                camera_model,
                lens,
                iso,
                focal_mm,
                flash,
                duration_secs,
                has_thumb,
            });
            flush_if_full(&mut conn, &mut pending)?;
        }
    }
    flush_batch(&mut conn, &mut pending)?;

    // Prune vanished paths in one pass.
    let existing: Vec<String> = {
        let mut stmt = conn.prepare("SELECT path FROM photos")?;
        let rows = stmt.query_map([], |row| row.get(0))?;
        rows.filter_map(|r| r.ok()).collect()
    };
    let stale: Vec<String> = existing.into_iter().filter(|p| !seen.contains(p)).collect();
    if !stale.is_empty() {
        let tx = conn.unchecked_transaction()?;
        for path in &stale {
            tx.execute("DELETE FROM photos WHERE path = ?1", params![path])?;
            tx.execute("DELETE FROM favorites WHERE path = ?1", params![path])?;
            tx.execute(
                "DELETE FROM album_items WHERE drive_id = ?1 AND path = ?2",
                params![drive_id, path],
            )?;
            report.pruned += 1;
        }
        tx.commit()?;
    }
    Ok(report)
}

fn flush_if_full(conn: &mut Connection, pending: &mut Vec<PendingUpsert>) -> anyhow::Result<()> {
    if pending.len() >= BATCH_UPSERT {
        flush_batch(conn, pending)?;
    }
    Ok(())
}

fn flush_batch(conn: &mut Connection, pending: &mut Vec<PendingUpsert>) -> anyhow::Result<()> {
    if pending.is_empty() {
        return Ok(());
    }
    let tx = conn.unchecked_transaction()?;
    for row in pending.drain(..) {
        tx.execute(
            "INSERT INTO photos (path, name, size, mtime, taken_at, kind, width, height, lat, lon, place_label, camera_make, camera_model, lens, iso, focal_mm, flash, duration_secs, has_thumb)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)
             ON CONFLICT(path) DO UPDATE SET
               name = excluded.name,
               size = excluded.size,
               mtime = excluded.mtime,
               taken_at = excluded.taken_at,
               kind = excluded.kind,
               width = excluded.width,
               height = excluded.height,
               lat = excluded.lat,
               lon = excluded.lon,
               place_label = excluded.place_label,
               camera_make = excluded.camera_make,
               camera_model = excluded.camera_model,
               lens = excluded.lens,
               iso = excluded.iso,
               focal_mm = excluded.focal_mm,
               flash = excluded.flash,
               duration_secs = excluded.duration_secs,
               has_thumb = excluded.has_thumb",
            params![
                row.path,
                row.name,
                row.size,
                row.mtime,
                row.taken_at,
                row.kind,
                row.width as i64,
                row.height as i64,
                row.lat,
                row.lon,
                row.place_label,
                row.camera_make,
                row.camera_model,
                row.lens,
                row.iso as i64,
                row.focal_mm,
                row.flash,
                row.duration_secs as i64,
                if row.has_thumb { 1 } else { 0 },
            ],
        )?;
    }
    tx.commit()?;
    Ok(())
}

fn photo_cache_row(conn: &Connection, rel: &str) -> anyhow::Result<Option<(i64, i64, bool)>> {
    let mut stmt = conn.prepare("SELECT size, mtime, has_thumb FROM photos WHERE path = ?1")?;
    let mut rows = stmt.query(params![rel])?;
    if let Some(row) = rows.next()? {
        let has: i64 = row.get(2)?;
        Ok(Some((row.get(0)?, row.get(1)?, has != 0)))
    } else {
        Ok(None)
    }
}

/// Fast path: EXIF + DB row so the photo shows in the timeline immediately.
/// Thumbnails are filled in by [`finish_thumb`].
pub fn index_one_meta(drive_id: &str, root: &Path, rel: &str) -> anyhow::Result<Option<()>> {
    let path_buf = root.join(rel);
    if !path_buf.is_file() || !is_media(&path_buf) {
        return Ok(None);
    }
    let meta = std::fs::symlink_metadata(&path_buf)?;
    let name = path_buf
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(rel)
        .to_string();
    let size = meta.len() as i64;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let kind = if is_video(&path_buf) {
        "video"
    } else {
        "image"
    };
    let mut conn = open_drive_db(root)?;
    if let Ok(Some((old_size, old_mtime, old_has_thumb))) = photo_cache_row(&conn, rel) {
        let dest = thumb_path(root, drive_id, rel);
        if old_size == size && old_mtime == mtime && old_has_thumb && dest.exists() {
            return Ok(Some(()));
        }
    }
    let meta = crate::exif::capture_meta(&path_buf).unwrap_or_default();
    let taken_at = meta.taken_at.unwrap_or(0);
    let lat = meta.lat;
    let lon = meta.lon;
    let camera_make = meta.camera_make.unwrap_or_default();
    let camera_model = meta.camera_model.unwrap_or_default();
    let lens = meta.lens.unwrap_or_default();
    let iso = meta.iso.unwrap_or(0);
    let focal_mm = meta.focal_mm.unwrap_or(0.0);
    let flash = flash_to_i64(meta.flash);
    let place_label = match (lat, lon) {
        (Some(la), Some(lo)) => place_label_for(la, lo),
        _ => String::new(),
    };
    let duration_secs = if kind == "video" {
        probe_video_duration_secs(&path_buf)
    } else {
        0
    };
    let mut pending = vec![PendingUpsert {
        path: rel.to_string(),
        name,
        size,
        mtime,
        taken_at,
        kind: kind.to_string(),
        width: 0,
        height: 0,
        lat,
        lon,
        place_label,
        camera_make,
        camera_model,
        lens,
        iso,
        focal_mm,
        flash,
        duration_secs,
        has_thumb: false,
    }];
    flush_batch(&mut conn, &mut pending)?;
    Ok(Some(()))
}

/// Build (or refresh) the thumbnail for an already-indexed photo.
pub fn finish_thumb(drive_id: &str, root: &Path, rel: &str) -> anyhow::Result<()> {
    let path_buf = root.join(rel);
    if !path_buf.is_file() || !is_media(&path_buf) {
        return Ok(());
    }
    let kind = if is_video(&path_buf) {
        "video"
    } else {
        "image"
    };
    let dest = thumb_path(root, drive_id, rel);
    let _ = std::fs::create_dir_all(thumbs_dir(root));
    let (width, height, has_thumb) = match ensure_thumb(&path_buf, &dest, kind) {
        Ok((w, h, _)) => (w, h, dest.exists()),
        Err(_) => (0, 0, false),
    };
    let conn = open_drive_db(root)?;
    conn.execute(
        "UPDATE photos SET width = ?1, height = ?2, has_thumb = ?3 WHERE path = ?4",
        params![
            width as i64,
            height as i64,
            if has_thumb { 1 } else { 0 },
            rel
        ],
    )?;
    Ok(())
}

/// Index a single media file (meta + thumb). Used by shared-album uploads and tests.
pub fn index_one(drive_id: &str, root: &Path, rel: &str) -> anyhow::Result<Option<Photo>> {
    if index_one_meta(drive_id, root, rel)?.is_none() {
        return Ok(None);
    }
    let _ = finish_thumb(drive_id, root, rel);
    let conn = open_drive_db(root)?;
    let mut stmt = conn.prepare(
        "SELECT path, name, size, COALESCE(NULLIF(taken_at, 0), mtime), kind, width, height, lat, lon, place_label,
                camera_make, camera_model, lens, iso, focal_mm, flash, duration_secs, has_thumb
         FROM photos WHERE path = ?1",
    )?;
    let photo = stmt
        .query_row(params![rel], |row| {
            let path: String = row.get(0)?;
            let name: String = row.get(1)?;
            let size: i64 = row.get(2)?;
            let taken_at: i64 = row.get(3)?;
            let kind: String = row.get(4)?;
            let width: i64 = row.get(5)?;
            let height: i64 = row.get(6)?;
            let lat: Option<f64> = row.get(7)?;
            let lon: Option<f64> = row.get(8)?;
            let place_label: String = row.get(9)?;
            let camera_make: String = row.get(10)?;
            let camera_model: String = row.get(11)?;
            let lens: String = row.get(12)?;
            let iso: i64 = row.get(13)?;
            let focal_mm: f64 = row.get(14)?;
            let flash: i64 = row.get(15)?;
            let duration_secs: i64 = row.get(16)?;
            let has_thumb: i64 = row.get(17)?;
            Ok(Photo {
                drive_id: drive_id.to_string(),
                path: path.clone(),
                name,
                size: size as u64,
                taken_at,
                width: width as u32,
                height: height as u32,
                thumb: if has_thumb != 0 {
                    thumb_url(drive_id, &path)
                } else {
                    String::new()
                },
                kind,
                lat,
                lon,
                place_label: if place_label.is_empty() {
                    None
                } else {
                    Some(place_label)
                },
                camera_make,
                camera_model,
                lens,
                iso: iso.max(0) as u32,
                focal_mm,
                flash,
                duration_secs: duration_secs.max(0) as u32,
                favorited: false,
            })
        })
        .optional()?;
    Ok(photo)
}

pub fn remove_indexed_path(root: &Path, drive_id: &str, rel: &str) -> anyhow::Result<()> {
    let path = gallery_db_path(root);
    if !path.exists() {
        return Ok(());
    }
    let conn = open_drive_db(root)?;
    conn.execute("DELETE FROM photos WHERE path = ?1", params![rel])?;
    conn.execute("DELETE FROM favorites WHERE path = ?1", params![rel])?;
    drop(conn);
    // Refresh album covers when this path was a cover on this drive's albums.
    let _ = remove_album_items_for_path(root, drive_id, rel);
    let thumb = thumb_path(root, drive_id, rel);
    let _ = std::fs::remove_file(thumb);
    Ok(())
}

/// Purge album_item refs for a deleted photo from every mounted album home.
pub fn purge_album_item_refs_on_mounts(mounts: &[(String, PathBuf)], drive_id: &str, path: &str) {
    for (_, root) in mounts {
        let _ = purge_album_item_refs_on_home(root, drive_id, path);
    }
}

/// Move an indexed path (same drive). Falls back to remove+reindex if the
/// destination is media that still needs a fresh EXIF pass.
pub fn rename_indexed_path(
    root: &Path,
    drive_id: &str,
    from: &str,
    to: &str,
) -> anyhow::Result<()> {
    let path = gallery_db_path(root);
    if !path.exists() {
        return Ok(());
    }
    let conn = open_drive_db(root)?;
    let name = Path::new(to)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(to);
    let updated = conn.execute(
        "UPDATE photos SET path = ?1, name = ?2 WHERE path = ?3",
        params![to, name, from],
    )?;
    conn.execute(
        "UPDATE favorites SET path = ?1 WHERE path = ?2",
        params![to, from],
    )?;
    conn.execute(
        "UPDATE album_items SET path = ?1 WHERE drive_id = ?2 AND path = ?3",
        params![to, drive_id, from],
    )?;
    let old_thumb = thumb_path(root, drive_id, from);
    let new_thumb = thumb_path(root, drive_id, to);
    if old_thumb.exists() {
        let _ = std::fs::create_dir_all(thumbs_dir(root));
        let _ = std::fs::rename(&old_thumb, &new_thumb);
    }
    if updated == 0 && should_reindex_after_rename(to) {
        drop(conn);
        let _ = index_one_meta(drive_id, root, to);
    }
    Ok(())
}

fn should_reindex_after_rename(rel: &str) -> bool {
    is_media(Path::new(rel))
}

/// Generate a 400px JPEG thumbnail. Returns (width, height, was_created).
pub fn ensure_thumb(src: &Path, dest: &Path, kind: &str) -> anyhow::Result<(u32, u32, bool)> {
    if dest.exists() {
        return Ok((0, 0, false));
    }
    let limits = crate::budget::limits();
    let meta = std::fs::symlink_metadata(src)?;
    if meta.len() > limits.source_max_bytes {
        anyhow::bail!("photo is too large to preview with the free memory on this Luna");
    }
    if kind == "video" {
        return ensure_video_thumb(src, dest);
    }
    if crate::heif::is_heif(src) {
        return ensure_heif_thumb(src, dest);
    }
    decode_and_save_thumb(src, dest)
}

fn ensure_video_thumb(src: &Path, dest: &Path) -> anyhow::Result<(u32, u32, bool)> {
    let ffmpeg = which_ffmpeg();
    let Some(ffmpeg) = ffmpeg else {
        anyhow::bail!("ffmpeg not available");
    };
    let _permit = crate::budget::acquire_heif_slot_blocking();
    // Must end in `.jpg` so ffmpeg can pick an image muxer. A `.tmp` suffix
    // (e.g. `hash.vid.jpg.tmp`) makes ffmpeg fail with "Unable to choose an
    // output format" and gallery video thumbs stay empty forever.
    let tmp = dest.with_extension("vidtmp.jpg");
    if let Some(parent) = tmp.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let status = std::process::Command::new(ffmpeg)
        .args(["-y", "-ss", "0", "-i"])
        .arg(src)
        .args([
            "-frames:v",
            "1",
            "-vf",
            &format!("scale='min({THUMB_MAX},iw)':-2"),
            "-q:v",
            "5",
        ])
        .arg(&tmp)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()?;
    if !status.success() || !tmp.exists() {
        let _ = std::fs::remove_file(&tmp);
        anyhow::bail!("ffmpeg could not make a video preview");
    }
    // Re-encode through our pipeline when the frame is huge; otherwise rename.
    match decode_and_save_thumb(&tmp, dest) {
        Ok(r) => {
            let _ = std::fs::remove_file(&tmp);
            Ok(r)
        }
        Err(_) => {
            std::fs::rename(&tmp, dest)?;
            Ok((0, 0, true))
        }
    }
}

fn which_ffmpeg() -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|paths| {
        for dir in std::env::split_paths(&paths) {
            let cand = dir.join("ffmpeg");
            if cand.is_file() {
                return Some(cand);
            }
        }
        None
    })
}

fn which_ffprobe() -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|paths| {
        for dir in std::env::split_paths(&paths) {
            let cand = dir.join("ffprobe");
            if cand.is_file() {
                return Some(cand);
            }
        }
        None
    })
}

/// Best-effort video duration via ffprobe. Returns 0 when unavailable.
fn probe_video_duration_secs(src: &Path) -> u32 {
    let Some(ffprobe) = which_ffprobe() else {
        return 0;
    };
    let output = std::process::Command::new(ffprobe)
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
        ])
        .arg(src)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .output();
    let Ok(out) = output else {
        return 0;
    };
    if !out.status.success() {
        return 0;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let Ok(secs) = text.trim().parse::<f64>() else {
        return 0;
    };
    if secs.is_finite() && secs > 0.0 {
        secs.round().clamp(0.0, u32::MAX as f64) as u32
    } else {
        0
    }
}

fn ensure_heif_thumb(src: &Path, dest: &Path) -> anyhow::Result<(u32, u32, bool)> {
    let limits = crate::budget::limits();
    let bytes = read_capped(src, limits.source_max_bytes)?;
    if let Some(jpeg) = crate::heif::jpeg_item_from_heif(&bytes) {
        let work = dest.with_extension("src.jpg");
        std::fs::write(&work, jpeg)?;
        let result = decode_and_save_thumb(&work, dest);
        let _ = std::fs::remove_file(&work);
        return result;
    }
    drop(bytes);
    let _permit = crate::budget::acquire_heif_slot_blocking();
    let decoded = dest.with_extension("heic-src.jpg");
    let result = (|| {
        crate::heif::decode_heif_to_jpeg(src, &decoded)?;
        decode_and_save_thumb(&decoded, dest)
    })();
    let _ = std::fs::remove_file(&decoded);
    let _ = std::fs::remove_file(decoded.with_extension("jpg.tmp"));
    result
}

fn read_capped(path: &Path, max: u64) -> anyhow::Result<Vec<u8>> {
    let meta = std::fs::metadata(path)?;
    if meta.len() > max {
        anyhow::bail!("file exceeds memory budget ({max} bytes)");
    }
    let mut file = std::fs::File::open(path)?;
    let mut buf = Vec::with_capacity(meta.len() as usize);
    std::io::Read::read_to_end(&mut file, &mut buf)?;
    if buf.len() as u64 > max {
        anyhow::bail!("file exceeds memory budget ({max} bytes)");
    }
    Ok(buf)
}

fn decode_and_save_thumb(src: &Path, dest: &Path) -> anyhow::Result<(u32, u32, bool)> {
    let limits = crate::budget::limits();
    let mut img_limits = image::Limits::default();
    img_limits.max_image_width = Some(limits.max_image_dim);
    img_limits.max_image_height = Some(limits.max_image_dim);
    img_limits.max_alloc = Some(limits.decode_max_bytes);
    let mut reader = ImageReader::open(src)?;
    reader.limits(img_limits);
    let img = reader.decode()?;
    let (w, h) = (img.width(), img.height());
    let thumb = img.thumbnail(THUMB_MAX, THUMB_MAX);
    let tmp = dest.with_extension("jpg.tmp");
    if let Some(parent) = tmp.parent() {
        std::fs::create_dir_all(parent)?;
    }
    thumb.save_with_format(&tmp, ImageFormat::Jpeg)?;
    std::fs::rename(&tmp, dest)?;
    Ok((w, h, true))
}

/// Merge timeline across mounted drives. `mounts` is `(drive_id, root)`.
pub fn list_photos(
    mounts: &[(String, PathBuf)],
    drive_id: Option<&str>,
    filter: &ListFilter,
    limit: u32,
    offset: u32,
) -> anyhow::Result<GalleryPage> {
    let album_paths = load_album_paths(mounts, filter)?;
    let mut all = Vec::new();
    for (id, root) in mounts {
        if let Some(want) = drive_id
            && want != id
        {
            continue;
        }
        if !gallery_db_path(root).exists() {
            continue;
        }
        let conn = match open_drive_db(root) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let rows = query_drive_photos(&conn, id, filter, album_paths.as_ref())?;
        all.extend(rows);
    }
    all.sort_by(|a, b| {
        b.taken_at
            .cmp(&a.taken_at)
            .then_with(|| a.path.cmp(&b.path))
            .then_with(|| a.drive_id.cmp(&b.drive_id))
    });
    let total = all.len();
    let start = (offset as usize).min(total);
    let end = (start + limit as usize).min(total);
    let items = all[start..end].to_vec();
    let next_offset = end as u32;
    Ok(GalleryPage {
        has_more: end < total,
        next_offset,
        items,
    })
}

/// Photos that share the same file name and byte size (likely duplicates).
/// Groups are ordered by item count descending, then name. Cap at `limit` groups.
pub fn list_duplicates(
    mounts: &[(String, PathBuf)],
    limit: u32,
) -> anyhow::Result<Vec<DuplicateGroup>> {
    use std::collections::HashMap;
    let mut map: HashMap<(u64, String), Vec<Photo>> = HashMap::new();
    for (drive_id, root) in mounts {
        if !gallery_db_path(root).exists() {
            continue;
        }
        let conn = match open_drive_db(root) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let mut stmt = conn.prepare(
            "SELECT path, name, size, COALESCE(NULLIF(taken_at, 0), mtime),
                    width, height, kind, lat, lon, place_label, has_thumb,
                    COALESCE(duration_secs, 0),
                    COALESCE(camera_make, ''), COALESCE(camera_model, ''),
                    COALESCE(lens, ''), COALESCE(iso, 0), COALESCE(focal_mm, 0),
                    COALESCE(flash, -1)
             FROM photos",
        )?;
        let rows = stmt.query_map([], |row| {
            let path: String = row.get(0)?;
            let name: String = row.get(1)?;
            let size: i64 = row.get(2)?;
            let has_thumb: i64 = row.get(10)?;
            let place_label: String = row.get(9)?;
            Ok(Photo {
                drive_id: drive_id.clone(),
                path: path.clone(),
                name,
                size: size.max(0) as u64,
                taken_at: row.get(3)?,
                width: row.get::<_, i64>(4)?.max(0) as u32,
                height: row.get::<_, i64>(5)?.max(0) as u32,
                thumb: if has_thumb != 0 {
                    thumb_url(drive_id, &path)
                } else {
                    String::new()
                },
                kind: row.get(6)?,
                lat: row.get(7)?,
                lon: row.get(8)?,
                place_label: if place_label.is_empty() {
                    None
                } else {
                    Some(place_label)
                },
                camera_make: row.get(12)?,
                camera_model: row.get(13)?,
                lens: row.get(14)?,
                iso: row.get::<_, i64>(15)?.max(0) as u32,
                focal_mm: row.get(16)?,
                flash: row.get(17)?,
                duration_secs: row.get::<_, i64>(11)?.max(0) as u32,
                favorited: false,
            })
        })?;
        for row in rows.flatten() {
            let key = (row.size, row.name.clone());
            map.entry(key).or_default().push(row);
        }
    }
    let mut groups: Vec<DuplicateGroup> = map
        .into_iter()
        .filter(|(_, items)| items.len() > 1)
        .map(|((size, name), mut items)| {
            items.sort_by(|a, b| {
                b.taken_at
                    .cmp(&a.taken_at)
                    .then_with(|| a.path.cmp(&b.path))
                    .then_with(|| a.drive_id.cmp(&b.drive_id))
            });
            DuplicateGroup {
                key: format!("{size}:{name}"),
                size,
                name,
                items,
            }
        })
        .collect();
    groups.sort_by(|a, b| {
        b.items
            .len()
            .cmp(&a.items.len())
            .then_with(|| a.name.cmp(&b.name))
            .then_with(|| a.size.cmp(&b.size))
    });
    let cap = (limit as usize).clamp(1, 200);
    groups.truncate(cap);
    Ok(groups)
}

fn load_album_paths(
    mounts: &[(String, PathBuf)],
    filter: &ListFilter,
) -> anyhow::Result<Option<HashSet<(String, String)>>> {
    let album_id = filter
        .album_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let home = filter
        .album_home_drive
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    match (album_id, home) {
        (None, None) => Ok(None),
        // Incomplete album filter must not fall through to an unfiltered library list.
        (None, Some(_)) | (Some(_), None) => Ok(Some(HashSet::new())),
        (Some(album_id), Some(home)) => {
            let Some((_, root)) = mounts.iter().find(|(id, _)| id == home) else {
                return Ok(Some(HashSet::new()));
            };
            if !gallery_db_path(root).exists() {
                return Ok(Some(HashSet::new()));
            }
            let conn = open_drive_db(root)?;
            let mut stmt =
                conn.prepare("SELECT drive_id, path FROM album_items WHERE album_id = ?1")?;
            let set = stmt
                .query_map(params![album_id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .filter_map(|r| r.ok())
                .collect();
            Ok(Some(set))
        }
    }
}

fn query_drive_photos(
    conn: &Connection,
    drive_id: &str,
    filter: &ListFilter,
    album_paths: Option<&HashSet<(String, String)>>,
) -> anyhow::Result<Vec<Photo>> {
    let uid = filter
        .favorites_user
        .as_deref()
        .or(filter.user_id.as_deref())
        .or(filter.archived_user.as_deref())
        .or(filter.exclude_archived_user.as_deref())
        .unwrap_or("");
    let q_pat = filter
        .q
        .as_ref()
        .map(|q| {
            let scrubbed: String = q.chars().filter(|c| *c != '%' && *c != '_').collect();
            format!("%{scrubbed}%")
        })
        .unwrap_or_default();
    let from = filter.from.unwrap_or(0);
    let to = filter.to.unwrap_or(0);
    let place = filter.place.clone().unwrap_or_default();
    let (bbox_min_lon, bbox_min_lat, bbox_max_lon, bbox_max_lat) = filter
        .place_bbox
        .map(|[min_lon, min_lat, max_lon, max_lat]| (min_lon, min_lat, max_lon, max_lat))
        .unwrap_or((0.0, 0.0, 0.0, 0.0));
    let bbox_active = if filter.place_bbox.is_some() {
        1i64
    } else {
        0i64
    };
    let fav_only = if filter.favorites_user.is_some() {
        1i64
    } else {
        0
    };
    let archived_only = if filter.archived_user.is_some() {
        1i64
    } else {
        0
    };
    let exclude_archived = if filter.exclude_archived_user.is_some() {
        1i64
    } else {
        0
    };
    let kind = filter
        .kind
        .as_deref()
        .map(str::trim)
        .filter(|s| *s == "image" || *s == "video")
        .unwrap_or("");
    let camera_make = filter
        .camera_make
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("");
    let camera_model = filter
        .camera_model
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("");
    let lens = filter
        .lens
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("");
    let iso_min = filter.iso_min.map(|v| v as i64).unwrap_or(-1);
    let iso_max = filter.iso_max.map(|v| v as i64).unwrap_or(-1);
    let focal_min = filter.focal_min.unwrap_or(-1.0);
    let focal_max = filter.focal_max.unwrap_or(-1.0);
    let flash = filter.flash.filter(|v| *v == 0 || *v == 1).unwrap_or(-2);
    let orientation = filter
        .orientation
        .as_deref()
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .filter(|s| s == "landscape" || s == "portrait" || s == "square")
        .unwrap_or_default();
    let has_gps = match filter.has_gps {
        Some(true) => 1i64,
        Some(false) => 0i64,
        None => -1i64,
    };
    let format = filter
        .format
        .as_deref()
        .map(normalize_format_ext)
        .filter(|s| !s.is_empty())
        .unwrap_or_default();
    let hour_from = filter
        .hour_from
        .filter(|h| *h <= 23)
        .map(|h| h as i64)
        .unwrap_or(-1);
    let hour_to = filter
        .hour_to
        .filter(|h| *h <= 23)
        .map(|h| h as i64)
        .unwrap_or(-1);
    let min_megapixels = filter.min_megapixels.unwrap_or(-1.0);
    let min_duration = filter.min_duration.map(|v| v as i64).unwrap_or(-1);
    let max_duration = filter.max_duration.map(|v| v as i64).unwrap_or(-1);
    let undated = match filter.undated {
        Some(true) => 1i64,
        Some(false) => 0i64,
        None => -1i64,
    };
    // Same-drive album_items only — albums whose home is another mount are not
    // consulted (cross-drive membership scan is expensive).
    let album_membership = filter
        .album_membership
        .as_deref()
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .filter(|s| s == "none" || s == "any")
        .unwrap_or_default();

    let mut stmt = conn.prepare(
        "SELECT p.path, p.name, p.size, COALESCE(NULLIF(p.taken_at, 0), p.mtime),
                p.width, p.height, p.kind, p.lat, p.lon, p.place_label, p.has_thumb,
                CASE WHEN f.path IS NOT NULL THEN 1 ELSE 0 END,
                COALESCE(p.duration_secs, 0),
                COALESCE(p.camera_make, ''), COALESCE(p.camera_model, ''),
                COALESCE(p.lens, ''), COALESCE(p.iso, 0), COALESCE(p.focal_mm, 0),
                COALESCE(p.flash, -1)
         FROM photos p
         LEFT JOIN favorites f ON f.path = p.path AND f.user_id = ?1
         LEFT JOIN archive ar ON ar.path = p.path AND ar.user_id = ?1
         WHERE (?2 = '' OR p.name LIKE ?2 COLLATE NOCASE OR p.path LIKE ?2 COLLATE NOCASE
                OR p.camera_make LIKE ?2 COLLATE NOCASE OR p.camera_model LIKE ?2 COLLATE NOCASE
                OR p.lens LIKE ?2 COLLATE NOCASE)
           AND (?3 = 0 OR COALESCE(NULLIF(p.taken_at, 0), p.mtime) >= ?3)
           AND (?4 = 0 OR COALESCE(NULLIF(p.taken_at, 0), p.mtime) <= ?4)
           AND (?5 = '' OR (p.lat IS NOT NULL AND p.lon IS NOT NULL
                AND printf('%.1f,%.1f', p.lat, p.lon) = ?5))
           AND (?6 = 0 OR f.path IS NOT NULL)
           AND (?7 = 0 OR (p.lat IS NOT NULL AND p.lon IS NOT NULL
                AND p.lon >= ?8 AND p.lon <= ?9 AND p.lat >= ?10 AND p.lat <= ?11))
           AND (?12 = 0 OR ar.path IS NOT NULL)
           AND (?13 = 0 OR ar.path IS NULL)
           AND (?14 = '' OR p.kind = ?14)
           AND (?15 = '' OR lower(p.camera_make) = lower(?15))
           AND (?16 = '' OR lower(p.camera_model) = lower(?16))
           AND (?17 = '' OR lower(p.lens) = lower(?17))
           AND (?18 < 0 OR (p.iso > 0 AND p.iso >= ?18))
           AND (?19 < 0 OR (p.iso > 0 AND p.iso <= ?19))
           AND (?20 < 0 OR (p.focal_mm > 0 AND p.focal_mm >= ?20))
           AND (?21 < 0 OR (p.focal_mm > 0 AND p.focal_mm <= ?21))
           AND (?22 < 0 OR p.flash = ?22)
           AND (?23 = '' OR (
                (?23 = 'landscape' AND p.width > p.height AND p.width > 0) OR
                (?23 = 'portrait' AND p.height > p.width AND p.height > 0) OR
                (?23 = 'square' AND p.width = p.height AND p.width > 0)
           ))
           AND (?24 < 0 OR (
                (?24 = 1 AND p.lat IS NOT NULL AND p.lon IS NOT NULL) OR
                (?24 = 0 AND (p.lat IS NULL OR p.lon IS NULL))
           ))
           AND (?25 < 0 OR ?26 < 0 OR (
                CASE
                  WHEN ?25 <= ?26 THEN
                    ((COALESCE(NULLIF(p.taken_at, 0), p.mtime) / 3600) % 24) BETWEEN ?25 AND ?26
                  ELSE
                    ((COALESCE(NULLIF(p.taken_at, 0), p.mtime) / 3600) % 24) >= ?25
                    OR ((COALESCE(NULLIF(p.taken_at, 0), p.mtime) / 3600) % 24) <= ?26
                END
           ))
           AND (?27 < 0 OR (p.width > 0 AND p.height > 0
                AND (CAST(p.width AS REAL) * CAST(p.height AS REAL) / 1000000.0) >= ?27))
           AND (?28 < 0 OR p.duration_secs >= ?28)
           AND (?29 < 0 OR p.duration_secs <= ?29)
           AND (?30 < 0 OR (
                (?30 = 1 AND p.taken_at = 0) OR
                (?30 = 0 AND p.taken_at != 0)
           ))
           AND (?31 = '' OR (
                (?31 = 'any' AND EXISTS (
                    SELECT 1 FROM album_items ai
                    WHERE ai.path = p.path AND ai.drive_id = ?32
                )) OR
                (?31 = 'none' AND NOT EXISTS (
                    SELECT 1 FROM album_items ai
                    WHERE ai.path = p.path AND ai.drive_id = ?32
                ))
           ))",
    )?;
    let rows = stmt.query_map(
        params![
            uid,
            q_pat,
            from,
            to,
            place,
            fav_only,
            bbox_active,
            bbox_min_lon,
            bbox_max_lon,
            bbox_min_lat,
            bbox_max_lat,
            archived_only,
            exclude_archived,
            kind,
            camera_make,
            camera_model,
            lens,
            iso_min,
            iso_max,
            focal_min,
            focal_max,
            flash,
            orientation,
            has_gps,
            hour_from,
            hour_to,
            min_megapixels,
            min_duration,
            max_duration,
            undated,
            album_membership,
            drive_id,
        ],
        |row| {
            let path: String = row.get(0)?;
            let has_thumb: i64 = row.get(10)?;
            let favorited: i64 = row.get(11)?;
            let place_label: String = row.get(9)?;
            let duration_secs: i64 = row.get(12)?;
            let camera_make: String = row.get(13)?;
            let camera_model: String = row.get(14)?;
            let lens: String = row.get(15)?;
            let iso: i64 = row.get(16)?;
            let focal_mm: f64 = row.get(17)?;
            let flash: i64 = row.get(18)?;
            Ok(Photo {
                drive_id: drive_id.to_string(),
                path: path.clone(),
                name: row.get(1)?,
                size: row.get::<_, i64>(2)? as u64,
                taken_at: row.get(3)?,
                width: row.get::<_, i64>(4)? as u32,
                height: row.get::<_, i64>(5)? as u32,
                thumb: if has_thumb != 0 {
                    thumb_url(drive_id, &path)
                } else {
                    String::new()
                },
                kind: row.get(6)?,
                lat: row.get(7)?,
                lon: row.get(8)?,
                place_label: if place_label.is_empty() {
                    None
                } else {
                    Some(place_label)
                },
                camera_make,
                camera_model,
                lens,
                iso: iso.max(0) as u32,
                focal_mm,
                flash,
                duration_secs: duration_secs.max(0) as u32,
                favorited: favorited != 0,
            })
        },
    )?;

    let mut photos = Vec::new();
    for row in rows {
        let photo = row?;
        if let Some(set) = album_paths
            && !set.contains(&(drive_id.to_string(), photo.path.clone()))
        {
            continue;
        }
        // Format filter: SQLite instr finds the first '.', which breaks on
        // dotted directory names — refine in Rust when a format was requested.
        // `format` may be a single ext or a comma-separated list.
        if !format.is_empty() {
            let allowed: HashSet<String> = format
                .split(',')
                .map(normalize_format_ext)
                .filter(|s| !s.is_empty())
                .collect();
            let ext = normalize_format_ext(&path_ext_lower(&photo.path));
            if allowed.is_empty() || !allowed.contains(&ext) {
                continue;
            }
        }
        photos.push(photo);
    }
    Ok(photos)
}

pub fn list_places(mounts: &[(String, PathBuf)]) -> anyhow::Result<Vec<PlaceCluster>> {
    use std::collections::HashMap;
    let mut map: HashMap<String, PlaceCluster> = HashMap::new();
    for (drive_id, root) in mounts {
        if !gallery_db_path(root).exists() {
            continue;
        }
        let conn = match open_drive_db(root) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let mut stmt = conn.prepare(
            "SELECT lat, lon, place_label, path, has_thumb FROM photos
             WHERE lat IS NOT NULL AND lon IS NOT NULL",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, f64>(0)?,
                row.get::<_, f64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
            ))
        })?;
        for row in rows.flatten() {
            let (lat, lon, label, path, has_thumb) = row;
            let key = format!("{lat:.1},{lon:.1}");
            let entry = map.entry(key.clone()).or_insert_with(|| PlaceCluster {
                key: key.clone(),
                label: if label.is_empty() {
                    "Photos from this place".into()
                } else {
                    label.clone()
                },
                count: 0,
                lat,
                lon,
                cover_thumb: String::new(),
            });
            entry.count += 1;
            if !label.is_empty() && entry.label == "Photos from this place" {
                entry.label = label;
            }
            if entry.cover_thumb.is_empty() && has_thumb != 0 {
                entry.cover_thumb = thumb_url(drive_id, &path);
            }
        }
    }
    let mut out: Vec<_> = map.into_values().collect();
    out.sort_by_key(|b| std::cmp::Reverse(b.count));
    Ok(out)
}

pub fn list_place_markers(mounts: &[(String, PathBuf)]) -> anyhow::Result<Vec<PlaceMarker>> {
    let mut out = Vec::new();
    for (drive_id, root) in mounts {
        if !gallery_db_path(root).exists() {
            continue;
        }
        let conn = match open_drive_db(root) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let mut stmt = conn.prepare(
            "SELECT lat, lon, place_label, path, has_thumb FROM photos
             WHERE lat IS NOT NULL AND lon IS NOT NULL
             ORDER BY taken_at DESC, mtime DESC, path",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, f64>(0)?,
                row.get::<_, f64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
            ))
        })?;
        for row in rows.flatten() {
            let (lat, lon, label, path, has_thumb) = row;
            let key = place_key(lat, lon);
            out.push(PlaceMarker {
                key: key.clone(),
                id: format!("{drive_id}:{path}"),
                label: if label.is_empty() {
                    "Photos from this place".into()
                } else {
                    label
                },
                lat,
                lon,
                cover_thumb: if has_thumb != 0 {
                    thumb_url(drive_id, &path)
                } else {
                    String::new()
                },
            });
        }
    }
    Ok(out)
}

/// Distinct non-empty camera make/model pairs across mounts, ordered by count desc.
///
/// When `path_grants` is `Some`, only photos under those grant prefixes (per drive)
/// are counted — Members must not learn cameras from folders they cannot open.
/// `None` means unrestricted (Admin).
pub fn list_cameras(
    mounts: &[(String, PathBuf)],
    path_grants: Option<&std::collections::HashMap<String, Vec<String>>>,
) -> anyhow::Result<Vec<CameraCount>> {
    use std::collections::HashMap;
    let mut map: HashMap<(String, String), u64> = HashMap::new();
    for (drive_id, root) in mounts {
        if !gallery_db_path(root).exists() {
            continue;
        }
        let conn = match open_drive_db(root) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let prefixes = path_grants.and_then(|g| g.get(drive_id));
        let mut stmt = conn.prepare(
            "SELECT COALESCE(camera_make, ''), COALESCE(camera_model, ''), path
             FROM photos
             WHERE COALESCE(camera_make, '') != '' OR COALESCE(camera_model, '') != ''",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        for row in rows.flatten() {
            let (make, model, path) = row;
            if !path_allowed_by_grants(&path, prefixes) {
                continue;
            }
            *map.entry((make, model)).or_insert(0) += 1;
        }
    }
    let mut out: Vec<CameraCount> = map
        .into_iter()
        .map(|((make, model), count)| CameraCount { make, model, count })
        .collect();
    out.sort_by(|a, b| {
        b.count
            .cmp(&a.count)
            .then_with(|| a.make.cmp(&b.make))
            .then_with(|| a.model.cmp(&b.model))
    });
    Ok(out)
}

fn path_allowed_by_grants(path: &str, prefixes: Option<&Vec<String>>) -> bool {
    match prefixes {
        None => true,
        Some(prefs) => prefs
            .iter()
            .any(|p| crate::grants::path_contains(p, path)),
    }
}

/// Aggregate filter facet values (cameras, lenses, formats, ISO/focal ranges).
///
/// See [`list_cameras`] for `path_grants` semantics.
pub fn list_filter_facets(
    mounts: &[(String, PathBuf)],
    path_grants: Option<&std::collections::HashMap<String, Vec<String>>>,
) -> anyhow::Result<FilterFacets> {
    use std::collections::HashMap;
    let cameras = list_cameras(mounts, path_grants)?;
    let mut lenses: HashMap<String, u64> = HashMap::new();
    let mut formats: HashMap<String, u64> = HashMap::new();
    let mut iso_min: Option<u32> = None;
    let mut iso_max: Option<u32> = None;
    let mut focal_min: Option<f64> = None;
    let mut focal_max: Option<f64> = None;

    for (drive_id, root) in mounts {
        if !gallery_db_path(root).exists() {
            continue;
        }
        let conn = match open_drive_db(root) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let prefixes = path_grants.and_then(|g| g.get(drive_id));
        {
            let mut stmt = conn.prepare(
                "SELECT COALESCE(lens, ''), path FROM photos
                 WHERE COALESCE(lens, '') != ''",
            )?;
            let rows = stmt.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            for row in rows.flatten() {
                let (lens, path) = row;
                if !path_allowed_by_grants(&path, prefixes) {
                    continue;
                }
                *lenses.entry(lens).or_insert(0) += 1;
            }
        }
        {
            let mut stmt = conn.prepare("SELECT path FROM photos")?;
            let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
            for path in rows.flatten() {
                if !path_allowed_by_grants(&path, prefixes) {
                    continue;
                }
                let ext = normalize_format_ext(&path_ext_lower(&path));
                if ext.is_empty() {
                    continue;
                }
                *formats.entry(ext).or_insert(0) += 1;
            }
        }
        {
            let mut stmt =
                conn.prepare("SELECT iso, path FROM photos WHERE iso > 0")?;
            let rows = stmt.query_map([], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })?;
            for row in rows.flatten() {
                let (iso, path) = row;
                if !path_allowed_by_grants(&path, prefixes) {
                    continue;
                }
                let iso = iso.max(0) as u32;
                iso_min = Some(iso_min.map_or(iso, |v| v.min(iso)));
                iso_max = Some(iso_max.map_or(iso, |v| v.max(iso)));
            }
        }
        {
            let mut stmt =
                conn.prepare("SELECT focal_mm, path FROM photos WHERE focal_mm > 0")?;
            let rows = stmt.query_map([], |row| {
                Ok((row.get::<_, f64>(0)?, row.get::<_, String>(1)?))
            })?;
            for row in rows.flatten() {
                let (focal, path) = row;
                if !path_allowed_by_grants(&path, prefixes) {
                    continue;
                }
                focal_min = Some(focal_min.map_or(focal, |v| v.min(focal)));
                focal_max = Some(focal_max.map_or(focal, |v| v.max(focal)));
            }
        }
    }

    let mut lenses: Vec<LensCount> = lenses
        .into_iter()
        .map(|(lens, count)| LensCount { lens, count })
        .collect();
    lenses.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.lens.cmp(&b.lens)));

    let mut formats: Vec<FormatCount> = formats
        .into_iter()
        .map(|(ext, count)| FormatCount { ext, count })
        .collect();
    formats.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.ext.cmp(&b.ext)));

    let iso_range = match (iso_min, iso_max) {
        (Some(min), Some(max)) => Some(NumRange {
            min: min as f64,
            max: max as f64,
        }),
        _ => None,
    };
    let focal_range = match (focal_min, focal_max) {
        (Some(min), Some(max)) => Some(NumRange { min, max }),
        _ => None,
    };

    Ok(FilterFacets {
        cameras,
        lenses,
        formats,
        iso_range,
        focal_range,
    })
}

pub fn place_key(lat: f64, lon: f64) -> String {
    format!("{lat:.1},{lon:.1}")
}

/// Coarse offline place label from a tiny hardcoded city list (~150 km).
pub fn place_label_for(lat: f64, lon: f64) -> String {
    const CITIES: &[(&str, f64, f64)] = &[
        ("New York", 40.71, -74.01),
        ("Los Angeles", 34.05, -118.24),
        ("Chicago", 41.88, -87.63),
        ("Toronto", 43.65, -79.38),
        ("Mexico City", 19.43, -99.13),
        ("São Paulo", -23.55, -46.63),
        ("Buenos Aires", -34.60, -58.38),
        ("London", 51.51, -0.13),
        ("Paris", 48.86, 2.35),
        ("Berlin", 52.52, 13.41),
        ("Madrid", 40.42, -3.70),
        ("Rome", 41.90, 12.50),
        ("Moscow", 55.76, 37.62),
        ("Istanbul", 41.01, 28.98),
        ("Cairo", 30.04, 31.24),
        ("Lagos", 6.52, 3.38),
        ("Johannesburg", -26.20, 28.05),
        ("Dubai", 25.20, 55.27),
        ("Mumbai", 19.08, 72.88),
        ("Delhi", 28.61, 77.21),
        ("Bangkok", 13.76, 100.50),
        ("Singapore", 1.35, 103.82),
        ("Hong Kong", 22.32, 114.17),
        ("Shanghai", 31.23, 121.47),
        ("Beijing", 39.90, 116.41),
        ("Tokyo", 35.68, 139.69),
        ("Seoul", 37.57, 126.98),
        ("Sydney", -33.87, 151.21),
        ("Melbourne", -37.81, 144.96),
        ("Auckland", -36.85, 174.76),
    ];
    const MAX_KM: f64 = 150.0;
    let mut best: Option<(&str, f64)> = None;
    for (name, clat, clon) in CITIES {
        let d = haversine_km(lat, lon, *clat, *clon);
        if d <= MAX_KM {
            match best {
                Some((_, bd)) if d >= bd => {}
                _ => best = Some((*name, d)),
            }
        }
    }
    match best {
        Some((name, _)) => name.to_string(),
        None => format!("{lat:.1}°, {lon:.1}°"),
    }
}

fn haversine_km(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    const R: f64 = 6371.0;
    let to_rad = |d: f64| d * std::f64::consts::PI / 180.0;
    let (phi1, phi2) = (to_rad(lat1), to_rad(lat2));
    let d_phi = to_rad(lat2 - lat1);
    let d_lam = to_rad(lon2 - lon1);
    let a = (d_phi / 2.0).sin().powi(2) + phi1.cos() * phi2.cos() * (d_lam / 2.0).sin().powi(2);
    2.0 * R * a.sqrt().asin()
}

fn urlencode(input: &str) -> String {
    let mut out = String::new();
    for byte in input.as_bytes() {
        match *byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'/' => {
                out.push(*byte as char);
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

// --- Favorites / albums (on-drive library) ---

pub fn set_favorite(root: &Path, user_id: &str, path: &str, on: bool) -> anyhow::Result<()> {
    let conn = open_drive_db(root)?;
    if on {
        let now = now_unix();
        conn.execute(
            "INSERT INTO favorites (user_id, path, created_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(user_id, path) DO NOTHING",
            params![user_id, path, now],
        )?;
    } else {
        conn.execute(
            "DELETE FROM favorites WHERE user_id = ?1 AND path = ?2",
            params![user_id, path],
        )?;
    }
    Ok(())
}

pub fn set_archived(root: &Path, user_id: &str, path: &str, on: bool) -> anyhow::Result<()> {
    let conn = open_drive_db(root)?;
    if on {
        let now = now_unix();
        conn.execute(
            "INSERT INTO archive (user_id, path, created_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(user_id, path) DO NOTHING",
            params![user_id, path, now],
        )?;
    } else {
        conn.execute(
            "DELETE FROM archive WHERE user_id = ?1 AND path = ?2",
            params![user_id, path],
        )?;
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
pub struct Album {
    pub id: String,
    pub home_drive_id: String,
    pub owner_user_id: String,
    pub name: String,
    pub created_at: i64,
    pub cover_path: String,
    pub cover_drive_id: String,
    pub cover_thumb: String,
    pub shared: bool,
    pub allow_uploads: bool,
    pub contrib_path: String,
    pub locked: bool,
    pub item_count: u64,
}

fn album_cover_thumb(home_drive_id: &str, cover_drive_id: &str, cover_path: &str) -> String {
    if cover_path.is_empty() {
        return String::new();
    }
    let drive = if cover_drive_id.is_empty() {
        home_drive_id
    } else {
        cover_drive_id
    };
    thumb_url(drive, cover_path)
}

pub fn list_albums(
    mounts: &[(String, PathBuf)],
    user_id: &str,
    include_all: bool,
) -> anyhow::Result<Vec<Album>> {
    let mut out = Vec::new();
    for (drive_id, root) in mounts {
        if !gallery_db_path(root).exists() {
            continue;
        }
        let conn = match open_drive_db(root) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let sql = if include_all {
            "SELECT a.id, a.owner_user_id, a.name, a.created_at, a.cover_path, a.cover_drive_id,
                    a.shared, a.allow_uploads, a.contrib_path, a.locked,
                    (SELECT COUNT(*) FROM album_items i WHERE i.album_id = a.id)
             FROM albums a
             ORDER BY a.created_at DESC"
        } else {
            "SELECT a.id, a.owner_user_id, a.name, a.created_at, a.cover_path, a.cover_drive_id,
                    a.shared, a.allow_uploads, a.contrib_path, a.locked,
                    (SELECT COUNT(*) FROM album_items i WHERE i.album_id = a.id)
             FROM albums a
             WHERE a.owner_user_id = ?1
                OR EXISTS (SELECT 1 FROM album_members m WHERE m.album_id = a.id AND m.user_id = ?1)
             ORDER BY a.created_at DESC"
        };
        let mut stmt = conn.prepare(sql)?;
        let map_row = |row: &rusqlite::Row<'_>| -> rusqlite::Result<Album> {
            let cover_path: String = row.get(4)?;
            let cover_drive_id: String = row.get(5)?;
            Ok(Album {
                id: row.get(0)?,
                home_drive_id: drive_id.clone(),
                owner_user_id: row.get(1)?,
                name: row.get(2)?,
                created_at: row.get(3)?,
                cover_thumb: album_cover_thumb(drive_id, &cover_drive_id, &cover_path),
                cover_path,
                cover_drive_id,
                shared: row.get::<_, i64>(6)? != 0,
                allow_uploads: row.get::<_, i64>(7)? != 0,
                contrib_path: row.get(8)?,
                locked: row.get::<_, i64>(9)? != 0,
                item_count: row.get::<_, i64>(10)? as u64,
            })
        };
        if include_all {
            let rows = stmt.query_map([], map_row)?;
            for row in rows {
                out.push(row?);
            }
        } else {
            let rows = stmt.query_map(params![user_id], map_row)?;
            for row in rows {
                out.push(row?);
            }
        }
    }
    out.sort_by_key(|b| std::cmp::Reverse(b.created_at));
    Ok(out)
}

pub fn create_album(
    root: &Path,
    home_drive_id: &str,
    owner_user_id: &str,
    name: &str,
) -> anyhow::Result<Album> {
    let conn = open_drive_db(root)?;
    let id = uuid_v4();
    let now = now_unix();
    conn.execute(
        "INSERT INTO albums (id, owner_user_id, name, created_at, shared, allow_uploads, contrib_path, cover_drive_id, locked)
         VALUES (?1, ?2, ?3, ?4, 0, 0, '', '', 0)",
        params![id, owner_user_id, name, now],
    )?;
    Ok(Album {
        id,
        home_drive_id: home_drive_id.to_string(),
        owner_user_id: owner_user_id.to_string(),
        name: name.to_string(),
        created_at: now,
        cover_path: String::new(),
        cover_drive_id: String::new(),
        cover_thumb: String::new(),
        shared: false,
        allow_uploads: false,
        contrib_path: String::new(),
        locked: false,
        item_count: 0,
    })
}

/// Allocate and create a user-accessible upload folder for a shared album.
///
/// Ensures we never write into an existing user folder that wasn't created for
/// this album. Tries:
///   1. "Shared Photos/{Album Name}"
///   2. "Shared Photos/{Album Name} (2)" .. "(50)"
///   3. "Shared Photos/{Album Name} - {uuid}" (loop until free)
///
/// Persists the selected path in SQLite (`albums.contrib_path`) and creates
/// the directory on disk.
pub fn allocate_contrib_dir(
    root: &Path,
    album_id: &str,
    album_name: &str,
) -> anyhow::Result<String> {
    let conn = open_drive_db(root)?;
    // If already allocated for this album, verify it exists and return it.
    let existing: Option<String> = conn
        .query_row(
            "SELECT contrib_path FROM albums WHERE id = ?1",
            params![album_id],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(path) = existing
        && !path.trim().is_empty()
    {
        let target = root.join(&path);
        if !target.exists() {
            std::fs::create_dir_all(&target)?;
        }
        return Ok(path);
    }

    // Clean and sanitize the album name for the filesystem.
    let sanitized: String = album_name
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                ' '
            } else {
                c
            }
        })
        .collect();
    let sanitized: String = sanitized.split_whitespace().collect::<Vec<_>>().join(" ");
    let base_name = if sanitized.is_empty() {
        "Album".to_string()
    } else {
        sanitized.chars().take(60).collect()
    };

    let check_collision = |cand: &str| -> anyhow::Result<bool> {
        let p = root.join(cand);
        if p.exists() {
            return Ok(true);
        }
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM albums WHERE contrib_path = ?1 AND id != ?2",
            params![cand, album_id],
            |row| row.get(0),
        )?;
        Ok(count > 0)
    };

    let base_cand = format!("{USER_SHARED_ALBUMS_DIR}/{base_name}");
    let mut chosen = None;

    if !check_collision(&base_cand)? {
        chosen = Some(base_cand);
    } else {
        for i in 2..=50 {
            let cand = format!("{USER_SHARED_ALBUMS_DIR}/{base_name} ({i})");
            if !check_collision(&cand)? {
                chosen = Some(cand);
                break;
            }
        }
    }

    let chosen_path = match chosen {
        Some(c) => c,
        None => loop {
            let short_id = &uuid_v4().replace('-', "")[..8];
            let cand = format!("{USER_SHARED_ALBUMS_DIR}/{base_name} - {short_id}");
            if !check_collision(&cand)? {
                break cand;
            }
        },
    };

    std::fs::create_dir_all(root.join(&chosen_path))?;
    conn.execute(
        "UPDATE albums SET contrib_path = ?1 WHERE id = ?2",
        params![chosen_path, album_id],
    )?;

    Ok(chosen_path)
}

pub fn get_album(
    root: &Path,
    home_drive_id: &str,
    album_id: &str,
) -> anyhow::Result<Option<Album>> {
    let conn = open_drive_db(root)?;
    conn.query_row(
        "SELECT id, owner_user_id, name, created_at, cover_path, cover_drive_id, shared,
                allow_uploads, contrib_path, locked,
                (SELECT COUNT(*) FROM album_items i WHERE i.album_id = albums.id)
         FROM albums WHERE id = ?1",
        params![album_id],
        |row| {
            let cover_path: String = row.get(4)?;
            let cover_drive_id: String = row.get(5)?;
            Ok(Album {
                id: row.get(0)?,
                home_drive_id: home_drive_id.to_string(),
                owner_user_id: row.get(1)?,
                name: row.get(2)?,
                created_at: row.get(3)?,
                cover_thumb: album_cover_thumb(home_drive_id, &cover_drive_id, &cover_path),
                cover_path,
                cover_drive_id,
                shared: row.get::<_, i64>(6)? != 0,
                allow_uploads: row.get::<_, i64>(7)? != 0,
                contrib_path: row.get(8)?,
                locked: row.get::<_, i64>(9)? != 0,
                item_count: row.get::<_, i64>(10)? as u64,
            })
        },
    )
    .optional()
    .map_err(Into::into)
}

pub fn delete_invites_for_album(root: &Path, album_id: &str) -> anyhow::Result<()> {
    let conn = open_drive_db(root)?;
    conn.execute(
        "DELETE FROM album_invites WHERE album_id = ?1",
        params![album_id],
    )?;
    Ok(())
}

pub fn update_album(
    root: &Path,
    album_id: &str,
    name: Option<&str>,
    shared: Option<bool>,
    allow_uploads: Option<bool>,
    locked: Option<bool>,
    cover: Option<(String, String)>,
) -> anyhow::Result<()> {
    let conn = open_drive_db(root)?;
    if let Some(name) = name {
        conn.execute(
            "UPDATE albums SET name = ?1 WHERE id = ?2",
            params![name, album_id],
        )?;
    }
    if let Some(shared) = shared {
        conn.execute(
            "UPDATE albums SET shared = ?1 WHERE id = ?2",
            params![if shared { 1 } else { 0 }, album_id],
        )?;
        if !shared {
            conn.execute(
                "DELETE FROM album_invites WHERE album_id = ?1",
                params![album_id],
            )?;
        }
    }
    if let Some(allow) = allow_uploads {
        conn.execute(
            "UPDATE albums SET allow_uploads = ?1 WHERE id = ?2",
            params![if allow { 1 } else { 0 }, album_id],
        )?;
    }
    if let Some(locked) = locked {
        conn.execute(
            "UPDATE albums SET locked = ?1 WHERE id = ?2",
            params![if locked { 1 } else { 0 }, album_id],
        )?;
    }
    if let Some((drive_id, path)) = cover {
        conn.execute(
            "UPDATE albums SET cover_path = ?1, cover_drive_id = ?2 WHERE id = ?3",
            params![path, drive_id, album_id],
        )?;
    }
    Ok(())
}

pub fn delete_album(root: &Path, album_id: &str) -> anyhow::Result<()> {
    let conn = open_drive_db(root)?;
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "DELETE FROM album_items WHERE album_id = ?1",
        params![album_id],
    )?;
    tx.execute(
        "DELETE FROM album_members WHERE album_id = ?1",
        params![album_id],
    )?;
    tx.execute(
        "DELETE FROM album_invites WHERE album_id = ?1",
        params![album_id],
    )?;
    tx.execute("DELETE FROM albums WHERE id = ?1", params![album_id])?;
    tx.commit()?;
    Ok(())
}

pub fn add_album_items(
    root: &Path,
    album_id: &str,
    items: &[(String, String)],
) -> anyhow::Result<()> {
    let conn = open_drive_db(root)?;
    let now = now_unix();
    let tx = conn.unchecked_transaction()?;
    for (drive_id, path) in items {
        tx.execute(
            "INSERT INTO album_items (album_id, drive_id, path, added_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT DO NOTHING",
            params![album_id, drive_id, path, now],
        )?;
    }
    // Set cover if empty.
    let cover: String = tx
        .query_row(
            "SELECT cover_path FROM albums WHERE id = ?1",
            params![album_id],
            |row| row.get(0),
        )
        .unwrap_or_default();
    if cover.is_empty()
        && let Some((drive_id, path)) = items.first()
    {
        tx.execute(
            "UPDATE albums SET cover_path = ?1, cover_drive_id = ?2 WHERE id = ?3",
            params![path, drive_id, album_id],
        )?;
    }
    tx.commit()?;
    Ok(())
}

pub fn remove_album_item(
    root: &Path,
    album_id: &str,
    drive_id: &str,
    path: &str,
) -> anyhow::Result<()> {
    let conn = open_drive_db(root)?;
    let (cover_path, cover_drive_id): (String, String) = conn
        .query_row(
            "SELECT cover_path, cover_drive_id FROM albums WHERE id = ?1",
            params![album_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap_or_default();
    conn.execute(
        "DELETE FROM album_items WHERE album_id = ?1 AND drive_id = ?2 AND path = ?3",
        params![album_id, drive_id, path],
    )?;
    let was_cover = cover_path == path && (cover_drive_id.is_empty() || cover_drive_id == drive_id);
    if was_cover {
        let next: Option<(String, String)> = conn
            .query_row(
                "SELECT drive_id, path FROM album_items
                 WHERE album_id = ?1
                 ORDER BY added_at ASC, path ASC
                 LIMIT 1",
                params![album_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        match next {
            Some((next_drive, next_path)) => {
                conn.execute(
                    "UPDATE albums SET cover_path = ?1, cover_drive_id = ?2 WHERE id = ?3",
                    params![next_path, next_drive, album_id],
                )?;
            }
            None => {
                conn.execute(
                    "UPDATE albums SET cover_path = '', cover_drive_id = '' WHERE id = ?1",
                    params![album_id],
                )?;
            }
        }
    }
    Ok(())
}

/// Delete album_items on this drive that reference a path (local drive_id match).
pub fn remove_album_items_for_path(root: &Path, drive_id: &str, path: &str) -> anyhow::Result<()> {
    let conn = open_drive_db(root)?;
    // Refresh covers for albums that used this path as cover before deleting.
    let albums: Vec<String> = {
        let mut stmt = conn.prepare(
            "SELECT id FROM albums
             WHERE cover_path = ?1 AND (cover_drive_id = ?2 OR cover_drive_id = '')",
        )?;
        let rows = stmt.query_map(params![path, drive_id], |row| row.get(0))?;
        rows.filter_map(|r| r.ok()).collect()
    };
    conn.execute(
        "DELETE FROM album_items WHERE drive_id = ?1 AND path = ?2",
        params![drive_id, path],
    )?;
    for album_id in albums {
        let next: Option<(String, String)> = conn
            .query_row(
                "SELECT drive_id, path FROM album_items
                 WHERE album_id = ?1
                 ORDER BY added_at ASC, path ASC
                 LIMIT 1",
                params![album_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        match next {
            Some((next_drive, next_path)) => {
                conn.execute(
                    "UPDATE albums SET cover_path = ?1, cover_drive_id = ?2 WHERE id = ?3",
                    params![next_path, next_drive, album_id],
                )?;
            }
            None => {
                conn.execute(
                    "UPDATE albums SET cover_path = '', cover_drive_id = '' WHERE id = ?1",
                    params![album_id],
                )?;
            }
        }
    }
    Ok(())
}

/// Purge album_item refs for a path from the album home drive (cross-drive cleanup).
pub fn purge_album_item_refs_on_home(
    home_root: &Path,
    drive_id: &str,
    path: &str,
) -> anyhow::Result<()> {
    remove_album_items_for_path(home_root, drive_id, path)
}

/// List `(drive_id, path)` rows for an album (home drive SQLite).
pub fn list_album_item_refs(
    home_root: &Path,
    album_id: &str,
) -> anyhow::Result<Vec<(String, String)>> {
    let conn = open_drive_db(home_root)?;
    let mut stmt =
        conn.prepare("SELECT drive_id, path FROM album_items WHERE album_id = ?1 ORDER BY added_at ASC, path ASC")?;
    let rows = stmt.query_map(params![album_id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// True when path is HEIC/HEIF/HIF (browser cannot display the original).
pub fn is_heic_image(path: &Path) -> bool {
    is_image(path) && crate::heif::is_heif(path)
}

/// Minimum JPEG thumb size (bytes) we treat as a usable browser preview.
const PREVIEW_THUMB_MIN_BYTES: u64 = 2048;

/// Ensure a browser-safe JPEG exists for a HEIC original (reuse thumb when large enough).
pub fn ensure_heic_preview_jpeg(src: &Path, thumb_dest: &Path) -> anyhow::Result<PathBuf> {
    if thumb_dest.exists()
        && let Ok(meta) = std::fs::metadata(thumb_dest)
        && meta.len() >= PREVIEW_THUMB_MIN_BYTES
    {
        return Ok(thumb_dest.to_path_buf());
    }
    ensure_thumb(src, thumb_dest, "image")?;
    if thumb_dest.exists() {
        return Ok(thumb_dest.to_path_buf());
    }
    anyhow::bail!("could not build HEIC preview")
}

/// Write a zip of absolute files. `entries` is `(archive_path, absolute_file)`.
/// Caps at `max_files` (returns Err on overflow).
pub fn write_items_zip(
    entries: &[(String, PathBuf)],
    writer: impl std::io::Write + std::io::Seek,
    max_files: usize,
) -> anyhow::Result<usize> {
    use std::io::{Read, Write};
    use zip::write::SimpleFileOptions;
    use zip::{CompressionMethod, ZipWriter};

    if entries.len() > max_files {
        anyhow::bail!("too many files for zip (max {max_files})");
    }
    let mut zip = ZipWriter::new(writer);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    let mut file_count = 0usize;
    let mut buf = vec![0u8; 64 * 1024];
    for (archive_name, abs) in entries {
        let meta = std::fs::symlink_metadata(abs)?;
        if meta.file_type().is_symlink() || !meta.is_file() {
            continue;
        }
        zip.start_file(archive_name, options)?;
        let mut input = std::fs::File::open(abs)?;
        loop {
            let n = input.read(&mut buf)?;
            if n == 0 {
                break;
            }
            zip.write_all(&buf[..n])?;
        }
        file_count += 1;
    }
    zip.finish()?;
    Ok(file_count)
}

#[derive(Debug, Clone, Serialize)]
pub struct AlbumMember {
    pub user_id: String,
    pub role: String,
}

pub fn list_members(root: &Path, album_id: &str) -> anyhow::Result<Vec<AlbumMember>> {
    let conn = open_drive_db(root)?;
    let mut stmt = conn.prepare("SELECT user_id, role FROM album_members WHERE album_id = ?1")?;
    let rows = stmt.query_map(params![album_id], |row| {
        Ok(AlbumMember {
            user_id: row.get(0)?,
            role: row.get(1)?,
        })
    })?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub fn upsert_member(root: &Path, album_id: &str, user_id: &str, role: &str) -> anyhow::Result<()> {
    let conn = open_drive_db(root)?;
    conn.execute(
        "INSERT INTO album_members (album_id, user_id, role) VALUES (?1, ?2, ?3)
         ON CONFLICT(album_id, user_id) DO UPDATE SET role = excluded.role",
        params![album_id, user_id, role],
    )?;
    Ok(())
}

pub fn remove_member(root: &Path, album_id: &str, user_id: &str) -> anyhow::Result<()> {
    let conn = open_drive_db(root)?;
    conn.execute(
        "DELETE FROM album_members WHERE album_id = ?1 AND user_id = ?2",
        params![album_id, user_id],
    )?;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
pub struct AlbumInvite {
    pub id: String,
    pub album_id: String,
    pub token: String,
    pub role: String,
    pub expires_at: Option<i64>,
    pub created_at: i64,
    pub url: String,
}

pub fn create_invite(
    root: &Path,
    album_id: &str,
    role: &str,
    expires_at: Option<i64>,
    password_hash: Option<&str>,
) -> anyhow::Result<AlbumInvite> {
    let conn = open_drive_db(root)?;
    let id = uuid_v4();
    let token = uuid_v4().replace('-', "");
    let now = now_unix();
    conn.execute(
        "INSERT INTO album_invites (id, album_id, token, role, expires_at, password_hash, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![id, album_id, token, role, expires_at, password_hash, now],
    )?;
    Ok(AlbumInvite {
        id,
        album_id: album_id.to_string(),
        url: format!("/a/{token}"),
        token,
        role: role.to_string(),
        expires_at,
        created_at: now,
    })
}

pub fn delete_invite(root: &Path, invite_id: &str) -> anyhow::Result<()> {
    let conn = open_drive_db(root)?;
    conn.execute(
        "DELETE FROM album_invites WHERE id = ?1",
        params![invite_id],
    )?;
    Ok(())
}

pub fn list_invites(root: &Path, album_id: &str) -> anyhow::Result<Vec<AlbumInvite>> {
    let conn = open_drive_db(root)?;
    let mut stmt = conn.prepare(
        "SELECT id, album_id, token, role, expires_at, created_at
         FROM album_invites
         WHERE album_id = ?1
         ORDER BY created_at DESC",
    )?;
    let rows = stmt.query_map(params![album_id], |row| {
        let token: String = row.get(2)?;
        Ok(AlbumInvite {
            id: row.get(0)?,
            album_id: row.get(1)?,
            url: format!("/a/{token}"),
            token,
            role: row.get(3)?,
            expires_at: row.get(4)?,
            created_at: row.get(5)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// Find an invite by token across mounted drives. Returns (home_drive_id, root, invite, album).
pub fn find_invite(
    mounts: &[(String, PathBuf)],
    token: &str,
) -> anyhow::Result<Option<(String, PathBuf, AlbumInvite, Album)>> {
    let now = now_unix();
    for (drive_id, root) in mounts {
        if !gallery_db_path(root).exists() {
            continue;
        }
        let conn = match open_drive_db(root) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let found = conn
            .query_row(
                "SELECT id, album_id, token, role, expires_at, created_at
                 FROM album_invites WHERE token = ?1",
                params![token],
                |row| {
                    Ok(AlbumInvite {
                        id: row.get(0)?,
                        album_id: row.get(1)?,
                        token: row.get(2)?,
                        role: row.get(3)?,
                        expires_at: row.get(4)?,
                        created_at: row.get(5)?,
                        url: format!("/a/{}", token),
                    })
                },
            )
            .optional()?;
        let Some(invite) = found else {
            continue;
        };
        if let Some(exp) = invite.expires_at
            && exp < now
        {
            continue;
        }
        let Some(album) = get_album(root, drive_id, &invite.album_id)? else {
            continue;
        };
        if !album.shared {
            continue;
        }
        return Ok(Some((drive_id.clone(), root.clone(), invite, album)));
    }
    Ok(None)
}

pub fn user_can_access_album(root: &Path, album: &Album, user_id: &str) -> anyhow::Result<bool> {
    if album.owner_user_id == user_id {
        return Ok(true);
    }
    let conn = open_drive_db(root)?;
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM album_members WHERE album_id = ?1 AND user_id = ?2",
        params![album.id, user_id],
        |row| row.get(0),
    )?;
    Ok(n > 0)
}

/// True when `path` on `drive_id` is in an album this user owns, joined, or (Admin) any album.
///
/// Used so Members can open photos through album membership without a folder grant.
pub fn user_can_view_path_via_album(
    mounts: &[(String, PathBuf)],
    user_id: &str,
    as_admin: bool,
    drive_id: &str,
    path: &str,
) -> bool {
    for (home, root) in mounts {
        if !gallery_db_path(root).exists() {
            continue;
        }
        let Ok(conn) = open_drive_db(root) else {
            continue;
        };
        let Ok(mut stmt) = conn.prepare(
            "SELECT a.id, a.owner_user_id, a.contrib_path
             FROM albums a
             WHERE EXISTS (
                 SELECT 1 FROM album_items i
                 WHERE i.album_id = a.id AND i.drive_id = ?1 AND i.path = ?2
             )
             OR (
                 a.contrib_path != ''
                 AND ?1 = ?3
                 AND (
                     ?2 = a.contrib_path
                     OR ?2 LIKE (a.contrib_path || '/%')
                 )
             )",
        ) else {
            continue;
        };
        let Ok(rows) = stmt.query_map(params![drive_id, path, home.as_str()], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        }) else {
            continue;
        };
        for row in rows.flatten() {
            let (album_id, owner_user_id, _contrib) = row;
            if as_admin || owner_user_id == user_id {
                return true;
            }
            let n: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM album_members WHERE album_id = ?1 AND user_id = ?2",
                    params![album_id, user_id],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            if n > 0 {
                return true;
            }
        }
    }
    false
}

pub fn user_can_contribute(root: &Path, album: &Album, user_id: &str) -> anyhow::Result<bool> {
    if album.owner_user_id == user_id {
        return Ok(true);
    }
    if !album.allow_uploads {
        return Ok(false);
    }
    let conn = open_drive_db(root)?;
    let role: Option<String> = conn
        .query_row(
            "SELECT role FROM album_members WHERE album_id = ?1 AND user_id = ?2",
            params![album.id, user_id],
            |row| row.get(0),
        )
        .optional()?;
    Ok(matches!(role.as_deref(), Some("contributor")))
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn uuid_v4() -> String {
    uuid::Uuid::new_v4().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thumbnails_png_and_reuses_cached() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("photo.png");
        let img = image::RgbaImage::from_pixel(800, 600, image::Rgba([120, 120, 120, 255]));
        img.save(&src).unwrap();
        let dest = dir.path().join("thumb.jpg");

        let (w, h, made) = ensure_thumb(&src, &dest, "image").unwrap();
        assert_eq!((w, h), (800, 600));
        assert!(made && dest.exists());

        let (_, _, made_again) = ensure_thumb(&src, &dest, "image").unwrap();
        assert!(!made_again, "cached thumbs are not regenerated");
    }

    #[test]
    fn image_and_video_extension_detection() {
        assert!(is_image(Path::new("photo.JPG")));
        assert!(is_image(Path::new("a/b/photo.png")));
        assert!(is_image(Path::new("IMG_0001.HEIC")));
        assert!(is_video(Path::new("clip.mp4")));
        assert!(is_media(Path::new("clip.MOV")));
        assert!(!is_image(Path::new("video.mp4")));
        assert!(!is_media(Path::new("notes.txt")));
    }

    #[test]
    fn video_thumb_temp_path_uses_jpg_extension() {
        let dest = PathBuf::from("/drive/.lunathumbs/abc.jpg");
        let tmp = dest.with_extension("vidtmp.jpg");
        assert_eq!(
            tmp.extension().and_then(|e| e.to_str()),
            Some("jpg"),
            "ffmpeg needs a real image extension to pick a muxer"
        );
        // The old `with_extension("vid.jpg.tmp")` produced `abc.vid.jpg.tmp`.
        let broken = dest.with_extension("vid.jpg.tmp");
        assert_eq!(
            broken.extension().and_then(|e| e.to_str()),
            Some("tmp"),
            "regression guard: .tmp must not be the final extension"
        );
    }

    #[test]
    fn thumbnails_video_with_ffmpeg_when_available() {
        let Some(ffmpeg) = which_ffmpeg() else {
            eprintln!("skip: ffmpeg not on PATH");
            return;
        };
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("clip.mp4");
        let status = std::process::Command::new(&ffmpeg)
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                "color=c=red:s=320x240:d=1",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
            ])
            .arg(&src)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .expect("spawn ffmpeg to build fixture");
        if !status.success() || !src.exists() {
            eprintln!("skip: could not encode fixture mp4 with this ffmpeg");
            return;
        }

        let dest = dir.path().join("thumb.jpg");
        let (_w, _h, made) = ensure_thumb(&src, &dest, "video").expect("video thumb");
        assert!(made && dest.exists());
        let bytes = std::fs::read(&dest).unwrap();
        assert!(
            bytes.len() > 32,
            "expected a non-trivial JPEG preview, got {} bytes",
            bytes.len()
        );
        // JPEG SOI marker
        assert_eq!(&bytes[0..2], &[0xff, 0xd8]);

        let (_, _, made_again) = ensure_thumb(&src, &dest, "video").unwrap();
        assert!(!made_again, "cached video thumbs are not regenerated");
    }

    #[test]
    fn scan_writes_index_on_drive_not_emmc() {
        let dir = tempfile::tempdir().unwrap();
        let photos_dir = dir.path().join("photos");
        let os_data = dir.path().join("os-data");
        std::fs::create_dir(&photos_dir).unwrap();
        std::fs::create_dir(&os_data).unwrap();
        let src = photos_dir.join("same.png");
        let png = image::RgbaImage::from_pixel(16, 16, image::Rgba([9, 9, 9, 255]));
        png.save(&src).unwrap();

        let first = scan_drive("d1", &photos_dir).unwrap();
        assert_eq!(first.found, 1);
        assert_eq!(first.thumbnailed, 1);
        assert!(gallery_db_path(&photos_dir).exists());
        assert!(
            thumbs_dir(&photos_dir).read_dir().unwrap().next().is_some(),
            "thumbs must land under the photo drive's .lunathumbs"
        );
        assert!(
            !os_data.join(GALLERY_DIR_NAME).exists(),
            "gallery DB must not land under OS data dir"
        );

        let second = scan_drive("d1", &photos_dir).unwrap();
        assert_eq!(second.found, 1);
        assert_eq!(second.thumbnailed, 0);

        let mounts = vec![("d1".into(), photos_dir.clone())];
        let page = list_photos(&mounts, None, &ListFilter::default(), 10, 0).unwrap();
        assert_eq!(page.items.len(), 1);
        assert!(!page.has_more);
    }

    #[test]
    fn scan_sorts_by_exif_not_mtime() {
        let dir = tempfile::tempdir().unwrap();
        let photos_dir = dir.path().join("photos");
        std::fs::create_dir(&photos_dir).unwrap();
        let recent = photos_dir.join("recent.png");
        let dated = photos_dir.join("from-phone.jpg");
        std::fs::write(
            &dated,
            crate::exif::jpeg_with_datetime_original("2010:01:01 00:00:00"),
        )
        .unwrap();
        let png = image::RgbaImage::from_pixel(8, 8, image::Rgba([1, 2, 3, 255]));
        png.save(&recent).unwrap();

        scan_drive("d1", &photos_dir).unwrap();
        let mounts = vec![("d1".into(), photos_dir)];
        let page = list_photos(&mounts, Some("d1"), &ListFilter::default(), 10, 0).unwrap();
        assert_eq!(page.items.len(), 2);
        assert_eq!(page.items[0].name, "recent.png");
        assert_eq!(page.items[1].name, "from-phone.jpg");
        assert_eq!(
            page.items[1].taken_at,
            crate::exif::parse_exif_datetime("2010:01:01 00:00:00").unwrap()
        );
    }

    #[test]
    fn prune_removes_deleted_files() {
        let dir = tempfile::tempdir().unwrap();
        let photos_dir = dir.path().join("photos");
        std::fs::create_dir(&photos_dir).unwrap();
        let a = photos_dir.join("a.png");
        let b = photos_dir.join("b.png");
        let png = image::RgbaImage::from_pixel(4, 4, image::Rgba([1, 1, 1, 255]));
        png.save(&a).unwrap();
        png.save(&b).unwrap();
        scan_drive("d1", &photos_dir).unwrap();
        std::fs::remove_file(&b).unwrap();
        let report = scan_drive("d1", &photos_dir).unwrap();
        assert_eq!(report.pruned, 1);
        let mounts = vec![("d1".into(), photos_dir)];
        let page = list_photos(&mounts, None, &ListFilter::default(), 10, 0).unwrap();
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].name, "a.png");
    }

    #[test]
    fn favorites_and_albums_live_on_drive() {
        let dir = tempfile::tempdir().unwrap();
        let photos_dir = dir.path().join("photos");
        std::fs::create_dir(&photos_dir).unwrap();
        let png = image::RgbaImage::from_pixel(4, 4, image::Rgba([2, 2, 2, 255]));
        png.save(photos_dir.join("x.png")).unwrap();
        scan_drive("d1", &photos_dir).unwrap();

        set_favorite(&photos_dir, "u1", "x.png", true).unwrap();
        let mounts = vec![("d1".into(), photos_dir.clone())];
        let filter = ListFilter {
            favorites_user: Some("u1".into()),
            user_id: Some("u1".into()),
            ..Default::default()
        };
        let page = list_photos(&mounts, None, &filter, 10, 0).unwrap();
        assert_eq!(page.items.len(), 1);
        assert!(page.items[0].favorited);

        let album = create_album(&photos_dir, "d1", "u1", "Trip").unwrap();
        add_album_items(&photos_dir, &album.id, &[("d1".into(), "x.png".into())]).unwrap();
        let albums = list_albums(&mounts, "u1", false).unwrap();
        assert_eq!(albums.len(), 1);
        assert_eq!(albums[0].item_count, 1);

        let in_album = list_photos(
            &mounts,
            None,
            &ListFilter {
                album_membership: Some("any".into()),
                ..Default::default()
            },
            10,
            0,
        )
        .unwrap();
        assert_eq!(in_album.items.len(), 1);
        assert_eq!(in_album.items[0].path, "x.png");

        let not_in_album = list_photos(
            &mounts,
            None,
            &ListFilter {
                album_membership: Some("none".into()),
                ..Default::default()
            },
            10,
            0,
        )
        .unwrap();
        assert!(not_in_album.items.is_empty());
    }

    #[test]
    fn list_duplicates_groups_same_name_and_size() {
        let dir = tempfile::tempdir().unwrap();
        let photos_dir = dir.path().join("photos");
        std::fs::create_dir(&photos_dir).unwrap();
        let png = image::RgbaImage::from_pixel(4, 4, image::Rgba([2, 2, 2, 255]));
        png.save(photos_dir.join("copy.png")).unwrap();
        std::fs::create_dir(photos_dir.join("other")).unwrap();
        png.save(photos_dir.join("other/copy.png")).unwrap();
        let other = image::RgbaImage::from_pixel(4, 4, image::Rgba([9, 9, 9, 255]));
        other.save(photos_dir.join("unique.png")).unwrap();
        scan_drive("d1", &photos_dir).unwrap();
        let mounts = vec![("d1".into(), photos_dir)];
        let groups = list_duplicates(&mounts, 50).unwrap();
        assert!(
            groups
                .iter()
                .any(|g| g.name == "copy.png" && g.items.len() == 2),
            "expected copy.png duplicate group, got {:?}",
            groups
        );
        assert!(!groups.iter().any(|g| g.name == "unique.png"));
    }

    #[test]
    fn oversized_source_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("huge.bin.jpg");
        std::fs::write(&src, vec![0u8; 64]).unwrap();
        assert!(read_capped(&src, 10).is_err());
        assert!(read_capped(&src, 64).is_ok());
    }

    #[test]
    fn merge_lists_across_drives() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a");
        let b = dir.path().join("b");
        std::fs::create_dir(&a).unwrap();
        std::fs::create_dir(&b).unwrap();
        let png = image::RgbaImage::from_pixel(4, 4, image::Rgba([3, 3, 3, 255]));
        png.save(a.join("a.png")).unwrap();
        png.save(b.join("b.png")).unwrap();
        scan_drive("da", &a).unwrap();
        scan_drive("db", &b).unwrap();
        let mounts = vec![("da".into(), a), ("db".into(), b)];
        let page = list_photos(&mounts, None, &ListFilter::default(), 10, 0).unwrap();
        assert_eq!(page.items.len(), 2);
    }

    #[test]
    fn camera_make_model_indexed_and_filtered() {
        let dir = tempfile::tempdir().unwrap();
        let photos_dir = dir.path().join("photos");
        std::fs::create_dir(&photos_dir).unwrap();
        std::fs::write(
            photos_dir.join("canon.jpg"),
            crate::exif::jpeg_with_exif("2020:01:02 03:04:05", Some("Canon"), Some("EOS R5")),
        )
        .unwrap();
        std::fs::write(
            photos_dir.join("nikon.jpg"),
            crate::exif::jpeg_with_exif(
                "2020:02:03 04:05:06",
                Some("NIKON CORPORATION"),
                Some("NIKON D850"),
            ),
        )
        .unwrap();
        let png = image::RgbaImage::from_pixel(4, 4, image::Rgba([4, 4, 4, 255]));
        png.save(photos_dir.join("plain.png")).unwrap();
        scan_drive("d1", &photos_dir).unwrap();
        let mounts = vec![("d1".into(), photos_dir.clone())];

        let cameras = list_cameras(&mounts, None).unwrap();
        assert!(
            cameras
                .iter()
                .any(|c| c.make == "Canon" && c.model == "EOS R5" && c.count >= 1),
            "expected Canon EOS R5 in {cameras:?}"
        );
        assert!(
            cameras
                .iter()
                .any(|c| c.make == "NIKON CORPORATION" && c.model == "NIKON D850" && c.count >= 1),
            "expected Nikon in {cameras:?}"
        );

        let filtered = list_photos(
            &mounts,
            None,
            &ListFilter {
                camera_make: Some("canon".into()),
                camera_model: Some("eos r5".into()),
                ..Default::default()
            },
            10,
            0,
        )
        .unwrap();
        assert_eq!(filtered.items.len(), 1);
        assert_eq!(filtered.items[0].name, "canon.jpg");
        assert_eq!(filtered.items[0].camera_make, "Canon");
        assert_eq!(filtered.items[0].camera_model, "EOS R5");

        let by_q = list_photos(
            &mounts,
            None,
            &ListFilter {
                q: Some("nikon".into()),
                ..Default::default()
            },
            10,
            0,
        )
        .unwrap();
        assert_eq!(by_q.items.len(), 1);
        assert_eq!(by_q.items[0].name, "nikon.jpg");
    }

    #[test]
    fn list_cameras_respects_path_grants() {
        let dir = tempfile::tempdir().unwrap();
        let photos_dir = dir.path().join("photos");
        std::fs::create_dir_all(photos_dir.join("shared")).unwrap();
        std::fs::create_dir_all(photos_dir.join("secret")).unwrap();
        std::fs::write(
            photos_dir.join("shared/canon.jpg"),
            crate::exif::jpeg_with_exif("2020:01:02 03:04:05", Some("Canon"), Some("EOS R5")),
        )
        .unwrap();
        std::fs::write(
            photos_dir.join("secret/nikon.jpg"),
            crate::exif::jpeg_with_exif(
                "2020:02:03 04:05:06",
                Some("NIKON CORPORATION"),
                Some("NIKON D850"),
            ),
        )
        .unwrap();
        scan_drive("d1", &photos_dir).unwrap();
        let mounts = vec![("d1".into(), photos_dir.clone())];
        let mut grants = std::collections::HashMap::new();
        grants.insert("d1".into(), vec!["shared".into()]);
        let cameras = list_cameras(&mounts, Some(&grants)).unwrap();
        assert!(
            cameras
                .iter()
                .any(|c| c.make == "Canon" && c.model == "EOS R5"),
            "expected Canon under grant: {cameras:?}"
        );
        assert!(
            cameras
                .iter()
                .all(|c| !(c.make == "NIKON CORPORATION" && c.model == "NIKON D850")),
            "Nikon outside grant must not appear: {cameras:?}"
        );
    }

    #[test]
    fn list_albums_include_all_returns_every_album() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let a = create_album(root, "home", "u1", "Mine").unwrap();
        let b = create_album(root, "home", "u2", "Theirs").unwrap();
        let mounts = vec![("home".into(), root.to_path_buf())];
        let member_view = list_albums(&mounts, "u1", false).unwrap();
        assert_eq!(member_view.len(), 1);
        assert_eq!(member_view[0].id, a.id);
        let admin_view = list_albums(&mounts, "u1", true).unwrap();
        assert_eq!(admin_view.len(), 2);
        assert!(admin_view.iter().any(|x| x.id == a.id));
        assert!(admin_view.iter().any(|x| x.id == b.id));
    }

    #[test]
    fn album_member_can_view_item_without_folder_grant() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let album = create_album(root, "home", "owner", "Shared").unwrap();
        add_album_items(root, &album.id, &[("home".into(), "secret/pic.jpg".into())]).unwrap();
        upsert_member(root, &album.id, "member", "viewer").unwrap();
        let mounts = vec![("home".into(), root.to_path_buf())];
        assert!(user_can_view_path_via_album(
            &mounts,
            "member",
            false,
            "home",
            "secret/pic.jpg"
        ));
        assert!(!user_can_view_path_via_album(
            &mounts,
            "stranger",
            false,
            "home",
            "secret/pic.jpg"
        ));
        assert!(user_can_view_path_via_album(
            &mounts,
            "stranger",
            true,
            "home",
            "secret/pic.jpg"
        ));
    }

    #[test]
    fn list_photos_album_id_without_home_does_not_list_library() {
        let dir = tempfile::tempdir().unwrap();
        let photos_dir = dir.path().join("photos");
        std::fs::create_dir(&photos_dir).unwrap();
        let png = image::RgbaImage::from_pixel(4, 4, image::Rgba([3, 3, 3, 255]));
        png.save(photos_dir.join("private.png")).unwrap();
        png.save(photos_dir.join("shared.png")).unwrap();
        scan_drive("d1", &photos_dir).unwrap();
        let album = create_album(&photos_dir, "d1", "owner", "Shared").unwrap();
        add_album_items(
            &photos_dir,
            &album.id,
            &[("d1".into(), "shared.png".into())],
        )
        .unwrap();
        let mounts = vec![("d1".into(), photos_dir)];

        let leaked = list_photos(
            &mounts,
            None,
            &ListFilter {
                album_id: Some(album.id.clone()),
                album_home_drive: None,
                ..Default::default()
            },
            10,
            0,
        )
        .unwrap();
        assert!(
            leaked.items.is_empty(),
            "album_id without album home must not return the unfiltered library"
        );

        let scoped = list_photos(
            &mounts,
            None,
            &ListFilter {
                album_id: Some(album.id.clone()),
                album_home_drive: Some("d1".into()),
                ..Default::default()
            },
            10,
            0,
        )
        .unwrap();
        assert_eq!(scoped.items.len(), 1);
        assert_eq!(scoped.items[0].path, "shared.png");
    }

    #[test]
    fn rich_exif_filters_and_facets() {
        let dir = tempfile::tempdir().unwrap();
        let photos_dir = dir.path().join("photos");
        std::fs::create_dir(&photos_dir).unwrap();
        std::fs::write(
            photos_dir.join("canon.jpg"),
            crate::exif::jpeg_with_rich_exif(crate::exif::RichExifOpts {
                datetime: "2020:01:02 15:04:05",
                make: Some("Canon"),
                model: Some("EOS R5"),
                lens: Some("RF50mm F1.2 L USM"),
                iso: Some(800),
                focal_num: Some(50),
                focal_den: Some(1),
                flash: Some(1),
            }),
        )
        .unwrap();
        std::fs::write(
            photos_dir.join("phone.jpg"),
            crate::exif::jpeg_with_exif("2020:03:04 05:06:07", Some("Apple"), Some("iPhone")),
        )
        .unwrap();
        let wide = image::RgbaImage::from_pixel(200, 100, image::Rgba([5, 5, 5, 255]));
        wide.save(photos_dir.join("wide.png")).unwrap();

        scan_drive("d1", &photos_dir).unwrap();
        let mounts = vec![("d1".into(), photos_dir.clone())];

        let facets = list_filter_facets(&mounts, None).unwrap();
        assert!(
            facets
                .lenses
                .iter()
                .any(|l| l.lens.contains("RF50mm") && l.count >= 1),
            "expected lens facet in {:?}",
            facets.lenses
        );
        assert!(
            facets
                .formats
                .iter()
                .any(|f| f.ext == "jpg" && f.count >= 1),
            "expected jpg format in {:?}",
            facets.formats
        );
        assert!(
            facets
                .formats
                .iter()
                .any(|f| f.ext == "png" && f.count >= 1),
            "expected png format in {:?}",
            facets.formats
        );
        let iso = facets.iso_range.expect("iso_range");
        assert!(iso.min <= 800.0 && iso.max >= 800.0);
        let focal = facets.focal_range.expect("focal_range");
        assert!((focal.min - 50.0).abs() < 0.01);

        let by_lens = list_photos(
            &mounts,
            None,
            &ListFilter {
                lens: Some("RF50mm F1.2 L USM".into()),
                ..Default::default()
            },
            10,
            0,
        )
        .unwrap();
        assert_eq!(by_lens.items.len(), 1);
        assert_eq!(by_lens.items[0].iso, 800);
        assert!((by_lens.items[0].focal_mm - 50.0).abs() < 0.01);
        assert_eq!(by_lens.items[0].flash, 1);

        let by_iso = list_photos(
            &mounts,
            None,
            &ListFilter {
                iso_min: Some(400),
                iso_max: Some(1600),
                ..Default::default()
            },
            10,
            0,
        )
        .unwrap();
        assert_eq!(by_iso.items.len(), 1);

        let by_flash = list_photos(
            &mounts,
            None,
            &ListFilter {
                flash: Some(1),
                ..Default::default()
            },
            10,
            0,
        )
        .unwrap();
        assert_eq!(by_flash.items.len(), 1);

        let landscape = list_photos(
            &mounts,
            None,
            &ListFilter {
                orientation: Some("landscape".into()),
                ..Default::default()
            },
            10,
            0,
        )
        .unwrap();
        assert!(
            landscape.items.iter().any(|p| p.name == "wide.png"),
            "landscape filter missed wide.png: {:?}",
            landscape.items.iter().map(|p| &p.name).collect::<Vec<_>>()
        );

        let pngs = list_photos(
            &mounts,
            None,
            &ListFilter {
                format: Some("png".into()),
                ..Default::default()
            },
            10,
            0,
        )
        .unwrap();
        assert_eq!(pngs.items.len(), 1);
        assert_eq!(pngs.items[0].name, "wide.png");

        let afternoon = list_photos(
            &mounts,
            None,
            &ListFilter {
                hour_from: Some(14),
                hour_to: Some(16),
                ..Default::default()
            },
            10,
            0,
        )
        .unwrap();
        assert!(
            afternoon.items.iter().any(|p| p.name == "canon.jpg"),
            "hour filter missed canon.jpg"
        );

        let undated = list_photos(
            &mounts,
            None,
            &ListFilter {
                undated: Some(true),
                ..Default::default()
            },
            10,
            0,
        )
        .unwrap();
        assert!(
            undated.items.iter().any(|p| p.name == "wide.png"),
            "undated should include PNG without EXIF date"
        );
    }

    fn copy_fixture_tree(src: &Path, dst: &Path, names: &[&str]) {
        for name in names {
            let from = src.join(name);
            if from.is_dir() {
                copy_dir_all(&from, &dst.join(name));
            }
        }
    }

    fn copy_dir_all(src: &Path, dst: &Path) {
        std::fs::create_dir_all(dst).expect("mkdir");
        for entry in std::fs::read_dir(src).expect("read_dir") {
            let entry = entry.expect("entry");
            let ty = entry.file_type().expect("file_type");
            let to = dst.join(entry.file_name());
            if ty.is_dir() {
                copy_dir_all(&entry.path(), &to);
            } else {
                std::fs::copy(entry.path(), to).expect("copy");
            }
        }
    }

    #[test]
    fn mock_pssd_fixtures_scan_for_gallery() {
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/mock-pssd");
        if !fixture.join("DCIM/100CANON").exists() {
            eprintln!("mock PSSD photo fixtures missing — run: make mock-pssd-photos");
            return;
        }

        let dir = tempfile::tempdir().unwrap();
        let vol = dir.path().join("vol");
        copy_fixture_tree(&fixture, &vol, &["DCIM", "Photos", "Pictures", ".Trashes"]);

        let report = scan_drive("mock", &vol).expect("scan mock PSSD fixtures");
        assert!(
            report.found >= 60,
            "expected many photos, found {}",
            report.found
        );
        assert!(
            report.thumbnailed >= 55,
            "expected most thumbnails, got {}",
            report.thumbnailed
        );

        let mounts = vec![("mock".into(), vol.clone())];
        let page = list_photos(&mounts, Some("mock"), &ListFilter::default(), 200, 0).unwrap();
        assert!(page.items.len() >= 60, "listed {}", page.items.len());

        let with_gps = page.items.iter().filter(|p| p.lat.is_some()).count();
        assert!(with_gps >= 20, "expected GPS photos, got {with_gps}");

        let places = list_places(&mounts).unwrap();
        assert!(
            places.len() >= 3,
            "expected place clusters, got {}",
            places.len()
        );

        let markers = list_place_markers(&mounts).unwrap();
        assert!(
            markers.len() >= 20,
            "expected individual GPS markers, got {}",
            markers.len()
        );
    }

    #[test]
    fn allocate_contrib_dir_avoids_collisions_and_persists() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let album1 = create_album(root, "d1", "user1", "Trip to Paris").unwrap();
        assert!(album1.contrib_path.is_empty(), "starts empty");

        // 1. Initial allocation creates "Shared Photos/Trip to Paris"
        let p1 = allocate_contrib_dir(root, &album1.id, &album1.name).unwrap();
        assert_eq!(p1, "Shared Photos/Trip to Paris");
        assert!(root.join(&p1).is_dir());

        // Calling again reuses the existing path
        let p1_again = allocate_contrib_dir(root, &album1.id, &album1.name).unwrap();
        assert_eq!(p1_again, p1);

        // 2. Pre-create a folder "Shared Photos/Summer Fun" by a user before album2 allocates it
        std::fs::create_dir_all(root.join("Shared Photos/Summer Fun")).unwrap();
        let album2 = create_album(root, "d1", "user1", "Summer Fun").unwrap();
        let p2 = allocate_contrib_dir(root, &album2.id, &album2.name).unwrap();
        assert_eq!(
            p2, "Shared Photos/Summer Fun (2)",
            "must not hijack pre-existing user folder"
        );
        assert!(root.join(&p2).is_dir());

        // 3. Pre-create modifier (3), so album3 jumps to (4)
        std::fs::create_dir_all(root.join("Shared Photos/Summer Fun (3)")).unwrap();
        let album3 = create_album(root, "d1", "user1", "Summer Fun").unwrap();
        let p3 = allocate_contrib_dir(root, &album3.id, &album3.name).unwrap();
        assert_eq!(p3, "Shared Photos/Summer Fun (4)");
        assert!(root.join(&p3).is_dir());
    }

    #[test]
    fn list_invites_returns_created_invites() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let album = create_album(root, "d1", "user1", "Beach").unwrap();
        let inv1 = create_invite(root, &album.id, "viewer", None, None).unwrap();
        let inv2 = create_invite(root, &album.id, "contributor", Some(9999999999), None).unwrap();

        let list = list_invites(root, &album.id).unwrap();
        assert_eq!(list.len(), 2);
        assert!(
            list.iter()
                .any(|i| i.token == inv1.token && i.role == "viewer")
        );
        assert!(
            list.iter()
                .any(|i| i.token == inv2.token && i.role == "contributor")
        );

        delete_invite(root, &inv1.id).unwrap();
        let list2 = list_invites(root, &album.id).unwrap();
        assert_eq!(list2.len(), 1);
        assert_eq!(list2[0].token, inv2.token);
    }

    #[test]
    fn place_label_for_nearest_city_or_coords() {
        assert_eq!(place_label_for(48.86, 2.35), "Paris");
        assert_eq!(place_label_for(40.71, -74.01), "New York");
        let remote = place_label_for(0.0, 0.0);
        assert!(
            remote.contains('°'),
            "expected coordinate fallback, got {remote}"
        );
    }

    #[test]
    fn archive_hides_from_library_and_lists_archived() {
        let dir = tempfile::tempdir().unwrap();
        let photos_dir = dir.path().join("photos");
        std::fs::create_dir(&photos_dir).unwrap();
        let png = image::RgbaImage::from_pixel(4, 4, image::Rgba([2, 2, 2, 255]));
        png.save(photos_dir.join("a.png")).unwrap();
        png.save(photos_dir.join("b.png")).unwrap();
        scan_drive("d1", &photos_dir).unwrap();
        set_archived(&photos_dir, "u1", "a.png", true).unwrap();
        let mounts = vec![("d1".into(), photos_dir.clone())];
        let library = list_photos(
            &mounts,
            None,
            &ListFilter {
                exclude_archived_user: Some("u1".into()),
                user_id: Some("u1".into()),
                ..Default::default()
            },
            10,
            0,
        )
        .unwrap();
        assert_eq!(library.items.len(), 1);
        assert_eq!(library.items[0].name, "b.png");
        let archived = list_photos(
            &mounts,
            None,
            &ListFilter {
                archived_user: Some("u1".into()),
                user_id: Some("u1".into()),
                ..Default::default()
            },
            10,
            0,
        )
        .unwrap();
        assert_eq!(archived.items.len(), 1);
        assert_eq!(archived.items[0].name, "a.png");
    }

    #[test]
    fn update_album_unshare_deletes_invites() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let album = create_album(root, "d1", "user1", "Secret").unwrap();
        let _ = create_invite(root, &album.id, "viewer", None, None).unwrap();
        assert_eq!(list_invites(root, &album.id).unwrap().len(), 1);
        update_album(root, &album.id, None, Some(false), None, None, None).unwrap();
        assert!(list_invites(root, &album.id).unwrap().is_empty());

        let mounts = vec![("d1".into(), root.to_path_buf())];
        let inv = create_invite(root, &album.id, "viewer", None, None).unwrap();
        update_album(root, &album.id, None, Some(true), None, None, None).unwrap();
        assert!(find_invite(&mounts, &inv.token).unwrap().is_some());
        update_album(root, &album.id, None, Some(false), None, None, None).unwrap();
        assert!(find_invite(&mounts, &inv.token).unwrap().is_none());
    }

    #[test]
    fn add_album_items_sets_cover_drive_id() {
        let dir = tempfile::tempdir().unwrap();
        let photos_dir = dir.path().join("photos");
        std::fs::create_dir(&photos_dir).unwrap();
        let png = image::RgbaImage::from_pixel(4, 4, image::Rgba([2, 2, 2, 255]));
        png.save(photos_dir.join("x.png")).unwrap();
        scan_drive("d1", &photos_dir).unwrap();
        let album = create_album(&photos_dir, "d1", "u1", "Trip").unwrap();
        add_album_items(&photos_dir, &album.id, &[("d1".into(), "x.png".into())]).unwrap();
        let got = get_album(&photos_dir, "d1", &album.id).unwrap().unwrap();
        assert_eq!(got.cover_path, "x.png");
        assert_eq!(got.cover_drive_id, "d1");
        assert!(!got.cover_thumb.is_empty());
        remove_album_item(&photos_dir, &album.id, "d1", "x.png").unwrap();
        let cleared = get_album(&photos_dir, "d1", &album.id).unwrap().unwrap();
        assert!(cleared.cover_path.is_empty());
        assert!(cleared.cover_drive_id.is_empty());
    }

    #[test]
    fn update_album_sets_cover() {
        let dir = tempfile::tempdir().unwrap();
        let photos_dir = dir.path().join("photos");
        std::fs::create_dir(&photos_dir).unwrap();
        let png = image::RgbaImage::from_pixel(4, 4, image::Rgba([3, 3, 3, 255]));
        png.save(photos_dir.join("cover.png")).unwrap();
        scan_drive("d1", &photos_dir).unwrap();
        let album = create_album(&photos_dir, "d1", "u1", "Trip").unwrap();
        add_album_items(&photos_dir, &album.id, &[("d1".into(), "cover.png".into())]).unwrap();
        update_album(
            &photos_dir,
            &album.id,
            None,
            None,
            None,
            None,
            Some(("d1".into(), "cover.png".into())),
        )
        .unwrap();
        let got = get_album(&photos_dir, "d1", &album.id).unwrap().unwrap();
        assert_eq!(got.cover_path, "cover.png");
        assert_eq!(got.cover_drive_id, "d1");
    }

    #[test]
    fn viewer_member_cannot_contribute() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let album = create_album(root, "d1", "owner", "Trip").unwrap();
        upsert_member(root, &album.id, "viewer1", "viewer").unwrap();
        assert!(user_can_access_album(root, &album, "viewer1").unwrap());
        assert!(!user_can_contribute(root, &album, "viewer1").unwrap());
        upsert_member(root, &album.id, "helper", "contributor").unwrap();
        // allow_uploads still false — contribute stays false until uploads enabled
        assert!(!user_can_contribute(root, &album, "helper").unwrap());
        update_album(root, &album.id, None, None, Some(true), None, None).unwrap();
        let album = get_album(root, "d1", &album.id).unwrap().unwrap();
        assert!(user_can_contribute(root, &album, "helper").unwrap());
        assert!(!user_can_contribute(root, &album, "viewer1").unwrap());
    }
}

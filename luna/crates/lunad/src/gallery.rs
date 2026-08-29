//! Photo gallery: per-drive indexes under `{drive}/.lunagallery/`.
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

const DB_FILE: &str = "gallery.sqlite";

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
    pub favorited: bool,
}

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
    gallery_dir(drive_root).join(DB_FILE)
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
}

/// Open (or create) the on-drive gallery database. Never under OS data_dir.
pub fn open_drive_db(drive_root: &Path) -> anyhow::Result<Connection> {
    let dir = gallery_dir(drive_root);
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(DB_FILE);
    let conn = Connection::open(&path)?;
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         PRAGMA synchronous=NORMAL;
         CREATE TABLE IF NOT EXISTS photos (
            path TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            size INTEGER NOT NULL,
            mtime INTEGER NOT NULL,
            taken_at INTEGER NOT NULL DEFAULT 0,
            kind TEXT NOT NULL DEFAULT 'image',
            width INTEGER NOT NULL DEFAULT 0,
            height INTEGER NOT NULL DEFAULT 0,
            lat REAL,
            lon REAL,
            place_label TEXT NOT NULL DEFAULT '',
            has_thumb INTEGER NOT NULL DEFAULT 0
         );
         CREATE INDEX IF NOT EXISTS photos_timeline
            ON photos(taken_at DESC, mtime DESC, path);
         CREATE INDEX IF NOT EXISTS photos_place
            ON photos(lat, lon);
         CREATE TABLE IF NOT EXISTS favorites (
            user_id TEXT NOT NULL,
            path TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY (user_id, path)
         );
         CREATE TABLE IF NOT EXISTS albums (
            id TEXT PRIMARY KEY,
            owner_user_id TEXT NOT NULL,
            name TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            cover_path TEXT NOT NULL DEFAULT '',
            shared INTEGER NOT NULL DEFAULT 0,
            allow_uploads INTEGER NOT NULL DEFAULT 0,
            contrib_path TEXT NOT NULL DEFAULT ''
         );
         CREATE TABLE IF NOT EXISTS album_items (
            album_id TEXT NOT NULL,
            drive_id TEXT NOT NULL,
            path TEXT NOT NULL,
            added_at INTEGER NOT NULL,
            PRIMARY KEY (album_id, drive_id, path)
         );
         CREATE TABLE IF NOT EXISTS album_members (
            album_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            role TEXT NOT NULL,
            PRIMARY KEY (album_id, user_id)
         );
         CREATE TABLE IF NOT EXISTS album_invites (
            id TEXT PRIMARY KEY,
            album_id TEXT NOT NULL,
            token TEXT NOT NULL UNIQUE,
            role TEXT NOT NULL,
            expires_at INTEGER,
            password_hash TEXT,
            created_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS album_invites_token ON album_invites(token);",
    )?;
    Ok(conn)
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
    has_thumb: bool,
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
                    taken_at: mtime,
                    kind: kind.to_string(),
                    width: 0,
                    height: 0,
                    lat: None,
                    lon: None,
                    has_thumb: false,
                });
                flush_if_full(&mut conn, &mut pending)?;
                continue;
            }

            let (taken_at, lat, lon) = crate::exif::capture_meta(&path_buf)
                .map(|(ts, lat, lon)| (ts.unwrap_or(mtime), lat, lon))
                .unwrap_or((mtime, None, None));

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
            "INSERT INTO photos (path, name, size, mtime, taken_at, kind, width, height, lat, lon, has_thumb)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
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
    let (taken_at, lat, lon) = crate::exif::capture_meta(&path_buf)
        .map(|(ts, lat, lon)| (ts.unwrap_or(mtime), lat, lon))
        .unwrap_or((mtime, None, None));
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
        "SELECT path, name, size, taken_at, kind, width, height, lat, lon, has_thumb
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
            let has_thumb: i64 = row.get(9)?;
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
                place_label: None,
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
    conn.execute(
        "DELETE FROM album_items WHERE drive_id = ?1 AND path = ?2",
        params![drive_id, rel],
    )?;
    let thumb = thumb_path(root, drive_id, rel);
    let _ = std::fs::remove_file(thumb);
    Ok(())
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
    let tmp = dest.with_extension("vid.jpg.tmp");
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

fn load_album_paths(
    mounts: &[(String, PathBuf)],
    filter: &ListFilter,
) -> anyhow::Result<Option<HashSet<(String, String)>>> {
    let (Some(album_id), Some(home)) = (&filter.album_id, &filter.album_home_drive) else {
        return Ok(None);
    };
    let Some((_, root)) = mounts.iter().find(|(id, _)| id == home) else {
        return Ok(Some(HashSet::new()));
    };
    if !gallery_db_path(root).exists() {
        return Ok(Some(HashSet::new()));
    }
    let conn = open_drive_db(root)?;
    let mut stmt = conn.prepare("SELECT drive_id, path FROM album_items WHERE album_id = ?1")?;
    let set = stmt
        .query_map(params![album_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .filter_map(|r| r.ok())
        .collect();
    Ok(Some(set))
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

    let mut stmt = conn.prepare(
        "SELECT p.path, p.name, p.size, COALESCE(NULLIF(p.taken_at, 0), p.mtime),
                p.width, p.height, p.kind, p.lat, p.lon, p.place_label, p.has_thumb,
                CASE WHEN f.path IS NOT NULL THEN 1 ELSE 0 END
         FROM photos p
         LEFT JOIN favorites f ON f.path = p.path AND f.user_id = ?1
         WHERE (?2 = '' OR p.name LIKE ?2 COLLATE NOCASE OR p.path LIKE ?2 COLLATE NOCASE)
           AND (?3 = 0 OR COALESCE(NULLIF(p.taken_at, 0), p.mtime) >= ?3)
           AND (?4 = 0 OR COALESCE(NULLIF(p.taken_at, 0), p.mtime) <= ?4)
           AND (?5 = '' OR (p.lat IS NOT NULL AND p.lon IS NOT NULL
                AND printf('%.1f,%.1f', p.lat, p.lon) = ?5))
           AND (?6 = 0 OR f.path IS NOT NULL)
           AND (?7 = 0 OR (p.lat IS NOT NULL AND p.lon IS NOT NULL
                AND p.lon >= ?8 AND p.lon <= ?9 AND p.lat >= ?10 AND p.lat <= ?11))",
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
        ],
        |row| {
            let path: String = row.get(0)?;
            let has_thumb: i64 = row.get(10)?;
            let favorited: i64 = row.get(11)?;
            let place_label: String = row.get(9)?;
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

pub fn place_key(lat: f64, lon: f64) -> String {
    format!("{lat:.1},{lon:.1}")
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

#[derive(Debug, Clone, Serialize)]
pub struct Album {
    pub id: String,
    pub home_drive_id: String,
    pub owner_user_id: String,
    pub name: String,
    pub created_at: i64,
    pub cover_path: String,
    pub cover_thumb: String,
    pub shared: bool,
    pub allow_uploads: bool,
    pub contrib_path: String,
    pub item_count: u64,
}

pub fn list_albums(mounts: &[(String, PathBuf)], user_id: &str) -> anyhow::Result<Vec<Album>> {
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
            "SELECT a.id, a.owner_user_id, a.name, a.created_at, a.cover_path, a.shared,
                    a.allow_uploads, a.contrib_path,
                    (SELECT COUNT(*) FROM album_items i WHERE i.album_id = a.id)
             FROM albums a
             WHERE a.owner_user_id = ?1
                OR EXISTS (SELECT 1 FROM album_members m WHERE m.album_id = a.id AND m.user_id = ?1)
             ORDER BY a.created_at DESC",
        )?;
        let rows = stmt.query_map(params![user_id], |row| {
            let cover_path: String = row.get(4)?;
            Ok(Album {
                id: row.get(0)?,
                home_drive_id: drive_id.clone(),
                owner_user_id: row.get(1)?,
                name: row.get(2)?,
                created_at: row.get(3)?,
                cover_thumb: if cover_path.is_empty() {
                    String::new()
                } else {
                    thumb_url(drive_id, &cover_path)
                },
                cover_path,
                shared: row.get::<_, i64>(5)? != 0,
                allow_uploads: row.get::<_, i64>(6)? != 0,
                contrib_path: row.get(7)?,
                item_count: row.get::<_, i64>(8)? as u64,
            })
        })?;
        for row in rows {
            out.push(row?);
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
    let contrib = format!("{SHARED_ALBUMS_DIR_NAME}/{id}");
    conn.execute(
        "INSERT INTO albums (id, owner_user_id, name, created_at, shared, allow_uploads, contrib_path)
         VALUES (?1, ?2, ?3, ?4, 0, 0, ?5)",
        params![id, owner_user_id, name, now, contrib],
    )?;
    Ok(Album {
        id,
        home_drive_id: home_drive_id.to_string(),
        owner_user_id: owner_user_id.to_string(),
        name: name.to_string(),
        created_at: now,
        cover_path: String::new(),
        cover_thumb: String::new(),
        shared: false,
        allow_uploads: false,
        contrib_path: contrib,
        item_count: 0,
    })
}

pub fn get_album(
    root: &Path,
    home_drive_id: &str,
    album_id: &str,
) -> anyhow::Result<Option<Album>> {
    let conn = open_drive_db(root)?;
    conn.query_row(
        "SELECT id, owner_user_id, name, created_at, cover_path, shared, allow_uploads, contrib_path,
                (SELECT COUNT(*) FROM album_items i WHERE i.album_id = albums.id)
         FROM albums WHERE id = ?1",
        params![album_id],
        |row| {
            let cover_path: String = row.get(4)?;
            Ok(Album {
                id: row.get(0)?,
                home_drive_id: home_drive_id.to_string(),
                owner_user_id: row.get(1)?,
                name: row.get(2)?,
                created_at: row.get(3)?,
                cover_thumb: if cover_path.is_empty() {
                    String::new()
                } else {
                    thumb_url(home_drive_id, &cover_path)
                },
                cover_path,
                shared: row.get::<_, i64>(5)? != 0,
                allow_uploads: row.get::<_, i64>(6)? != 0,
                contrib_path: row.get(7)?,
                item_count: row.get::<_, i64>(8)? as u64,
            })
        },
    )
    .optional()
    .map_err(Into::into)
}

pub fn update_album(
    root: &Path,
    album_id: &str,
    name: Option<&str>,
    shared: Option<bool>,
    allow_uploads: Option<bool>,
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
    }
    if let Some(allow) = allow_uploads {
        conn.execute(
            "UPDATE albums SET allow_uploads = ?1 WHERE id = ?2",
            params![if allow { 1 } else { 0 }, album_id],
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
        && let Some((_, path)) = items.first()
    {
        tx.execute(
            "UPDATE albums SET cover_path = ?1 WHERE id = ?2",
            params![path, album_id],
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
    conn.execute(
        "DELETE FROM album_items WHERE album_id = ?1 AND drive_id = ?2 AND path = ?3",
        params![album_id, drive_id, path],
    )?;
    Ok(())
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
        let albums = list_albums(&mounts, "u1").unwrap();
        assert_eq!(albums.len(), 1);
        assert_eq!(albums[0].item_count, 1);
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
}

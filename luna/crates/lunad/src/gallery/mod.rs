//! Photo gallery: index tables live in the per-drive `.luna-<uuid>.sqlite3`
//! microdb.
//!
//! Thumbnails live in `{drive}/.luna-<uuid>-thumbs/`. Gallery SQLite never
//! touches the OS eMMC / `luna.db`. JPEG/PNG/GIF use the `image` crate; HEIC
//! uses embedded JPEG or Alpine `heif-dec`; video thumbs use optional
//! `ffmpeg`. Originals are never rewritten.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use image::ImageReader;
use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension, params, params_from_iter};
use serde::Serialize;

/// Long-edge cap for generated thumbnails. Sized for ~320px grid cells on
/// 2x displays — the cells are square crops, so landscape thumbs still
/// upscale a little on the short edge.
const THUMB_MAX: u32 = 640;
const THUMB_JPEG_QUALITY: u8 = 85;
/// Thumb recipe version, baked into the filename. Bump when size, filter,
/// or quality changes — scans regenerate, stale names get swept.
const THUMB_GEN: u32 = 2;
const IMAGE_EXTS: &[&str] = &["jpg", "jpeg", "png", "gif", "heic", "heif", "hif"];
const VIDEO_EXTS: &[&str] = &["mp4", "mov", "m4v", "webm"];
const BATCH_UPSERT: usize = 64;

/// Top-level user-accessible folder for shared album uploads on the home drive.
pub const USER_SHARED_ALBUMS_DIR: &str = "Shared Photos";

#[derive(Debug, Clone)]
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
    pub lat: Option<f64>,
    pub lon: Option<f64>,
    pub place_label: Option<String>,
    pub camera_make: String,
    pub camera_model: String,
    pub lens: String,
    pub iso: u32,
    pub focal_mm: f64,
    /// `-1` unknown, `0` off, `1` on.
    pub flash: i64,
    pub duration_secs: u32,
    pub favorited: bool,
}

impl Photo {
    /// Stable opaque handle for a photo — safe to hand to guests, unlike the
    /// raw `drive_id`/`path` coordinates.
    pub fn opaque_id(&self) -> String {
        blake3::hash(format!("{}\0{}", self.drive_id, self.path).as_bytes())
            .to_hex()
            .to_string()
    }
}

/// `Photo`'s serialized form is the guest-safe projection: an opaque `id`,
/// the display name, and media metadata — never the real `drive_id` or
/// `path`, which would reveal drive layout (member homes live under
/// `.luna-<uuid>-members`). Member-facing handlers re-attach the real
/// coordinates explicitly through `api::gallery::member_photo_json`;
/// anything that serializes a `Photo` directly — like the anonymous
/// album-link surface — stays safe by default. `path` carries the same
/// opaque id so per-item UI keys (selection, lightbox) stay unique without
/// disclosing where the file lives.
impl Serialize for Photo {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let optional = self.lat.is_some() as usize
            + self.lon.is_some() as usize
            + self.place_label.is_some() as usize;
        let opaque = self.opaque_id();
        let mut st = s.serialize_struct("Photo", 17 + optional)?;
        st.serialize_field("id", &opaque)?;
        st.serialize_field("path", &opaque)?;
        st.serialize_field("name", &self.name)?;
        st.serialize_field("size", &self.size)?;
        st.serialize_field("taken_at", &self.taken_at)?;
        st.serialize_field("width", &self.width)?;
        st.serialize_field("height", &self.height)?;
        st.serialize_field("thumb", &self.thumb)?;
        st.serialize_field("kind", &self.kind)?;
        if let Some(v) = self.lat {
            st.serialize_field("lat", &v)?;
        }
        if let Some(v) = self.lon {
            st.serialize_field("lon", &v)?;
        }
        if let Some(v) = &self.place_label {
            st.serialize_field("place_label", v)?;
        }
        st.serialize_field("camera_make", &self.camera_make)?;
        st.serialize_field("camera_model", &self.camera_model)?;
        st.serialize_field("lens", &self.lens)?;
        st.serialize_field("iso", &self.iso)?;
        st.serialize_field("focal_mm", &self.focal_mm)?;
        st.serialize_field("flash", &self.flash)?;
        st.serialize_field("duration_secs", &self.duration_secs)?;
        st.serialize_field("favorited", &self.favorited)?;
        st.end()
    }
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
    /// `MM-DD` (UTC) match on effective capture time — powers the "On this
    /// day" view (same month-day across years).
    pub month_day: Option<String>,
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

/// Per-drive thumbnail directory `{prefix}-thumbs/` on the photo's own mount
/// (not the OS eMMC). `None` when the drive carries no `.luna-<uuid>` marker.
pub fn thumbs_dir(drive_root: &Path) -> Option<PathBuf> {
    crate::drives::layout::Layout::detect(drive_root).map(|l| l.thumbs_dir(drive_root))
}

/// Path of the drive's marker/microdb file, when adopted.
pub fn gallery_db_path(drive_root: &Path) -> Option<PathBuf> {
    crate::drives::drive_db::find_db_file(drive_root)
}

/// Shared-album image copies `{prefix}-shared-albums/` on the home drive.
pub fn shared_albums_dir(drive_root: &Path) -> Option<PathBuf> {
    crate::drives::layout::Layout::detect(drive_root).map(|l| l.shared_albums_dir(drive_root))
}

/// Thumbnail file for `rel`, inside the drive's `{prefix}-thumbs/` directory.
pub fn thumb_path(drive_root: &Path, drive_id: &str, rel: &str) -> Option<PathBuf> {
    thumbs_dir(drive_root).map(|d| thumb_path_in(&d, drive_id, rel))
}

fn thumb_path_in(thumb_dir: &Path, drive_id: &str, rel: &str) -> PathBuf {
    let key = format!("{drive_id}:{rel}");
    let hash = blake3::hash(key.as_bytes()).to_hex().to_string();
    thumb_dir.join(format!("{hash}.v{THUMB_GEN}.jpg"))
}

pub fn thumb_url(drive_id: &str, rel: &str) -> String {
    format!(
        "/api/v1/gallery/thumb?drive_id={drive_id}&path={}",
        urlencode(rel)
    )
}

/// Skip anything inside the drive's `.luna-<uuid>` namespace — marker, trash,
/// thumbs, protected copies, upload temps.
pub fn skip_gallery_dir(name: &str) -> bool {
    crate::drives::layout::Layout::is_luna_name(name)
}

/// Open the on-drive `.luna-<uuid>.sqlite3` microdb (gallery tables included).
/// Never under OS data_dir.
pub fn open_drive_db(drive_root: &Path) -> anyhow::Result<Connection> {
    crate::drives::drive_db::open(drive_root)
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
    place_city: String,
    place_region: String,
    place_country: String,
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

/// `MM-DD` with plausible ranges (the caller derives it from today's date, so
/// only real days arrive — Feb 30 is allowed to simply never match).
fn valid_month_day(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 5 || b[2] != b'-' {
        return false;
    }
    if !b[..2].iter().chain(&b[3..]).all(u8::is_ascii_digit) {
        return false;
    }
    let month: u32 = s[..2].parse().unwrap_or(0);
    let day: u32 = s[3..].parse().unwrap_or(0);
    (1..=12).contains(&month) && (1..=31).contains(&day)
}

/// Walk one drive and refresh its on-drive photo index + thumbnails.
pub fn scan_drive(drive_id: &str, root: &Path) -> anyhow::Result<ScanReport> {
    let thumb_dir = thumbs_dir(root)
        .ok_or_else(|| anyhow::anyhow!("drive is not adopted — no .luna-<uuid> marker"))?;
    std::fs::create_dir_all(&thumb_dir)?;
    // Filenames carry THUMB_GEN — sweep thumbs from older recipes so a
    // quality change doesn't leak disk or keep serving the old encode.
    let gen_suffix = format!(".v{THUMB_GEN}.jpg");
    if let Ok(entries) = std::fs::read_dir(&thumb_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            if name.ends_with(".jpg") && !name.ends_with(&gen_suffix) {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
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

            let dest = thumb_path_in(&thumb_dir, drive_id, &rel);
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
                    place_city: String::new(),
                    place_region: String::new(),
                    place_country: String::new(),
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

            let meta = crate::gallery::exif::capture_meta(&path_buf).unwrap_or_default();
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
            let place = match (lat, lon) {
                (Some(la), Some(lo)) => crate::gallery::places::index().enrich(la, lo),
                _ => crate::gallery::places::PlaceInfo::default(),
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
                place_label: place.label,
                place_city: place.city.to_string(),
                place_region: place.region.to_string(),
                place_country: place.country.to_string(),
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
            "INSERT INTO photos (path, name, size, mtime, taken_at, kind, width, height, lat, lon, place_label, place_city, place_region, place_country, camera_make, camera_model, lens, iso, focal_mm, flash, duration_secs, has_thumb)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22)
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
               place_city = excluded.place_city,
               place_region = excluded.place_region,
               place_country = excluded.place_country,
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
                row.place_city,
                row.place_region,
                row.place_country,
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
    if let Ok(Some((old_size, old_mtime, old_has_thumb))) = photo_cache_row(&conn, rel)
        && let Some(dest) = thumb_path(root, drive_id, rel)
        && old_size == size
        && old_mtime == mtime
        && old_has_thumb
        && dest.exists()
    {
        return Ok(Some(()));
    }
    let meta = crate::gallery::exif::capture_meta(&path_buf).unwrap_or_default();
    let taken_at = meta.taken_at.unwrap_or(0);
    let lat = meta.lat;
    let lon = meta.lon;
    let camera_make = meta.camera_make.unwrap_or_default();
    let camera_model = meta.camera_model.unwrap_or_default();
    let lens = meta.lens.unwrap_or_default();
    let iso = meta.iso.unwrap_or(0);
    let focal_mm = meta.focal_mm.unwrap_or(0.0);
    let flash = flash_to_i64(meta.flash);
    let place = match (lat, lon) {
        (Some(la), Some(lo)) => crate::gallery::places::index().enrich(la, lo),
        _ => crate::gallery::places::PlaceInfo::default(),
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
        place_label: place.label,
        place_city: place.city.to_string(),
        place_region: place.region.to_string(),
        place_country: place.country.to_string(),
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
    let Some(dest) = thumb_path(root, drive_id, rel) else {
        return Ok(());
    };
    if let Some(dir) = thumbs_dir(root) {
        let _ = std::fs::create_dir_all(dir);
    }
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

/// Magic-byte check that a file really is the media its extension claims.
/// Only the formats the gallery accepts need recognizing — the gate is
/// "looks like photo or video bytes", not exact format identification. A
/// `.jpg` holding markup (or anything else a browser could render) fails it.
pub fn sniff_media_file(path: &Path) -> bool {
    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    let mut head = [0u8; 32];
    let n = std::io::Read::read(&mut file, &mut head).unwrap_or(0);
    sniff_media_bytes(&head[..n])
}

/// Magic-byte media recognizer on the file's first bytes.
pub(crate) fn sniff_media_bytes(head: &[u8]) -> bool {
    // JPEG: SOI + marker.
    if head.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return true;
    }
    // PNG signature.
    if head.starts_with(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) {
        return true;
    }
    // GIF87a / GIF89a.
    if head.starts_with(b"GIF87a") || head.starts_with(b"GIF89a") {
        return true;
    }
    // ISO-BMFF family — HEIC/HEIF/HIF and MP4/MOV/M4V all open with a box
    // length followed by `ftyp` at offset 4.
    if head.len() >= 12 && &head[4..8] == b"ftyp" {
        return true;
    }
    // WebM / Matroska EBML header.
    if head.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) {
        return true;
    }
    false
}

/// Index a single media file (meta + thumb). Used by shared-album uploads and tests.
pub fn index_one(drive_id: &str, root: &Path, rel: &str) -> anyhow::Result<Option<Photo>> {
    // Contribution accept path: the extension alone doesn't prove media —
    // a renamed HTML file must not land in shared albums. `resolve_child`
    // also keeps planted links inside the drive.
    let Ok(abs) = luna_core::path::resolve_child(root, rel) else {
        return Ok(None);
    };
    if !is_media(&abs) || !sniff_media_file(&abs) {
        return Ok(None);
    }
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
    if gallery_db_path(root).is_none() {
        return Ok(());
    }
    let conn = open_drive_db(root)?;
    conn.execute("DELETE FROM photos WHERE path = ?1", params![rel])?;
    conn.execute("DELETE FROM favorites WHERE path = ?1", params![rel])?;
    drop(conn);
    // Refresh album covers when this path was a cover on this drive's albums.
    let _ = remove_album_items_for_path(root, drive_id, rel);
    if let Some(thumb) = thumb_path(root, drive_id, rel) {
        let _ = std::fs::remove_file(thumb);
    }
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
    if gallery_db_path(root).is_none() {
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
    if let (Some(old_thumb), Some(new_thumb)) = (
        thumb_path(root, drive_id, from),
        thumb_path(root, drive_id, to),
    ) && old_thumb.exists()
    {
        if let Some(dir) = thumbs_dir(root) {
            let _ = std::fs::create_dir_all(dir);
        }
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

/// Generate a JPEG thumbnail (fit within THUMB_MAX). Returns (width, height, was_created).
pub fn ensure_thumb(src: &Path, dest: &Path, kind: &str) -> anyhow::Result<(u32, u32, bool)> {
    if dest.exists() {
        return Ok((0, 0, false));
    }
    // A source that resolves into Luna's own namespace (member homes,
    // thumbs, trash, the microdb itself) must never be thumbnailed: album
    // and link surfaces reach here through paths a member only *named*, and
    // a symlink they planted must not read out `.luna-*` contents for them.
    if let Ok(canonical) = src.canonicalize()
        && crate::files::is_internal_temp(&canonical.to_string_lossy())
    {
        anyhow::bail!("Luna can't make a thumbnail from that file");
    }
    let limits = crate::budget::limits();
    let meta = std::fs::symlink_metadata(src)?;
    if meta.len() > limits.source_max_bytes {
        anyhow::bail!("photo is too large to preview with the free memory on this Luna");
    }
    if kind == "video" {
        return ensure_video_thumb(src, dest);
    }
    if crate::gallery::heif::is_heif(src) {
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
            "2",
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
    if let Some(jpeg) = crate::gallery::heif::jpeg_item_from_heif(&bytes) {
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
        crate::gallery::heif::decode_heif_to_jpeg(src, &decoded)?;
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
    // `thumbnail()` is the fast box sampler — visibly soft next to Lanczos3.
    // And save_with_format encodes JPEG at q75; thumbs get an explicit
    // higher quality since they're the only pixels most photos ever show.
    let thumb = img.resize(THUMB_MAX, THUMB_MAX, image::imageops::FilterType::Lanczos3);
    let tmp = dest.with_extension("jpg.tmp");
    if let Some(parent) = tmp.parent() {
        std::fs::create_dir_all(parent)?;
    }
    {
        let mut out = std::io::BufWriter::new(std::fs::File::create(&tmp)?);
        thumb.write_with_encoder(image::codecs::jpeg::JpegEncoder::new_with_quality(
            &mut out,
            THUMB_JPEG_QUALITY,
        ))?;
        std::io::Write::flush(&mut out)?;
    }
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
        if gallery_db_path(root).is_none() {
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
        if gallery_db_path(root).is_none() {
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
            if gallery_db_path(root).is_none() {
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
        .unwrap_or("");
    let mut q_pat = filter
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
    let month_day = filter
        .month_day
        .as_deref()
        .map(str::trim)
        .filter(|s| valid_month_day(s))
        .unwrap_or_default();
    // Tokenize the free-text query into structured predicates (places,
    // dates, kinds, …) plus leftover LIKE terms. When it produced nothing
    // at all, fall back to the historical whole-`q` substring match.
    let parsed_q = filter
        .q
        .as_deref()
        .map(str::trim)
        .filter(|q| !q.is_empty())
        .map(|q| crate::search_query::parse(q, now_unix()));
    if parsed_q.as_ref().is_some_and(|p| !p.is_empty()) {
        q_pat.clear();
    }

    let mut sql = "SELECT p.path, p.name, p.size, COALESCE(NULLIF(p.taken_at, 0), p.mtime),
                p.width, p.height, p.kind, p.lat, p.lon, p.place_label, p.has_thumb,
                CASE WHEN f.path IS NOT NULL THEN 1 ELSE 0 END,
                COALESCE(p.duration_secs, 0),
                COALESCE(p.camera_make, ''), COALESCE(p.camera_model, ''),
                COALESCE(p.lens, ''), COALESCE(p.iso, 0), COALESCE(p.focal_mm, 0),
                COALESCE(p.flash, -1)
         FROM photos p
         LEFT JOIN favorites f ON f.path = p.path AND f.user_id = ?1
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
           AND (?12 = '' OR p.kind = ?12)
           AND (?13 = '' OR lower(p.camera_make) = lower(?13))
           AND (?14 = '' OR lower(p.camera_model) = lower(?14))
           AND (?15 = '' OR lower(p.lens) = lower(?15))
           AND (?16 < 0 OR (p.iso > 0 AND p.iso >= ?16))
           AND (?17 < 0 OR (p.iso > 0 AND p.iso <= ?17))
           AND (?18 < 0 OR (p.focal_mm > 0 AND p.focal_mm >= ?18))
           AND (?19 < 0 OR (p.focal_mm > 0 AND p.focal_mm <= ?19))
           AND (?20 < 0 OR p.flash = ?20)
           AND (?21 = '' OR (
                (?21 = 'landscape' AND p.width > p.height AND p.width > 0) OR
                (?21 = 'portrait' AND p.height > p.width AND p.height > 0) OR
                (?21 = 'square' AND p.width = p.height AND p.width > 0)
           ))
           AND (?22 < 0 OR (
                (?22 = 1 AND p.lat IS NOT NULL AND p.lon IS NOT NULL) OR
                (?22 = 0 AND (p.lat IS NULL OR p.lon IS NULL))
           ))
           AND (?23 < 0 OR ?24 < 0 OR (
                CASE
                  WHEN ?23 <= ?24 THEN
                    ((COALESCE(NULLIF(p.taken_at, 0), p.mtime) / 3600) % 24) BETWEEN ?23 AND ?24
                  ELSE
                    ((COALESCE(NULLIF(p.taken_at, 0), p.mtime) / 3600) % 24) >= ?23
                    OR ((COALESCE(NULLIF(p.taken_at, 0), p.mtime) / 3600) % 24) <= ?24
                END
           ))
           AND (?25 < 0 OR (p.width > 0 AND p.height > 0
                AND (CAST(p.width AS REAL) * CAST(p.height AS REAL) / 1000000.0) >= ?25))
           AND (?26 < 0 OR p.duration_secs >= ?26)
           AND (?27 < 0 OR p.duration_secs <= ?27)
           AND (?28 < 0 OR (
                (?28 = 1 AND p.taken_at = 0) OR
                (?28 = 0 AND p.taken_at != 0)
           ))
           AND (?29 = '' OR (
                (?29 = 'any' AND EXISTS (
                    SELECT 1 FROM album_items ai
                    WHERE ai.path = p.path AND ai.drive_id = ?30
                )) OR
                (?29 = 'none' AND NOT EXISTS (
                    SELECT 1 FROM album_items ai
                    WHERE ai.path = p.path AND ai.drive_id = ?30
                ))
           ))
           AND (?31 = '' OR strftime('%m-%d', COALESCE(NULLIF(p.taken_at, 0), p.mtime), 'unixepoch') = ?31)"
    .to_string();
    let mut binds: Vec<Value> = vec![
        uid.to_string().into(),
        q_pat.into(),
        from.into(),
        to.into(),
        place.into(),
        fav_only.into(),
        bbox_active.into(),
        bbox_min_lon.into(),
        bbox_max_lon.into(),
        bbox_min_lat.into(),
        bbox_max_lat.into(),
        kind.to_string().into(),
        camera_make.to_string().into(),
        camera_model.to_string().into(),
        lens.to_string().into(),
        iso_min.into(),
        iso_max.into(),
        focal_min.into(),
        focal_max.into(),
        flash.into(),
        orientation.into(),
        has_gps.into(),
        hour_from.into(),
        hour_to.into(),
        min_megapixels.into(),
        min_duration.into(),
        max_duration.into(),
        undated.into(),
        album_membership.into(),
        drive_id.to_string().into(),
        month_day.to_string().into(),
    ];
    if let Some(pq) = parsed_q.as_ref().filter(|p| !p.is_empty()) {
        append_query_clauses(&mut sql, &mut binds, pq);
    }
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(binds), |row| {
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
    })?;

    let mut photos = Vec::new();
    for row in rows {
        let photo = row?;
        if let Some(set) = album_paths
            && !set.contains(&(drive_id.to_string(), photo.path.clone()))
        {
            continue;
        }
        // Format filter: refine in Rust when a format was requested — the
        // `format` param and `q` format words ("heic", "raw") both apply.
        let mut allowed: HashSet<String> = format
            .split(',')
            .map(normalize_format_ext)
            .filter(|s| !s.is_empty())
            .collect();
        if let Some(pq) = parsed_q.as_ref().filter(|p| !p.is_empty()) {
            allowed.extend(pq.formats.iter().cloned());
        }
        if !allowed.is_empty() {
            let ext = normalize_format_ext(&path_ext_lower(&photo.path));
            if !allowed.contains(&ext) {
                continue;
            }
        }
        photos.push(photo);
    }
    Ok(photos)
}

/// Append `q`-parser predicates to the base query. Binds continue at `?32`
/// (the base statement uses `?1..=?31`; `?30` is the drive id, `?31` the
/// month-day filter). Values the parser produced as integers are inlined —
/// only user text goes through binds, so there is no injection surface.
fn append_query_clauses(
    sql: &mut String,
    binds: &mut Vec<Value>,
    pq: &crate::search_query::ParsedQuery,
) {
    const EFF: &str = "COALESCE(NULLIF(p.taken_at, 0), p.mtime)";
    let like = |s: &str| -> Value {
        let t: String = s.chars().filter(|c| *c != '%' && *c != '_').collect();
        Value::Text(format!("%{t}%"))
    };
    // One shared text-match predicate for LIKE params: file/camera text,
    // every place column, and same-drive album names.
    let text_match = |p: &str| -> String {
        format!(
            "p.name LIKE {p} COLLATE NOCASE OR p.path LIKE {p} COLLATE NOCASE \
             OR p.camera_make LIKE {p} COLLATE NOCASE OR p.camera_model LIKE {p} COLLATE NOCASE \
             OR p.lens LIKE {p} COLLATE NOCASE OR p.place_label LIKE {p} COLLATE NOCASE \
             OR p.place_city LIKE {p} COLLATE NOCASE OR p.place_region LIKE {p} COLLATE NOCASE \
             OR p.place_country LIKE {p} COLLATE NOCASE \
             OR EXISTS (SELECT 1 FROM album_items ai JOIN albums al ON al.id = ai.album_id \
                        AND al.name LIKE {p} COLLATE NOCASE \
                        WHERE ai.drive_id = ?30 AND ai.path = p.path)"
        )
    };
    let mut n = 31usize;
    for term in &pq.like_terms {
        n += 1;
        sql.push_str(&format!(" AND ({})", text_match(&format!("?{n}"))));
        binds.push(like(term));
    }
    // All place alternatives OR into one group — "paris london" means
    // either city (a photo can't be in both), not both at once. Each
    // resolved phrase still text-matches (a file named "portland-x.jpg"
    // must hit even when the photo is in Texas), plus canonical-name
    // equality on the derived place columns, plus a bbox around each
    // resolved city center for rows whose label differs.
    if !pq.places.is_empty() {
        let mut alts = Vec::new();
        for place in &pq.places {
            n += 1;
            alts.push(text_match(&format!("?{n}")));
            binds.push(like(&place.raw));
            for name in &place.names {
                n += 1;
                alts.push(format!(
                    "lower(p.place_city) = ?{n} OR lower(p.place_region) = ?{n} \
                     OR lower(p.place_country) = ?{n} OR lower(p.place_label) = ?{n}"
                ));
                binds.push(Value::Text(name.to_lowercase()));
            }
            for (lat, lon) in &place.centers {
                let dlat = crate::gallery::places::CITY_QUERY_RADIUS_KM / 111.0;
                let dlon = dlat / lat.to_radians().cos().abs().max(0.3);
                n += 4;
                alts.push(format!(
                    "(p.lat BETWEEN ?{} AND ?{} AND p.lon BETWEEN ?{} AND ?{})",
                    n - 3,
                    n - 2,
                    n - 1,
                    n
                ));
                binds.extend([
                    Value::Real(lat - dlat),
                    Value::Real(lat + dlat),
                    Value::Real(lon - dlon),
                    Value::Real(lon + dlon),
                ]);
            }
        }
        sql.push_str(&format!(" AND ({})", alts.join(" OR ")));
    }
    if !pq.months.is_empty() {
        let list = pq
            .months
            .iter()
            .map(|m| m.to_string())
            .collect::<Vec<_>>()
            .join(",");
        sql.push_str(&format!(
            " AND CAST(strftime('%m', {EFF}, 'unixepoch') AS INTEGER) IN ({list})"
        ));
    }
    if !pq.years.is_empty() {
        let list = pq
            .years
            .iter()
            .map(|y| y.to_string())
            .collect::<Vec<_>>()
            .join(",");
        sql.push_str(&format!(
            " AND CAST(strftime('%Y', {EFF}, 'unixepoch') AS INTEGER) IN ({list})"
        ));
    }
    if !pq.weekdays.is_empty() {
        let list = pq
            .weekdays
            .iter()
            .map(|d| d.to_string())
            .collect::<Vec<_>>()
            .join(",");
        sql.push_str(&format!(
            " AND CAST(strftime('%w', {EFF}, 'unixepoch') AS INTEGER) IN ({list})"
        ));
    }
    if !pq.day_windows.is_empty() {
        let parts: Vec<String> = pq
            .day_windows
            .iter()
            .map(|w| {
                let mut s = format!(
                    "(CAST(strftime('%m', {EFF}, 'unixepoch') AS INTEGER) = {} \
                     AND CAST(strftime('%d', {EFF}, 'unixepoch') AS INTEGER) \
                     BETWEEN {} AND {})",
                    w.month, w.day_lo, w.day_hi
                );
                if let Some(wd) = w.weekday {
                    s.insert_str(
                        s.len() - 1,
                        &format!(" AND CAST(strftime('%w', {EFF}, 'unixepoch') AS INTEGER) = {wd}"),
                    );
                }
                s
            })
            .collect();
        sql.push_str(&format!(" AND ({})", parts.join(" OR ")));
    }
    if !pq.days.is_empty() {
        let list = pq
            .days
            .iter()
            .map(|d| d.to_string())
            .collect::<Vec<_>>()
            .join(",");
        sql.push_str(&format!(
            " AND CAST(strftime('%d', {EFF}, 'unixepoch') AS INTEGER) IN ({list})"
        ));
    }
    // Month+day ranges ("between sep 19 and oct 3") compare on the 'MM-DD'
    // string — zero-padded, so lexicographic order is calendar order.
    // Ranges wrapping the year boundary split into two arms.
    if !pq.md_ranges.is_empty() {
        let parts: Vec<String> = pq
            .md_ranges
            .iter()
            .map(|&((m1, d1), (m2, d2))| {
                let lo = format!("{m1:02}-{d1:02}");
                let hi = format!("{m2:02}-{d2:02}");
                let md = format!("strftime('%m-%d', {EFF}, 'unixepoch')");
                if lo <= hi {
                    format!("({md} BETWEEN '{lo}' AND '{hi}')")
                } else {
                    format!("({md} >= '{lo}' OR {md} <= '{hi}')")
                }
            })
            .collect();
        sql.push_str(&format!(" AND ({})", parts.join(" OR ")));
    }
    if !pq.any_ranges.is_empty() {
        let mut parts = Vec::with_capacity(pq.any_ranges.len());
        for (lo, hi) in &pq.any_ranges {
            n += 2;
            parts.push(format!("({EFF} >= ?{} AND {EFF} < ?{})", n - 1, n));
            binds.push(Value::Integer(*lo));
            binds.push(Value::Integer(*hi));
        }
        sql.push_str(&format!(" AND ({})", parts.join(" OR ")));
    }
    for (lo, hi) in &pq.ranges {
        n += 2;
        sql.push_str(&format!(" AND ({EFF} >= ?{} AND {EFF} < ?{})", n - 1, n));
        binds.push(Value::Integer(*lo));
        binds.push(Value::Integer(*hi));
    }
    if !pq.hours.is_empty() {
        let parts: Vec<String> = pq
            .hours
            .iter()
            .map(|(lo, hi)| {
                if lo <= hi {
                    format!("(({EFF} / 3600) % 24) BETWEEN {lo} AND {hi}")
                } else {
                    format!("(({EFF} / 3600) % 24) >= {lo} OR (({EFF} / 3600) % 24) <= {hi}")
                }
            })
            .collect();
        sql.push_str(&format!(" AND ({})", parts.join(" OR ")));
    }
    if let Some(kind) = pq.kind {
        n += 1;
        sql.push_str(&format!(" AND p.kind = ?{n}"));
        binds.push(Value::Text(kind.to_string()));
    }
    if let Some(o) = pq.orientation {
        n += 1;
        sql.push_str(&format!(
            " AND ((?{n} = 'landscape' AND p.width > p.height AND p.width > 0) OR \
                  (?{n} = 'portrait' AND p.height > p.width AND p.height > 0) OR \
                  (?{n} = 'square' AND p.width = p.height AND p.width > 0) OR \
                  (?{n} = 'pano' AND p.width >= 2 * p.height AND p.height > 0))"
        ));
        binds.push(Value::Text(o.to_string()));
    }
    if let Some(f) = pq.flash {
        n += 1;
        sql.push_str(&format!(" AND p.flash = ?{n}"));
        binds.push(Value::Integer(f));
    }
    if pq.favorites_only {
        sql.push_str(" AND f.path IS NOT NULL");
    }
    if pq.favorites_none {
        sql.push_str(" AND f.path IS NULL");
    }
    if pq.undated {
        sql.push_str(" AND p.taken_at = 0");
    }
    if pq.no_gps {
        sql.push_str(" AND (p.lat IS NULL OR p.lon IS NULL)");
    }
    if pq.has_gps {
        sql.push_str(" AND p.lat IS NOT NULL AND p.lon IS NOT NULL");
    }
}

pub fn list_places(mounts: &[(String, PathBuf)]) -> anyhow::Result<Vec<PlaceCluster>> {
    use std::collections::HashMap;
    let mut map: HashMap<String, PlaceCluster> = HashMap::new();
    for (drive_id, root) in mounts {
        if gallery_db_path(root).is_none() {
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
        if gallery_db_path(root).is_none() {
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
/// A drive missing from the map is denied (empty grant), not treated as Admin.
/// `None` means unrestricted (Admin).
pub fn list_cameras(
    mounts: &[(String, PathBuf)],
    path_grants: Option<&std::collections::HashMap<String, Vec<String>>>,
) -> anyhow::Result<Vec<CameraCount>> {
    use std::collections::HashMap;
    let mut map: HashMap<(String, String), u64> = HashMap::new();
    for (drive_id, root) in mounts {
        if gallery_db_path(root).is_none() {
            continue;
        }
        let conn = match open_drive_db(root) {
            Ok(c) => c,
            Err(_) => continue,
        };
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
            if !path_allowed_by_grants(path_grants, drive_id, &path) {
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

/// `path_grants = None` → Admin (allow all).
/// `path_grants = Some(map)` → Member: only paths under that drive's prefixes;
/// a missing drive key denies every path on that drive (never “allow all”).
fn path_allowed_by_grants(
    path_grants: Option<&std::collections::HashMap<String, Vec<String>>>,
    drive_id: &str,
    path: &str,
) -> bool {
    match path_grants {
        None => true,
        Some(grants) => match grants.get(drive_id) {
            None => false,
            Some(prefs) => prefs.iter().any(|p| crate::access::path_contains(p, path)),
        },
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
        if gallery_db_path(root).is_none() {
            continue;
        }
        let conn = match open_drive_db(root) {
            Ok(c) => c,
            Err(_) => continue,
        };
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
                if !path_allowed_by_grants(path_grants, drive_id, &path) {
                    continue;
                }
                *lenses.entry(lens).or_insert(0) += 1;
            }
        }
        {
            let mut stmt = conn.prepare("SELECT path FROM photos")?;
            let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
            for path in rows.flatten() {
                if !path_allowed_by_grants(path_grants, drive_id, &path) {
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
            let mut stmt = conn.prepare("SELECT iso, path FROM photos WHERE iso > 0")?;
            let rows = stmt.query_map([], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })?;
            for row in rows.flatten() {
                let (iso, path) = row;
                if !path_allowed_by_grants(path_grants, drive_id, &path) {
                    continue;
                }
                let iso = iso.max(0) as u32;
                iso_min = Some(iso_min.map_or(iso, |v| v.min(iso)));
                iso_max = Some(iso_max.map_or(iso, |v| v.max(iso)));
            }
        }
        {
            let mut stmt = conn.prepare("SELECT focal_mm, path FROM photos WHERE focal_mm > 0")?;
            let rows = stmt.query_map([], |row| {
                Ok((row.get::<_, f64>(0)?, row.get::<_, String>(1)?))
            })?;
            for row in rows.flatten() {
                let (focal, path) = row;
                if !path_allowed_by_grants(path_grants, drive_id, &path) {
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

/// Coarse offline place label: nearest gazetteer city (~150 km), else its
/// region or country, else raw coordinates.
pub fn place_label_for(lat: f64, lon: f64) -> String {
    crate::gallery::places::label_for(lat, lon)
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
    pub cover_drive_id: String,
    pub cover_thumb: String,
    /// Folder (relative to the home drive) where guest/contributor uploads land.
    pub contrib_path: String,
    pub locked: bool,
    pub item_count: u64,
}

/// What a non-manager sees of an album: everything the UI needs to render
/// and address it, without the on-disk layout (`contrib_path`,
/// `cover_path`/`cover_drive_id`) or the owner's user id. `cover_thumb`
/// stays — it is a display URL, and album viewers can already reach every
/// item's thumbnail through album membership.
#[derive(Debug, Clone, Serialize)]
pub struct AlbumPublic {
    pub id: String,
    pub home_drive_id: String,
    pub name: String,
    pub created_at: i64,
    pub cover_thumb: String,
    pub locked: bool,
    pub item_count: u64,
}

impl Album {
    /// Strip the internal fields for viewers who do not manage the album.
    /// `cover_thumb` becomes an album-scoped URL instead of the item's
    /// `?drive_id=&path=` thumb URL — album viewers get the same image
    /// without learning where the cover file lives on the drive.
    pub fn public_view(&self) -> AlbumPublic {
        AlbumPublic {
            id: self.id.clone(),
            home_drive_id: self.home_drive_id.clone(),
            name: self.name.clone(),
            created_at: self.created_at,
            cover_thumb: if self.cover_thumb.is_empty() {
                String::new()
            } else {
                format!(
                    "/api/v1/gallery/albums/{}/{}/cover",
                    self.home_drive_id, self.id
                )
            },
            locked: self.locked,
            item_count: self.item_count,
        }
    }
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

/// List albums across mounted drives. `member_ids` maps each home drive id to
/// the album ids the user is an access-member of (universal access model); an
/// admin (`include_all`) sees every album regardless.
pub fn list_albums(
    mounts: &[(String, PathBuf)],
    user_id: &str,
    member_ids: &std::collections::HashMap<String, std::collections::HashSet<String>>,
    include_all: bool,
) -> anyhow::Result<Vec<Album>> {
    let mut out = Vec::new();
    for (drive_id, root) in mounts {
        if gallery_db_path(root).is_none() {
            continue;
        }
        let conn = match open_drive_db(root) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let mut stmt = conn.prepare(
            "SELECT a.id, a.owner_user_id, a.name, a.created_at, a.cover_path, a.cover_drive_id,
                    a.contrib_path, a.locked,
                    (SELECT COUNT(*) FROM album_items i WHERE i.album_id = a.id)
             FROM albums a
             ORDER BY a.created_at DESC",
        )?;
        let rows = stmt.query_map([], |row: &rusqlite::Row<'_>| {
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
                contrib_path: row.get(6)?,
                locked: row.get::<_, i64>(7)? != 0,
                item_count: row.get::<_, i64>(8)? as u64,
            })
        })?;
        for row in rows {
            let album = row?;
            let member = member_ids
                .get(drive_id)
                .is_some_and(|ids| ids.contains(&album.id));
            if !include_all && album.owner_user_id != user_id && !member {
                continue;
            }
            out.push(album);
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
        "INSERT INTO albums (id, owner_user_id, name, created_at, contrib_path, cover_drive_id, locked)
         VALUES (?1, ?2, ?3, ?4, '', '', 0)",
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
        // The stored folder must be real directories all the way down — a
        // symlink swapped in afterwards must never steer contributor uploads
        // into a different folder on (or off) the drive.
        match luna_core::path::resolve_child_nofollow(root, &path) {
            Ok(target) if target.is_dir() => return Ok(path),
            Ok(_) => anyhow::bail!("the album's upload folder is blocked by a file"),
            Err(luna_core::path::PathError::NotFound(_)) => {
                create_dir_all_locked(root, &path)?;
            }
            Err(e) => return Err(e.into()),
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
        // `symlink_metadata` so a dangling symlink also counts as taken —
        // Luna must not write through a planted link.
        if std::fs::symlink_metadata(&p).is_ok() {
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

    create_dir_all_locked(root, &chosen_path)?;
    conn.execute(
        "UPDATE albums SET contrib_path = ?1 WHERE id = ?2",
        params![chosen_path, album_id],
    )?;

    Ok(chosen_path)
}

/// Create `rel` (and every missing parent) under `root` without following
/// any symlink component. Mirrors `files::dest_dir_create`'s per-prefix
/// walk: each existing component must be a real directory, each new one is
/// re-verified right after creation, and the finished path is canonicalized
/// once more before callers write into it — a symlink planted between steps
/// can never steer creation outside the drive root.
fn create_dir_all_locked(root: &Path, rel: &str) -> anyhow::Result<PathBuf> {
    let mut prefix = String::new();
    for part in rel.split('/').filter(|s| !s.is_empty()) {
        if !prefix.is_empty() {
            prefix.push('/');
        }
        prefix.push_str(part);
        let p = luna_core::path::resolve_for_create_nofollow(root, &prefix)?;
        match std::fs::symlink_metadata(&p) {
            Ok(m) if m.is_dir() && !m.file_type().is_symlink() => {}
            Ok(_) => {
                anyhow::bail!("a file is in the way of the album's upload folder");
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                match std::fs::create_dir(&p) {
                    Ok(()) => {}
                    // A concurrent create won the race — fine, as long as
                    // what exists now is a real directory.
                    Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
                    Err(e) => return Err(e.into()),
                }
                match std::fs::symlink_metadata(&p) {
                    Ok(m) if m.is_dir() && !m.file_type().is_symlink() => {}
                    _ => {
                        anyhow::bail!("a file is in the way of the album's upload folder");
                    }
                }
            }
            Err(e) => return Err(e.into()),
        }
    }
    Ok(luna_core::path::resolve_child(root, rel)?)
}

pub fn get_album(
    root: &Path,
    home_drive_id: &str,
    album_id: &str,
) -> anyhow::Result<Option<Album>> {
    let conn = open_drive_db(root)?;
    conn.query_row(
        "SELECT id, owner_user_id, name, created_at, cover_path, cover_drive_id,
                contrib_path, locked,
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
                contrib_path: row.get(6)?,
                locked: row.get::<_, i64>(7)? != 0,
                item_count: row.get::<_, i64>(8)? as u64,
            })
        },
    )
    .optional()
    .map_err(Into::into)
}

/// Remove every access row (members + links) that points at this album.
/// Called when the album is deleted so the universal model stays clean.
pub fn delete_access_for_album(
    central: &rusqlite::Connection,
    home_drive_id: &str,
    album_id: &str,
) -> anyhow::Result<()> {
    central.execute(
        "DELETE FROM access_members WHERE subject_kind = 'album' AND drive_id = ?1 AND album_id = ?2",
        params![home_drive_id, album_id],
    )?;
    central.execute(
        "DELETE FROM access_links WHERE subject_kind = 'album' AND drive_id = ?1 AND album_id = ?2",
        params![home_drive_id, album_id],
    )?;
    Ok(())
}

pub fn update_album(
    root: &Path,
    album_id: &str,
    name: Option<&str>,
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
    is_image(path) && crate::gallery::heif::is_heif(path)
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
/// Caps at `max_files` (returns Err on overflow). Files living inside Luna's
/// own namespace (member homes, thumbs, trash, the microdb) are never
/// packed, and duplicate archive names are made unique with ` (n)` suffixes.
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
    let mut used_names: HashSet<String> = HashSet::new();
    for (archive_name, abs) in entries {
        let meta = std::fs::symlink_metadata(abs)?;
        if meta.file_type().is_symlink() || !meta.is_file() {
            continue;
        }
        // Entry paths arrive canonicalized — a `.luna-*` segment means a
        // symlinked item or contrib row resolved onto Luna bookkeeping
        // (a member home, thumbs, the drive's microdb). Never ship those.
        if crate::files::is_internal_temp(&abs.to_string_lossy()) {
            continue;
        }
        let name = unique_zip_name(&mut used_names, archive_name);
        zip.start_file(&name, options)?;
        let mut input = open_verified_abs(abs)?;
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

/// `archive_name` or `archive_name (n)` — never two identical entry names in
/// one zip (basenames collide when items come from different folders).
fn unique_zip_name(used: &mut HashSet<String>, archive_name: &str) -> String {
    if used.insert(archive_name.to_string()) {
        return archive_name.to_string();
    }
    let (stem, ext) = match archive_name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (archive_name.to_string(), String::new()),
    };
    for n in 2.. {
        let cand = format!("{stem} ({n}){ext}");
        if used.insert(cand.clone()) {
            return cand;
        }
    }
    unreachable!()
}

/// Open `abs` for reading, refusing a last-minute symlink swap and proving
/// via `/proc/self/fd` that the descriptor really is the canonical path the
/// caller resolved (check-then-open TOCTOU guard).
fn open_verified_abs(abs: &Path) -> std::io::Result<std::fs::File> {
    let mut opts = std::fs::OpenOptions::new();
    opts.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.custom_flags(libc::O_NOFOLLOW);
    }
    let file = opts.open(abs)?;
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::io::AsRawFd;
        let canonical = abs.canonicalize()?;
        let link = std::fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd()))?;
        if link != canonical {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "path changed between check and open",
            ));
        }
    }
    Ok(file)
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

    /// Give a test drive root a `.luna-<uuid>` marker so drive_db opens.
    /// Idempotent — reuses the existing prefix when already adopted.
    fn adopt(root: &Path, id: &str) {
        if crate::drives::drive_db::prefix_for(root).is_none() {
            let prefix = luna_core::marker::pick_prefix(root).unwrap();
            crate::drives::drive_db::create(
                root,
                &luna_core::marker::Marker::new(id, "Test"),
                &prefix,
            )
            .unwrap();
        }
    }

    /// Adopt-then-scan shorthand for tests.
    fn scan(drive_id: &str, root: &Path) -> anyhow::Result<ScanReport> {
        adopt(root, drive_id);
        scan_drive(drive_id, root)
    }

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
        let dest =
            PathBuf::from("/drive/.luna-3f6a8c1e-9b2d-4a7c-8e5f-1a2b3c4d5e6f-thumbs/abc.jpg");
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

        let prefix = luna_core::marker::pick_prefix(&photos_dir).unwrap();
        crate::drives::drive_db::create(
            &photos_dir,
            &luna_core::marker::Marker::new("d1", "Photos"),
            &prefix,
        )
        .unwrap();

        let first = scan("d1", &photos_dir).unwrap();
        assert_eq!(first.found, 1);
        assert_eq!(first.thumbnailed, 1);
        assert!(gallery_db_path(&photos_dir).is_some());
        assert!(
            thumbs_dir(&photos_dir)
                .unwrap()
                .read_dir()
                .unwrap()
                .next()
                .is_some(),
            "thumbs must land under the photo drive's .luna-<uuid>-thumbs"
        );
        assert!(
            std::fs::read_dir(&os_data).unwrap().next().is_none(),
            "gallery DB must not land under OS data dir"
        );

        let second = scan("d1", &photos_dir).unwrap();
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
            crate::gallery::exif::jpeg_with_datetime_original("2010:01:01 00:00:00"),
        )
        .unwrap();
        let png = image::RgbaImage::from_pixel(8, 8, image::Rgba([1, 2, 3, 255]));
        png.save(&recent).unwrap();

        scan("d1", &photos_dir).unwrap();
        let mounts = vec![("d1".into(), photos_dir)];
        let page = list_photos(&mounts, Some("d1"), &ListFilter::default(), 10, 0).unwrap();
        assert_eq!(page.items.len(), 2);
        assert_eq!(page.items[0].name, "recent.png");
        assert_eq!(page.items[1].name, "from-phone.jpg");
        assert_eq!(
            page.items[1].taken_at,
            crate::gallery::exif::parse_exif_datetime("2010:01:01 00:00:00").unwrap()
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
        scan("d1", &photos_dir).unwrap();
        std::fs::remove_file(&b).unwrap();
        let report = scan("d1", &photos_dir).unwrap();
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
        scan("d1", &photos_dir).unwrap();

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
        let empty_members = std::collections::HashMap::new();
        let albums = list_albums(&mounts, "u1", &empty_members, false).unwrap();
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
        scan("d1", &photos_dir).unwrap();
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
        scan("da", &a).unwrap();
        scan("db", &b).unwrap();
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
            crate::gallery::exif::jpeg_with_exif(
                "2020:01:02 03:04:05",
                Some("Canon"),
                Some("EOS R5"),
            ),
        )
        .unwrap();
        std::fs::write(
            photos_dir.join("nikon.jpg"),
            crate::gallery::exif::jpeg_with_exif(
                "2020:02:03 04:05:06",
                Some("NIKON CORPORATION"),
                Some("NIKON D850"),
            ),
        )
        .unwrap();
        let png = image::RgbaImage::from_pixel(4, 4, image::Rgba([4, 4, 4, 255]));
        png.save(photos_dir.join("plain.png")).unwrap();
        scan("d1", &photos_dir).unwrap();
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
            crate::gallery::exif::jpeg_with_exif(
                "2020:01:02 03:04:05",
                Some("Canon"),
                Some("EOS R5"),
            ),
        )
        .unwrap();
        std::fs::write(
            photos_dir.join("secret/nikon.jpg"),
            crate::gallery::exif::jpeg_with_exif(
                "2020:02:03 04:05:06",
                Some("NIKON CORPORATION"),
                Some("NIKON D850"),
            ),
        )
        .unwrap();
        scan("d1", &photos_dir).unwrap();
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
    fn list_cameras_member_missing_drive_key_denies_all() {
        let dir = tempfile::tempdir().unwrap();
        let photos_dir = dir.path().join("photos");
        std::fs::create_dir(&photos_dir).unwrap();
        std::fs::write(
            photos_dir.join("canon.jpg"),
            crate::gallery::exif::jpeg_with_exif(
                "2020:01:02 03:04:05",
                Some("Canon"),
                Some("EOS R5"),
            ),
        )
        .unwrap();
        scan("d1", &photos_dir).unwrap();
        let mounts = vec![("d1".into(), photos_dir)];
        // Member map present but this drive has no entry — must not equal Admin None.
        let grants = std::collections::HashMap::new();
        let cameras = list_cameras(&mounts, Some(&grants)).unwrap();
        assert!(
            cameras.is_empty(),
            "missing drive key under Some(grants) must deny: {cameras:?}"
        );
        let admin = list_cameras(&mounts, None).unwrap();
        assert!(
            admin
                .iter()
                .any(|c| c.make == "Canon" && c.model == "EOS R5"),
            "Admin None still sees cameras: {admin:?}"
        );
    }

    #[test]
    fn list_albums_include_all_returns_every_album() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        adopt(root, "home");
        let a = create_album(root, "home", "u1", "Mine").unwrap();
        let b = create_album(root, "home", "u2", "Theirs").unwrap();
        let mounts = vec![("home".into(), root.to_path_buf())];
        let empty = std::collections::HashMap::new();
        let member_view = list_albums(&mounts, "u1", &empty, false).unwrap();
        assert_eq!(member_view.len(), 1);
        assert_eq!(member_view[0].id, a.id);
        let admin_view = list_albums(&mounts, "u1", &empty, true).unwrap();
        assert_eq!(admin_view.len(), 2);
        assert!(admin_view.iter().any(|x| x.id == a.id));
        assert!(admin_view.iter().any(|x| x.id == b.id));

        // An access-member row on the other album makes it visible to u1.
        let mut member_ids = std::collections::HashMap::new();
        member_ids.insert(
            "home".to_string(),
            std::collections::HashSet::from([b.id.clone()]),
        );
        let joined = list_albums(&mounts, "u1", &member_ids, false).unwrap();
        assert_eq!(joined.len(), 2);
    }

    #[test]
    fn list_photos_album_id_without_home_does_not_list_library() {
        let dir = tempfile::tempdir().unwrap();
        let photos_dir = dir.path().join("photos");
        std::fs::create_dir(&photos_dir).unwrap();
        let png = image::RgbaImage::from_pixel(4, 4, image::Rgba([3, 3, 3, 255]));
        png.save(photos_dir.join("private.png")).unwrap();
        png.save(photos_dir.join("shared.png")).unwrap();
        scan("d1", &photos_dir).unwrap();
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
            crate::gallery::exif::jpeg_with_rich_exif(crate::gallery::exif::RichExifOpts {
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
            crate::gallery::exif::jpeg_with_exif(
                "2020:03:04 05:06:07",
                Some("Apple"),
                Some("iPhone"),
            ),
        )
        .unwrap();
        let wide = image::RgbaImage::from_pixel(200, 100, image::Rgba([5, 5, 5, 255]));
        wide.save(photos_dir.join("wide.png")).unwrap();

        scan("d1", &photos_dir).unwrap();
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

    #[test]
    fn allocate_contrib_dir_avoids_collisions_and_persists() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        adopt(root, "d1");
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
    #[cfg(unix)]
    fn allocate_contrib_dir_never_writes_through_symlinks() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        adopt(root, "d1");
        let album = create_album(root, "d1", "user1", "Trip").unwrap();

        // A planted symlink where a path component should be: "Shared
        // Photos" points outside the contrib namespace. Allocation must
        // refuse to create inside the target rather than follow the link.
        let outside = dir.path().join("elsewhere");
        std::fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("Shared Photos")).unwrap();
        let err = allocate_contrib_dir(root, &album.id, &album.name)
            .expect_err("symlinked contrib parent must not be followed");
        let _ = err; // any refusal is correct — the target must stay empty
        assert!(
            std::fs::read_dir(&outside).unwrap().next().is_none(),
            "nothing may be created through the planted symlink"
        );

        // A stored contrib path later replaced by a symlink is refused too.
        std::fs::remove_file(root.join("Shared Photos")).unwrap();
        let path = allocate_contrib_dir(root, &album.id, &album.name).unwrap();
        let legit = root.join(&path);
        std::fs::remove_dir_all(&legit).unwrap();
        let hijack = dir.path().join("hijack");
        std::fs::create_dir_all(&hijack).unwrap();
        std::os::unix::fs::symlink(&hijack, &legit).unwrap();
        assert!(
            allocate_contrib_dir(root, &album.id, &album.name).is_err(),
            "contrib dir swapped for a symlink must not be reused"
        );
    }

    #[test]
    fn sniff_media_file_tells_real_media_from_markup() {
        let dir = tempfile::tempdir().unwrap();
        let jpg = dir.path().join("a.jpg");
        std::fs::write(&jpg, [0xFF, 0xD8, 0xFF, 0xE0, 0x00]).unwrap();
        assert!(sniff_media_file(&jpg));

        // HTML bytes named like a photo — the extension lies.
        let fake = dir.path().join("party.jpg");
        std::fs::write(&fake, b"<html><body>not a photo</body></html>").unwrap();
        assert!(!sniff_media_file(&fake));

        let mp4 = dir.path().join("clip.mp4");
        std::fs::write(&mp4, b"\x00\x00\x00\x18ftypisom\x00\x00\x00\x00").unwrap();
        assert!(sniff_media_file(&mp4));

        assert!(!sniff_media_file(&dir.path().join("missing.jpg")));
    }

    #[test]
    fn index_one_rejects_markup_named_as_media() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        adopt(root, "d1");
        // A contribution upload that is really markup must not index.
        std::fs::write(root.join("party.jpg"), b"<html><body>x</body></html>").unwrap();
        assert!(
            index_one("d1", root, "party.jpg").unwrap().is_none(),
            "renamed markup must not be accepted as a photo"
        );
        // A real image still indexes.
        let img = image::RgbImage::from_pixel(4, 4, image::Rgb([1, 2, 3]));
        img.save(root.join("ok.jpg")).unwrap();
        assert!(index_one("d1", root, "ok.jpg").unwrap().is_some());
    }

    #[test]
    fn write_items_zip_dedupes_names_and_skips_luna_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let a = root.join("a");
        let b = root.join("b");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(a.join("same.jpg"), b"aaa").unwrap();
        std::fs::write(b.join("same.jpg"), b"bbbb").unwrap();
        // A file sitting inside Luna's namespace — never pack it.
        let prefix = luna_core::marker::pick_prefix(root).unwrap();
        let member_home = root.join(format!("{prefix}-members/sam"));
        std::fs::create_dir_all(&member_home).unwrap();
        let private = member_home.join("private.jpg");
        std::fs::write(&private, b"secret").unwrap();

        let zip_path = root.join("out.zip");
        let file = std::fs::File::create(&zip_path).unwrap();
        let n = write_items_zip(
            &[
                ("same.jpg".into(), a.join("same.jpg")),
                ("same.jpg".into(), b.join("same.jpg")),
                ("private.jpg".into(), private),
            ],
            file,
            10,
        )
        .unwrap();
        assert_eq!(n, 2, "the member-home file must be skipped");

        let archive = std::fs::File::open(&zip_path).unwrap();
        let mut zip = zip::ZipArchive::new(archive).unwrap();
        let names: Vec<String> = (0..zip.len())
            .map(|i| zip.by_index(i).unwrap().name().to_string())
            .collect();
        assert!(names.contains(&"same.jpg".to_string()));
        assert!(
            names
                .iter()
                .any(|n| n.starts_with("same (") && n.ends_with(").jpg")),
            "duplicate basename must be made unique, got {names:?}"
        );
        assert!(
            !names.iter().any(|n| n.contains("private")),
            "Luna-internal file must not appear in the zip"
        );
    }

    #[test]
    fn place_label_for_nearest_city_or_coords() {
        assert_eq!(place_label_for(48.86, 2.35), "Paris");
        assert_eq!(place_label_for(40.71, -74.01), "New York City");
        let remote = place_label_for(0.0, 0.0);
        assert!(
            remote.contains('°'),
            "expected coordinate fallback, got {remote}"
        );
    }

    #[test]
    fn q_resolves_places_dates_kinds_and_albums() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        adopt(root, "d1");
        {
            let conn = open_drive_db(root).unwrap();
            // (path, taken_at, kind, lat, lon, city, region, country)
            type PhotoRow = (
                &'static str,
                i64,
                &'static str,
                Option<f64>,
                Option<f64>,
                &'static str,
                &'static str,
                &'static str,
            );
            let rows: &[PhotoRow] = &[
                (
                    "seattle.jpg",
                    1_694_736_000,
                    "image",
                    Some(47.61),
                    Some(-122.33),
                    "Seattle",
                    "Washington",
                    "United States",
                ),
                (
                    "bend.jpg",
                    1_665_792_000,
                    "image",
                    Some(44.06),
                    Some(-121.31),
                    "Bend",
                    "Oregon",
                    "United States",
                ),
                (
                    "bkk.jpg",
                    1_703_462_400,
                    "image",
                    Some(13.75),
                    Some(100.50),
                    "Bangkok",
                    "Bangkok",
                    "Thailand",
                ),
                ("clip.mp4", 1_694_736_000, "video", None, None, "", "", ""),
                ("plain.jpg", 1_694_736_000, "image", None, None, "", "", ""),
            ];
            for (path, taken, kind, lat, lon, city, region, country) in rows {
                conn.execute(
                    "INSERT INTO photos
                     (path, name, size, mtime, taken_at, kind, lat, lon,
                      place_label, place_city, place_region, place_country)
                     VALUES (?1, ?1, 100, ?2, ?2, ?3, ?4, ?5, ?6, ?6, ?7, ?8)",
                    params![path, taken, kind, lat, lon, city, region, country],
                )
                .unwrap();
            }
        }
        let album = create_album(root, "d1", "u1", "Camping Trip").unwrap();
        add_album_items(root, &album.id, &[("d1".into(), "seattle.jpg".into())]).unwrap();

        let mounts = vec![("d1".into(), root.to_path_buf())];
        let names = |q: &str| -> Vec<String> {
            list_photos(
                &mounts,
                None,
                &ListFilter {
                    q: Some(q.into()),
                    ..Default::default()
                },
                50,
                0,
            )
            .unwrap()
            .items
            .iter()
            .map(|p| p.path.clone())
            .collect()
        };

        assert_eq!(names("seattle"), ["seattle.jpg"]);
        assert_eq!(names("oregon"), ["bend.jpg"]);
        assert_eq!(names("thailand"), ["bkk.jpg"]);
        assert_eq!(names("videos"), ["clip.mp4"]);
        assert_eq!(names("christmas"), ["bkk.jpg"]);
        assert_eq!(names("september"), ["clip.mp4", "plain.jpg", "seattle.jpg"]);
        assert_eq!(names("2022"), ["bend.jpg"]);
        assert_eq!(names("no location"), ["clip.mp4", "plain.jpg"]);
        assert_eq!(names("camping trip"), ["seattle.jpg"]);
        // A resolved place keeps its text fallback: files named after a place
        // match even with no GPS.
        assert_eq!(names("bend"), ["bend.jpg"]);
        assert_eq!(names("nowhereville"), Vec::<String>::new());
    }

    #[test]
    fn q_parses_natural_language_dates() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        adopt(root, "d1");
        {
            let conn = open_drive_db(root).unwrap();
            let rows: &[(&str, i64)] = &[
                ("sep19-2023.jpg", 1_695_081_600),  // 2023-09-19 UTC
                ("sep19-2024.jpg", 1_726_704_000),  // 2024-09-19 UTC
                ("sep20-2024.jpg", 1_726_790_400),  // 2024-09-20 UTC
                ("easter-2024.jpg", 1_711_843_200), // 2024-03-31 UTC
            ];
            for (path, taken) in rows {
                conn.execute(
                    "INSERT INTO photos (path, name, size, mtime, taken_at, kind)
                     VALUES (?1, ?1, 100, ?2, ?2, 'image')",
                    params![path, taken],
                )
                .unwrap();
            }
        }
        let mounts = vec![("d1".into(), root.to_path_buf())];
        let names = |q: &str| -> Vec<String> {
            let mut v: Vec<String> = list_photos(
                &mounts,
                None,
                &ListFilter {
                    q: Some(q.into()),
                    ..Default::default()
                },
                50,
                0,
            )
            .unwrap()
            .items
            .iter()
            .map(|p| p.path.clone())
            .collect();
            v.sort();
            v
        };

        // "september 19" is month+day, not a filename substring — every
        // year's Sep 19 matches.
        let sep19 = ["sep19-2023.jpg", "sep19-2024.jpg"];
        assert_eq!(names("september 19"), sep19);
        assert_eq!(names("sep 19th"), sep19);
        assert_eq!(names("the 19th of september"), sep19);
        assert_eq!(names("the 19th"), sep19);
        assert_eq!(names("9/19"), sep19);
        // With a year it narrows to one date.
        assert_eq!(names("september 19 2024"), ["sep19-2024.jpg"]);
        assert_eq!(names("19/9/2024"), ["sep19-2024.jpg"]);
        assert_eq!(names("easter 2024"), ["easter-2024.jpg"]);
    }

    #[test]
    fn month_day_matches_same_day_across_years() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        adopt(root, "d1");
        {
            let conn = open_drive_db(root).unwrap();
            // (path, mtime, taken_at) — same UTC month-day across years, one
            // neighbor day, and an undated row whose mtime falls on the day.
            let rows: &[(&str, i64, i64)] = &[
                ("pi-2022.jpg", 1_647_216_000, 1_647_216_000), // 2022-03-14 UTC
                ("pi-2024.jpg", 1_710_417_600, 1_710_417_600), // 2024-03-14 12:00 UTC
                ("other.jpg", 1_678_838_400, 1_678_838_400),   // 2023-03-15 UTC
                ("undated.png", 1_710_374_400, 0),             // mtime 2024-03-14
            ];
            for (path, mtime, taken) in rows {
                conn.execute(
                    "INSERT INTO photos (path, name, size, mtime, taken_at, kind)
                     VALUES (?1, ?1, 100, ?2, ?3, 'image')",
                    params![path, mtime, taken],
                )
                .unwrap();
            }
        }
        let mounts = vec![("d1".into(), root.to_path_buf())];
        let paths = |month_day: Option<&str>| -> Vec<String> {
            let mut v: Vec<String> = list_photos(
                &mounts,
                None,
                &ListFilter {
                    month_day: month_day.map(str::to_string),
                    ..Default::default()
                },
                50,
                0,
            )
            .unwrap()
            .items
            .iter()
            .map(|p| p.path.clone())
            .collect();
            v.sort();
            v
        };

        assert_eq!(
            paths(Some("03-14")),
            ["pi-2022.jpg", "pi-2024.jpg", "undated.png"]
        );
        assert_eq!(paths(Some("03-15")), ["other.jpg"]);
        // Garbage is ignored rather than narrowing the list to nothing.
        assert_eq!(
            paths(Some("3-14")).len(),
            4,
            "invalid month_day must not filter"
        );
        assert_eq!(paths(Some("13-40")).len(), 4);
        assert_eq!(paths(None).len(), 4);
    }

    #[test]
    fn add_album_items_sets_cover_drive_id() {
        let dir = tempfile::tempdir().unwrap();
        let photos_dir = dir.path().join("photos");
        std::fs::create_dir(&photos_dir).unwrap();
        let png = image::RgbaImage::from_pixel(4, 4, image::Rgba([2, 2, 2, 255]));
        png.save(photos_dir.join("x.png")).unwrap();
        scan("d1", &photos_dir).unwrap();
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
        scan("d1", &photos_dir).unwrap();
        let album = create_album(&photos_dir, "d1", "u1", "Trip").unwrap();
        add_album_items(&photos_dir, &album.id, &[("d1".into(), "cover.png".into())]).unwrap();
        update_album(
            &photos_dir,
            &album.id,
            None,
            None,
            Some(("d1".into(), "cover.png".into())),
        )
        .unwrap();
        let got = get_album(&photos_dir, "d1", &album.id).unwrap().unwrap();
        assert_eq!(got.cover_path, "cover.png");
        assert_eq!(got.cover_drive_id, "d1");
    }
}

pub mod exif;
pub mod gallery_indexer;
pub mod heif;
pub mod places;

//! Photo gallery: scans drives for images, generates thumbnails, and serves a
//! timeline. JPEG/PNG/GIF use the pure-Rust `image` crate. HEIC/HEIF thumbs use
//! an embedded JPEG when present, otherwise Alpine `libheif-tools` (`heif-dec`).
//! Capture dates come from EXIF, not file mtime. Originals are never rewritten.

use std::path::{Path, PathBuf};

use image::{ImageFormat, ImageReader};
use rusqlite::{Connection, params};
use serde::Serialize;

const THUMB_MAX: u32 = 400;
const IMAGE_EXTS: &[&str] = &["jpg", "jpeg", "png", "gif", "heic", "heif", "hif"];
const MAX_IMAGE_DIM: u32 = 16_384;
const MAX_DECODE_BYTES: u64 = 512 * 1024 * 1024;

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
}

#[derive(Debug, Default)]
pub struct ScanReport {
    pub found: u64,
    pub thumbnailed: u64,
    pub failed: u64,
}

pub fn is_image(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| IMAGE_EXTS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

pub fn thumb_path(thumb_dir: &Path, drive_id: &str, rel: &str) -> PathBuf {
    let key = format!("{drive_id}:{rel}");
    let hash = blake3::hash(key.as_bytes()).to_hex().to_string();
    thumb_dir.join(format!("{hash}.jpg"))
}

/// Walk one drive and refresh its photo rows + thumbnails. Blocking; callers
/// run this on the background pool.
///
/// Unchanged files (same size + mtime, thumb still on disk) are skipped so a
/// re-scan of a large library does not re-decode every HEIC.
pub fn scan_drive(
    conn: &Connection,
    drive_id: &str,
    root: &Path,
    thumb_dir: &Path,
) -> anyhow::Result<ScanReport> {
    std::fs::create_dir_all(thumb_dir)?;
    let mut report = ScanReport::default();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir)? {
            let entry = entry?;
            let meta = std::fs::symlink_metadata(entry.path())?;
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                stack.push(entry.path());
                continue;
            }
            if !meta.is_file() || !is_image(&entry.path()) {
                continue;
            }
            let path_buf = entry.path();
            let Some(rel) = path_buf.strip_prefix(root).ok().and_then(|p| p.to_str()) else {
                continue;
            };
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

            let dest = thumb_path(thumb_dir, drive_id, rel);
            if let Ok(Some((old_size, old_mtime, old_thumb))) =
                photo_cache_row(conn, drive_id, rel)
                && old_size == size
                && old_mtime == mtime
                && !old_thumb.is_empty()
                && dest.exists()
            {
                report.found += 1;
                continue;
            }

            let taken_at = crate::exif::capture_unix(&path_buf).unwrap_or(mtime);

            let mut width = 0;
            let mut height = 0;
            let mut thumb = String::new();
            match ensure_thumb(&entry.path(), &dest) {
                Ok((w, h, made)) => {
                    width = w;
                    height = h;
                    thumb = format!(
                        "/api/v1/gallery/thumb?drive_id={drive_id}&path={}",
                        urlencode(rel)
                    );
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

            conn.execute(
                "INSERT INTO photos (drive_id, path, name, size, mtime, taken_at, width, height, thumb)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                 ON CONFLICT(drive_id, path) DO UPDATE SET
                   size = excluded.size, mtime = excluded.mtime,
                   taken_at = excluded.taken_at,
                   width = excluded.width, height = excluded.height, thumb = excluded.thumb",
                params![
                    drive_id,
                    rel,
                    name,
                    size,
                    mtime,
                    taken_at,
                    width as i64,
                    height as i64,
                    thumb
                ],
            )?;
        }
    }
    Ok(report)
}

fn photo_cache_row(
    conn: &Connection,
    drive_id: &str,
    rel: &str,
) -> anyhow::Result<Option<(i64, i64, String)>> {
    let mut stmt =
        conn.prepare("SELECT size, mtime, thumb FROM photos WHERE drive_id = ?1 AND path = ?2")?;
    let mut rows = stmt.query(params![drive_id, rel])?;
    if let Some(row) = rows.next()? {
        Ok(Some((row.get(0)?, row.get(1)?, row.get(2)?)))
    } else {
        Ok(None)
    }
}

/// Generate a 400px JPEG thumbnail. Returns (width, height, was_created).
pub fn ensure_thumb(src: &Path, dest: &Path) -> anyhow::Result<(u32, u32, bool)> {
    if dest.exists() {
        return Ok((0, 0, false));
    }
    if crate::heif::is_heif(src) {
        return ensure_heif_thumb(src, dest);
    }
    decode_and_save_thumb(src, dest)
}

fn ensure_heif_thumb(src: &Path, dest: &Path) -> anyhow::Result<(u32, u32, bool)> {
    let bytes = std::fs::read(src)?;
    if let Some(jpeg) = crate::heif::jpeg_item_from_heif(&bytes) {
        let work = dest.with_extension("src.jpg");
        std::fs::write(&work, jpeg)?;
        let result = decode_and_save_thumb(&work, dest);
        let _ = std::fs::remove_file(&work);
        return result;
    }
    let decoded = dest.with_extension("heic-src.jpg");
    crate::heif::decode_heif_to_jpeg(src, &decoded)?;
    let result = decode_and_save_thumb(&decoded, dest);
    let _ = std::fs::remove_file(&decoded);
    result
}

fn decode_and_save_thumb(src: &Path, dest: &Path) -> anyhow::Result<(u32, u32, bool)> {
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_IMAGE_DIM);
    limits.max_image_height = Some(MAX_IMAGE_DIM);
    limits.max_alloc = Some(MAX_DECODE_BYTES);
    let mut reader = ImageReader::open(src)?;
    reader.limits(limits);
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

pub fn list_photos(
    conn: &Connection,
    drive_id: Option<&str>,
    limit: u32,
    offset: u32,
) -> anyhow::Result<Vec<Photo>> {
    let map_row = |row: &rusqlite::Row<'_>| {
        Ok(Photo {
            drive_id: row.get(0)?,
            path: row.get(1)?,
            name: row.get(2)?,
            size: row.get::<_, i64>(3)? as u64,
            taken_at: row.get(4)?,
            width: row.get::<_, i64>(5)? as u32,
            height: row.get::<_, i64>(6)? as u32,
            thumb: row.get(7)?,
        })
    };
    let sort_expr = "COALESCE(NULLIF(taken_at, 0), mtime)";
    let photos = if let Some(drive_id) = drive_id {
        let mut stmt = conn.prepare(&format!(
            "SELECT drive_id, path, name, size, {sort_expr}, width, height, thumb
             FROM photos WHERE drive_id = ?1
             ORDER BY {sort_expr} DESC, path LIMIT ?2 OFFSET ?3"
        ))?;
        let rows = stmt.query_map(params![drive_id, limit as i64, offset as i64], map_row)?;
        rows.collect::<Result<Vec<_>, _>>()?
    } else {
        let mut stmt = conn.prepare(&format!(
            "SELECT drive_id, path, name, size, {sort_expr}, width, height, thumb
             FROM photos
             ORDER BY {sort_expr} DESC, path LIMIT ?1 OFFSET ?2"
        ))?;
        let rows = stmt.query_map(params![limit as i64, offset as i64], map_row)?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    Ok(photos)
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

        let (w, h, made) = ensure_thumb(&src, &dest).unwrap();
        assert_eq!((w, h), (800, 600));
        assert!(made && dest.exists());

        let (_, _, made_again) = ensure_thumb(&src, &dest).unwrap();
        assert!(!made_again, "cached thumbs are not regenerated");
    }

    #[test]
    fn image_extension_detection() {
        assert!(is_image(Path::new("photo.JPG")));
        assert!(is_image(Path::new("a/b/photo.png")));
        assert!(is_image(Path::new("IMG_0001.HEIC")));
        assert!(!is_image(Path::new("video.mp4")));
    }

    fn insert_photo(conn: &Connection, drive_id: &str, path: &str, mtime: i64) {
        conn.execute(
            "INSERT INTO photos (drive_id, path, name, size, mtime, width, height, thumb)
             VALUES (?1, ?2, ?3, 1, ?4, 0, 0, '')",
            params![drive_id, path, path, mtime],
        )
        .unwrap();
    }

    #[test]
    fn list_photos_all_drives_or_one() {
        let dir = tempfile::tempdir().unwrap();
        let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
        insert_photo(&conn, "drive-a", "a.jpg", 20);
        insert_photo(&conn, "drive-b", "b.jpg", 10);

        let all = list_photos(&conn, None, 10, 0).unwrap();
        assert_eq!(
            all.iter().map(|p| p.path.as_str()).collect::<Vec<_>>(),
            vec!["a.jpg", "b.jpg"]
        );

        let one = list_photos(&conn, Some("drive-b"), 10, 0).unwrap();
        assert_eq!(one.len(), 1);
        assert_eq!(one[0].drive_id, "drive-b");
    }

    #[test]
    fn scan_skips_unchanged_photos() {
        let dir = tempfile::tempdir().unwrap();
        let photos_dir = dir.path().join("photos");
        std::fs::create_dir(&photos_dir).unwrap();
        let src = photos_dir.join("same.png");
        let png = image::RgbaImage::from_pixel(16, 16, image::Rgba([9, 9, 9, 255]));
        png.save(&src).unwrap();

        let db = crate::db::open(&dir.path().join("luna.db")).unwrap();
        let thumbs = dir.path().join("thumbs");
        let first = scan_drive(&db, "d1", &photos_dir, &thumbs).unwrap();
        assert_eq!(first.found, 1);
        assert_eq!(first.thumbnailed, 1);

        let second = scan_drive(&db, "d1", &photos_dir, &thumbs).unwrap();
        assert_eq!(second.found, 1);
        assert_eq!(
            second.thumbnailed, 0,
            "unchanged photos must not be re-thumbnailed"
        );
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

        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch(
            "CREATE TABLE photos (
                drive_id TEXT, path TEXT, name TEXT, size INTEGER, mtime INTEGER,
                taken_at INTEGER NOT NULL DEFAULT 0, width INTEGER, height INTEGER, thumb TEXT,
                PRIMARY KEY (drive_id, path))",
        )
        .unwrap();
        let thumbs = dir.path().join("thumbs");
        scan_drive(&db, "d1", &photos_dir, &thumbs).unwrap();
        let photos = list_photos(&db, Some("d1"), 10, 0).unwrap();
        assert_eq!(photos.len(), 2);
        assert_eq!(photos[0].name, "recent.png");
        assert_eq!(photos[1].name, "from-phone.jpg");
        assert_eq!(
            photos[1].taken_at,
            crate::exif::parse_exif_datetime("2010:01:01 00:00:00").unwrap()
        );
    }
}

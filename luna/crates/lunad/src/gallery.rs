//! Photo gallery: scans drives for images, generates thumbnails, and serves a
//! timeline. Pure-Rust `image` crate; HEIC/AVIF are listed but not thumbnailed
//! until libvips lands on Luna OS.

use std::path::{Path, PathBuf};

use image::{ImageFormat, ImageReader};
use rusqlite::{Connection, params};
use serde::Serialize;

const THUMB_MAX: u32 = 400;
const IMAGE_EXTS: &[&str] = &["jpg", "jpeg", "png", "gif"];

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
            let rel = entry
                .path()
                .strip_prefix(root)
                .unwrap_or(&entry.path())
                .to_string_lossy()
                .into_owned();
            let name = entry.file_name().to_string_lossy().into_owned();
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);

            let mut width = 0;
            let mut height = 0;
            let mut thumb = String::new();
            match ensure_thumb(&entry.path(), &thumb_path(thumb_dir, drive_id, &rel)) {
                Ok((w, h, made)) => {
                    width = w;
                    height = h;
                    thumb = format!(
                        "/api/v1/gallery/thumb?drive_id={drive_id}&path={}",
                        urlencode(&rel)
                    );
                    report.found += 1;
                    if made {
                        report.thumbnailed += 1;
                    }
                }
                Err(_) => {
                    // Broken/unsupported image: still list it so the user can
                    // download the original; thumbnailing failed safely.
                    report.found += 1;
                    report.failed += 1;
                }
            }

            conn.execute(
                "INSERT INTO photos (drive_id, path, name, size, mtime, width, height, thumb)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT(drive_id, path) DO UPDATE SET
                   size = excluded.size, mtime = excluded.mtime,
                   width = excluded.width, height = excluded.height, thumb = excluded.thumb",
                params![
                    drive_id,
                    rel,
                    name,
                    meta.len() as i64,
                    mtime,
                    width as i64,
                    height as i64,
                    thumb
                ],
            )?;
        }
    }
    Ok(report)
}

/// Generate a 400px JPEG thumbnail. Returns (width, height, was_created).
pub fn ensure_thumb(src: &Path, dest: &Path) -> anyhow::Result<(u32, u32, bool)> {
    if dest.exists() {
        return Ok((0, 0, false));
    }
    let img = ImageReader::open(src)?.decode()?;
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
    drive_id: &str,
    limit: u32,
    offset: u32,
) -> anyhow::Result<Vec<Photo>> {
    let mut stmt = conn.prepare(
        "SELECT drive_id, path, name, size, mtime, width, height, thumb
         FROM photos WHERE drive_id = ?1
         ORDER BY mtime DESC, path LIMIT ?2 OFFSET ?3",
    )?;
    let rows = stmt.query_map(params![drive_id, limit as i64, offset as i64], |row| {
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
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
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
        assert!(!is_image(Path::new("video.mp4")));
    }
}

//! Grid-sized thumbnails (`/api/v1/photos/thumb?…&size=s`, W7/W8).
//!
//! The regular thumbnail is 640 px on the long edge (~65 KB), sized for 2x
//! screens. A timeline cell on a 1x laptop is ~200 px, so over a remote link
//! most of those bytes are wasted: a screen of 20 cells took ~1.8 s at
//! 20 Mbit/s. The web asks for this variant (a few KB for a typical photo)
//! through `srcset` only where the cell is small enough.
//!
//! It is lossy WebP, not JPEG: at the same look it is ~40–60% smaller than
//! the JPEG it replaced (4:4:4, fixed Huffman tables), which is most of
//! what a scrub over a remote link waits for. Every browser decodes it, and
//! only the web asks for this size; other clients keep the 640 px JPEG.
//!
//! It is made from the 640 px thumbnail (a cheap decode, not the original
//! photo), stored next to it as `{hash}.s.v{gen}.webp` (kept by the scan's
//! old-recipe sweep), and counts as missing whenever the 640 px file is
//! newer, so a replaced thumbnail never leaves a stale small one behind.
//! A missing one is never built inside the request: on a 3040 a screen of
//! those builds took ~250 ms each and slowed the first visit down. The
//! request gets the 640 px thumbnail instead and one idle-priority thread
//! builds the small one for next time. It skips the RAM cache: that cache
//! is keyed by photo and dropped when the big thumbnail changes, and the
//! page cache already holds these small files.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{SyncSender, TrySendError};
use std::sync::{Mutex, OnceLock};

use axum::Json;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::Response;
use serde_json::Value;

use crate::api::response::json_error;

/// Long-edge cap. 4:3 photos keep a 270 px short edge, which the web's
/// `srcset` declares, so a square cover crop is never upscaled.
const SMALL_MAX: u32 = 360;
/// libwebp's quality scale. At a ~200 px grid cell 60 looks the same as 75,
/// and with the slowest method (6) real photos come out ~20% smaller than at
/// 75 with the default method: the bytes are most of what a scrub over a
/// remote link waits for (W8). Method 6 takes ~3× the encode time, spent
/// once per photo on the idle-priority builder thread.
const SMALL_WEBP_QUALITY: f32 = 60.0;
const SMALL_WEBP_METHOD: i32 = 6;
pub(super) const SMALL_CONTENT_TYPE: &str = "image/webp";
/// Our own 640 px thumbnails are well under this; anything bigger is not one.
const SOURCE_MAX_BYTES: u64 = 4 * 1024 * 1024;
/// Builds waiting for the worker. A scrub through a large library asks for
/// far more than one thread can make; the rest are asked for again on the
/// next visit.
const QUEUE_MAX: usize = 512;

/// `{hash}.v2.jpg` → `{hash}.s.v2.webp`, in the same directory.
pub(super) fn small_path(big: &Path) -> Option<PathBuf> {
    crate::photos::small_thumb_path(big)
}

fn modified(meta: &std::fs::Metadata) -> Option<std::time::SystemTime> {
    meta.modified().ok()
}

/// Build `small` from the 640 px thumbnail `big`. Written to a temp file and
/// renamed, so a concurrent request never reads half a file.
pub(super) fn build_small(big: &Path, small: &Path) -> anyhow::Result<()> {
    use fast_image_resize::{FilterType, ResizeAlg, ResizeOptions, Resizer};
    let mut file = super::open_checked(big)?;
    let len = file.metadata()?.len();
    if len > SOURCE_MAX_BYTES {
        anyhow::bail!("thumbnail is unexpectedly large");
    }
    let mut bytes = Vec::with_capacity(len as usize);
    std::io::Read::read_to_end(&mut file, &mut bytes)?;
    let img = image::load_from_memory_with_format(&bytes, image::ImageFormat::Jpeg)?;
    drop(bytes);
    let (w, h) = (img.width(), img.height());
    let ratio = f64::min(
        f64::from(SMALL_MAX) / f64::from(w),
        f64::from(SMALL_MAX) / f64::from(h),
    )
    .min(1.0);
    let dw = ((f64::from(w) * ratio).round() as u32).max(1);
    let dh = ((f64::from(h) * ratio).round() as u32).max(1);
    let out = if (dw, dh) == (w, h) {
        img
    } else {
        let mut dst = image::DynamicImage::new(dw, dh, img.color());
        let options = ResizeOptions::new().resize_alg(ResizeAlg::Convolution(FilterType::Lanczos3));
        Resizer::new().resize(&img, &mut dst, &options)?;
        dst
    };
    let rgb = out.into_rgb8();
    let mut config = webp::WebPConfig::new().map_err(|()| anyhow::anyhow!("WebP config failed"))?;
    config.lossless = 0;
    config.alpha_compression = 1;
    config.quality = SMALL_WEBP_QUALITY;
    config.method = SMALL_WEBP_METHOD;
    let encoded = webp::Encoder::from_rgb(rgb.as_raw(), rgb.width(), rgb.height())
        .encode_advanced(&config)
        .map_err(|e| anyhow::anyhow!("WebP encode failed: {e:?}"))?;
    let tmp = small.with_extension("webp.tmp");
    if let Err(e) = std::fs::write(&tmp, &*encoded) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.into());
    }
    std::fs::rename(&tmp, small)?;
    Ok(())
}

/// True when `small` exists and is at least as new as `big`.
fn is_fresh(big: &Path, small: &Path) -> bool {
    let Some(big_time) = std::fs::metadata(big).ok().as_ref().and_then(modified) else {
        return false;
    };
    std::fs::symlink_metadata(small)
        .ok()
        .filter(|m| m.is_file())
        .as_ref()
        .and_then(modified)
        .is_some_and(|t| t >= big_time)
}

/// Read the small thumbnail for the 640 px file `big`, or `None` when it
/// isn't built (or is older than `big`).
fn read_small(big: &Path, if_none_match: Option<&str>) -> Option<super::ThumbFetch> {
    let small = small_path(big)?;
    if !is_fresh(big, &small) {
        return None;
    }
    let mut file = super::open_checked(&small).ok()?;
    let meta = file.metadata().ok()?;
    let mtime_secs = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let etag = crate::drives::ram_cache::thumb_etag_header(meta.len(), mtime_secs);
    if if_none_match.is_some_and(|v| v.split(',').any(|c| c.trim() == etag)) {
        return Some(super::ThumbFetch::NotModified(etag));
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    std::io::Read::read_to_end(&mut file, &mut bytes).ok()?;
    Some(super::ThumbFetch::Bytes(
        crate::drives::ram_cache::ThumbBytes {
            bytes: bytes.into(),
            etag,
        },
    ))
}

struct Builder {
    tx: SyncSender<PathBuf>,
    /// 640 px thumbnails queued or being built, so a re-request while one
    /// waits doesn't queue it twice.
    pending: Mutex<HashSet<PathBuf>>,
}

fn builder() -> &'static Builder {
    static BUILDER: OnceLock<Builder> = OnceLock::new();
    BUILDER.get_or_init(|| {
        let (tx, rx) = std::sync::mpsc::sync_channel::<PathBuf>(QUEUE_MAX);
        let spawned = std::thread::Builder::new()
            .name("small-thumbs".into())
            .spawn(move || {
                idle_priority();
                while let Ok(big) = rx.recv() {
                    if let Some(small) = small_path(&big)
                        && !is_fresh(&big, &small)
                        && let Err(e) = build_small(&big, &small)
                    {
                        tracing::debug!(error = %e, "small thumbnail build failed");
                    }
                    if let Ok(mut pending) = builder().pending.lock() {
                        pending.remove(&big);
                    }
                }
            });
        if let Err(e) = spawned {
            tracing::warn!(error = %e, "couldn't start the small thumbnail builder");
        }
        Builder {
            tx,
            pending: Mutex::new(HashSet::new()),
        }
    })
}

/// Ask the background thread to build the small thumbnail for `big`.
fn queue_build(big: PathBuf) {
    let b = builder();
    let Ok(mut pending) = b.pending.lock() else {
        return;
    };
    if !pending.insert(big.clone()) {
        return;
    }
    match b.tx.try_send(big) {
        Ok(()) => {}
        Err(TrySendError::Full(big) | TrySendError::Disconnected(big)) => {
            pending.remove(&big);
        }
    }
}

/// Run this thread at idle CPU priority (Linux `SCHED_IDLE`), so building
/// small thumbnails never takes a core from a request.
fn idle_priority() {
    #[cfg(target_os = "linux")]
    // SAFETY: plain syscalls on the calling thread; an all-zero
    // `sched_param` is valid (priority 0, which SCHED_IDLE requires).
    unsafe {
        let param: libc::sched_param = std::mem::zeroed();
        if libc::sched_setscheduler(0, libc::SCHED_IDLE, &param) != 0 {
            let _ = libc::setpriority(libc::PRIO_PROCESS, 0, 19);
        }
    }
}

/// The 640 px thumbnail answered a `size=s` request because the small one
/// isn't built yet: the browser must ask again next time (a 304 while it is
/// still missing) instead of keeping the big bytes under the small URL for
/// the regular hour.
pub(super) fn mark_stand_in(resp: &mut Response) {
    resp.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("private, no-cache"),
    );
}

/// Serve the small thumbnail for the 640 px file `big`, or `None` when it
/// isn't built yet: the caller then serves `big`, and the small one is
/// queued for next time.
pub(super) async fn serve_if_built(
    big: PathBuf,
    headers: &HeaderMap,
) -> Result<Option<Response>, (StatusCode, Json<Value>)> {
    let if_none_match = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let big2 = big.clone();
    let fetched = tokio::task::spawn_blocking(move || read_small(&big2, if_none_match.as_deref()))
        .await
        .map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't read the thumbnail.",
            )
        })?;
    match fetched {
        None => {
            queue_build(big);
            Ok(None)
        }
        Some(super::ThumbFetch::NotModified(etag)) => Ok(Some(super::not_modified_response(etag))),
        Some(super::ThumbFetch::Bytes(entry)) => {
            super::serve_thumb_bytes(entry.bytes, SMALL_CONTENT_TYPE, entry.etag, headers).map(Some)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_jpeg(path: &Path, w: u32, h: u32) {
        let img = image::RgbImage::from_fn(w, h, |x, y| {
            image::Rgb([(x % 256) as u8, (y % 256) as u8, ((x + y) % 256) as u8])
        });
        image::DynamicImage::ImageRgb8(img)
            .save_with_format(path, image::ImageFormat::Jpeg)
            .unwrap();
    }

    #[test]
    fn small_name_keeps_the_recipe_suffix() {
        let p = small_path(Path::new("/t/abc123.v2.jpg")).unwrap();
        assert_eq!(p, Path::new("/t/abc123.s.v2.webp"));
        assert!(p.to_str().unwrap().ends_with(".v2.webp"));
    }

    #[test]
    fn builds_a_smaller_copy_that_fits() {
        let dir = tempfile::tempdir().unwrap();
        let big = dir.path().join("h.v2.jpg");
        write_jpeg(&big, 640, 480);
        let small = small_path(&big).unwrap();
        build_small(&big, &small).unwrap();
        let bytes = std::fs::read(&small).unwrap();
        assert_eq!((&bytes[..4], &bytes[8..12]), (&b"RIFF"[..], &b"WEBP"[..]));
        assert_eq!(webp_size(&bytes), (360, 270));
        assert!(bytes.len() < std::fs::metadata(&big).unwrap().len() as usize);
    }

    fn webp_size(bytes: &[u8]) -> (u32, u32) {
        let img = webp::Decoder::new(bytes).decode().expect("a WebP image");
        (img.width(), img.height())
    }

    fn bytes(fetch: Option<super::super::ThumbFetch>) -> bytes::Bytes {
        match fetch {
            Some(super::super::ThumbFetch::Bytes(entry)) => entry.bytes,
            _ => panic!("expected the small thumbnail's bytes"),
        }
    }

    #[test]
    fn missing_or_stale_small_thumb_is_not_served() {
        let dir = tempfile::tempdir().unwrap();
        let big = dir.path().join("h.v2.jpg");
        write_jpeg(&big, 480, 640);
        assert!(read_small(&big, None).is_none(), "nothing built yet");
        let small = small_path(&big).unwrap();
        build_small(&big, &small).unwrap();
        assert_eq!(webp_size(&bytes(read_small(&big, None))), (270, 360));
        // The 640 px thumbnail is replaced (say, a full-quality one after a
        // quick preview): the old small one must not be served.
        let old = std::fs::File::options().write(true).open(&small).unwrap();
        old.set_modified(std::time::SystemTime::UNIX_EPOCH).unwrap();
        drop(old);
        write_jpeg(&big, 640, 480);
        assert!(read_small(&big, None).is_none(), "older than the big one");
        build_small(&big, &small).unwrap();
        assert_eq!(webp_size(&bytes(read_small(&big, None))), (360, 270));
    }

    #[test]
    fn queued_build_happens_in_the_background() {
        let dir = tempfile::tempdir().unwrap();
        let big = dir.path().join("q.v2.jpg");
        write_jpeg(&big, 640, 480);
        queue_build(big.clone());
        let small = small_path(&big).unwrap();
        for _ in 0..200 {
            if is_fresh(&big, &small) {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        panic!("the small thumbnail was never built");
    }

    #[tokio::test]
    async fn stand_in_is_not_kept_for_an_hour() {
        let bytes = bytes::Bytes::from_static(b"jpeg");
        let mut resp = super::super::serve_thumb_bytes(
            bytes,
            "image/jpeg",
            header::HeaderValue::from_static("\"e\""),
            &HeaderMap::new(),
        )
        .unwrap();
        assert!(
            resp.headers()[header::CACHE_CONTROL]
                .to_str()
                .unwrap()
                .contains("max-age=3600")
        );
        mark_stand_in(&mut resp);
        assert_eq!(resp.headers()[header::CACHE_CONTROL], "private, no-cache");
    }

    #[test]
    fn answers_a_matching_validator_without_the_body() {
        let dir = tempfile::tempdir().unwrap();
        let big = dir.path().join("h.v2.jpg");
        write_jpeg(&big, 640, 480);
        build_small(&big, &small_path(&big).unwrap()).unwrap();
        let etag = match read_small(&big, None) {
            Some(super::super::ThumbFetch::Bytes(entry)) => entry.etag,
            _ => panic!("expected the small thumbnail"),
        };
        assert!(matches!(
            read_small(&big, Some(etag.to_str().unwrap())),
            Some(super::super::ThumbFetch::NotModified(_))
        ));
    }
}

//! Runtime memory budgets from `/proc/meminfo`.
//!
//! Luna targets thin clients (Wyse 3040: 2 GiB RAM). Hard-coded GiB ceilings
//! OOM the box; every large buffer is sized from `MemAvailable` instead, with
//! floors that still match the web client's chunk/multipart sizes.

use std::fs;
use std::sync::OnceLock;

const KIB: u64 = 1024;
const MIB: u64 = 1024 * 1024;

/// Floors match `luna/web` (`CHUNK_SIZE` / `MULTIPART_LIMIT`).
pub const MIN_UPLOAD_CHUNK_BYTES: usize = 8 * MIB as usize;
pub const MIN_MULTIPART_BYTES: usize = 32 * MIB as usize;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MemInfo {
    pub total_bytes: u64,
    pub available_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    pub available_bytes: u64,
    pub total_bytes: u64,
    /// Cap for `image` crate decode allocations.
    pub decode_max_bytes: u64,
    /// Cap for reading a source photo into RAM (HEIC parse / EXIF).
    pub source_max_bytes: u64,
    pub max_image_dim: u32,
    /// Buffered upload chunk (axum `Bytes` extractor).
    pub upload_chunk_bytes: usize,
    /// Multipart body limit (streamed to disk, still capped).
    pub multipart_upload_bytes: usize,
    /// Max bytes streamed for a software-update binary.
    pub update_download_bytes: u64,
    /// How many concurrent `heif-dec` children are allowed.
    pub heif_concurrency: usize,
}

/// Read current memory; fall back to a conservative 2 GiB / 512 MiB profile
/// when `/proc/meminfo` is missing (tests, odd hosts).
pub fn meminfo() -> MemInfo {
    parse_meminfo(&fs::read_to_string("/proc/meminfo").unwrap_or_default()).unwrap_or(MemInfo {
        total_bytes: 2 * 1024 * MIB,
        available_bytes: 512 * MIB,
    })
}

pub fn limits() -> Limits {
    let m = meminfo();
    limits_from(m.available_bytes, m.total_bytes)
}

/// Pure policy used by production and unit tests.
pub fn limits_from(available_bytes: u64, total_bytes: u64) -> Limits {
    let avail = available_bytes.max(1);
    // One eighth of free RAM for a single allocation, clamped.
    let eighth = avail / 8;

    let decode_max_bytes = clamp(eighth, 8 * MIB, 48 * MIB).min(avail / 4).max(8 * MIB);
    let source_max_bytes = clamp(avail / 6, 8 * MIB, 64 * MIB)
        .min(avail / 3)
        .max(8 * MIB);

    // Client always sends 8 MiB chunks. Allow up to 16 MiB when RAM is healthy.
    let upload_chunk_bytes = clamp(eighth, MIN_UPLOAD_CHUNK_BYTES as u64, 16 * MIB)
        .min(avail / 4)
        .max(MIN_UPLOAD_CHUNK_BYTES as u64) as usize;

    // Client switches to chunked above 32 MiB. Keep that floor; raise only a little.
    let multipart_upload_bytes = clamp(avail / 2, MIN_MULTIPART_BYTES as u64, 64 * MIB)
        .max(MIN_MULTIPART_BYTES as u64) as usize;

    // Release binaries are ~15 MiB today; refuse absurd downloads.
    let update_download_bytes = clamp(avail / 2, 32 * MIB, 128 * MIB);

    let max_image_dim = if avail < 256 * MIB {
        4096
    } else if avail < 768 * MIB {
        6144
    } else {
        8192
    };

    let heif_concurrency = if avail < 384 * MIB {
        1
    } else if avail < 1024 * MIB {
        1
    } else {
        2
    };

    let _ = total_bytes; // reserved for future total-based policy
    Limits {
        available_bytes: avail,
        total_bytes,
        decode_max_bytes,
        source_max_bytes,
        max_image_dim,
        upload_chunk_bytes,
        multipart_upload_bytes,
        update_download_bytes,
        heif_concurrency,
    }
}

/// Blocking HEIF slot (gallery runs on `spawn_blocking`).
pub fn acquire_heif_slot_blocking() -> HeifPermit {
    static BLOCKING: OnceLock<std::sync::Mutex<()>> = OnceLock::new();
    // Serialize HEIF child processes. On a 2 GiB box two heif-dec peaks can OOM.
    let lock = BLOCKING.get_or_init(|| std::sync::Mutex::new(()));
    let guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    HeifPermit { _guard: guard }
}

pub struct HeifPermit {
    _guard: std::sync::MutexGuard<'static, ()>,
}

fn clamp(v: u64, min: u64, max: u64) -> u64 {
    v.max(min).min(max)
}

fn parse_meminfo(text: &str) -> Option<MemInfo> {
    let mut total_kib = None;
    let mut avail_kib = None;
    let mut free_kib = None;
    let mut buffers_kib = None;
    let mut cached_kib = None;
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        let Some(key) = parts.next() else { continue };
        let Some(val) = parts.next().and_then(|v| v.parse::<u64>().ok()) else {
            continue;
        };
        match key {
            "MemTotal:" => total_kib = Some(val),
            "MemAvailable:" => avail_kib = Some(val),
            "MemFree:" => free_kib = Some(val),
            "Buffers:" => buffers_kib = Some(val),
            "Cached:" => cached_kib = Some(val),
            _ => {}
        }
    }
    let total_bytes = total_kib? * KIB;
    let available_bytes = if let Some(a) = avail_kib {
        a * KIB
    } else {
        // Pre-MemAvailable kernels: free + buffers + cached.
        (free_kib.unwrap_or(0) + buffers_kib.unwrap_or(0) + cached_kib.unwrap_or(0)) * KIB
    };
    Some(MemInfo {
        total_bytes,
        available_bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wyse_like_budget_stays_small() {
        // ~2 GiB box with ~400 MiB free after kernel + page cache.
        let l = limits_from(400 * MIB, 2 * 1024 * MIB);
        assert!(l.decode_max_bytes <= 48 * MIB);
        assert!(l.decode_max_bytes <= 400 * MIB / 4);
        assert!(l.source_max_bytes <= 64 * MIB);
        assert!(l.upload_chunk_bytes >= MIN_UPLOAD_CHUNK_BYTES);
        assert!(l.upload_chunk_bytes <= 16 * MIB as usize);
        assert!(l.multipart_upload_bytes >= MIN_MULTIPART_BYTES);
        assert!(l.multipart_upload_bytes <= 64 * MIB as usize);
        assert!(l.update_download_bytes <= 128 * MIB);
        assert_eq!(l.heif_concurrency, 1);
        assert!(l.max_image_dim <= 8192);
    }

    #[test]
    fn healthy_host_raises_caps_a_little() {
        let l = limits_from(8 * 1024 * MIB, 16 * 1024 * MIB);
        assert_eq!(l.decode_max_bytes, 48 * MIB);
        assert_eq!(l.upload_chunk_bytes, 16 * MIB as usize);
        assert_eq!(l.multipart_upload_bytes, 64 * MIB as usize);
        assert_eq!(l.heif_concurrency, 2);
    }

    #[test]
    fn parses_meminfo_sample() {
        let sample = "\
MemTotal:        2048000 kB
MemFree:          100000 kB
MemAvailable:     450000 kB
Buffers:           20000 kB
Cached:           300000 kB
";
        let m = parse_meminfo(sample).unwrap();
        assert_eq!(m.total_bytes, 2048000 * KIB);
        assert_eq!(m.available_bytes, 450000 * KIB);
    }

    #[test]
    fn live_meminfo_readable_on_linux() {
        let m = meminfo();
        assert!(m.total_bytes > 0);
        assert!(m.available_bytes > 0);
    }
}

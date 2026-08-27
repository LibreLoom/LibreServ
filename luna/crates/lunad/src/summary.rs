//! Lightweight drive summaries for the home dashboard.
//!
//! Space comes from `statvfs` (one syscall). Folder/file counts and shortcuts
//! come from a single non-recursive top-level `read_dir` — never a full tree
//! walk, so a large drive stays cheap to summarize.

use std::ffi::CString;
use std::fs;
use std::os::unix::ffi::OsStrExt;
use std::path::Path;

use luna_core::scan::TopLevelSummary;

/// Preferred folder names shown first as shortcuts when present at the root.
const PREFERRED_FOLDERS: &[&str] = &[
    "Documents",
    "Photos",
    "Pictures",
    "Movies",
    "Videos",
    "Music",
    "Downloads",
    "Desktop",
    "DCIM",
];

/// OS / vendor folders that are not useful home shortcuts.
const SKIP_FOLDERS: &[&str] = &[
    "System Volume Information",
    "$RECYCLE.BIN",
    "RECYCLER",
    ".Spotlight-V100",
    ".fseventsd",
    ".TemporaryItems",
    ".Trashes",
];

const MAX_SHORTCUTS: usize = 6;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DiskSpace {
    pub total_bytes: u64,
    pub free_bytes: u64,
    pub used_bytes: u64,
}

/// Available and total space for a mounted path. Returns `None` if the path
/// cannot be queried (unmounted, permission, etc.).
pub fn disk_space(path: &Path) -> Option<DiskSpace> {
    let c_path = CString::new(path.as_os_str().as_bytes()).ok()?;
    // SAFETY: path is a valid C string; `statvfs` writes into a zeroed buffer.
    unsafe {
        let mut st: libc::statvfs = std::mem::zeroed();
        if libc::statvfs(c_path.as_ptr(), &mut st) != 0 {
            return None;
        }
        let frsize = st.f_frsize as u64;
        let total = (st.f_blocks as u64).saturating_mul(frsize);
        let free = (st.f_bavail as u64).saturating_mul(frsize);
        let used = total.saturating_sub(free);
        Some(DiskSpace {
            total_bytes: total,
            free_bytes: free,
            used_bytes: used,
        })
    }
}

/// Top-level folder names suitable for dashboard shortcuts.
///
/// Skips hidden / Luna-internal directories. Prefers common user folder names,
/// then fills with the remaining names (case-insensitive A–Z), capped at
/// [`MAX_SHORTCUTS`].
pub fn top_level_shortcuts(root: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut names = Vec::new();
    for entry in entries.flatten() {
        let Ok(ft) = entry.file_type() else {
            continue;
        };
        if !ft.is_dir() {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if name.starts_with('.') {
            continue;
        }
        if SKIP_FOLDERS
            .iter()
            .any(|s| s.eq_ignore_ascii_case(&name))
        {
            continue;
        }
        names.push(name);
    }
    names.sort_by(|a, b| {
        let ai = preferred_rank(a);
        let bi = preferred_rank(b);
        ai.cmp(&bi)
            .then_with(|| a.to_ascii_lowercase().cmp(&b.to_ascii_lowercase()))
    });
    names.truncate(MAX_SHORTCUTS);
    names
}

fn preferred_rank(name: &str) -> usize {
    PREFERRED_FOLDERS
        .iter()
        .position(|p| p.eq_ignore_ascii_case(name))
        .unwrap_or(usize::MAX)
}

/// Counts at the drive root only (no recursion).
pub fn top_level_counts(root: &Path) -> TopLevelSummary {
    luna_core::scan::scan_top_level(root)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir() -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        p.push(format!("luna-summary-test-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn disk_space_reads_a_real_path() {
        let root = temp_dir();
        let space = disk_space(&root).expect("statvfs on tempdir");
        assert!(space.total_bytes > 0);
        assert!(space.free_bytes <= space.total_bytes);
        assert_eq!(
            space.used_bytes,
            space.total_bytes.saturating_sub(space.free_bytes)
        );
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn shortcuts_prefer_common_names_and_skip_hidden() {
        let root = temp_dir();
        fs::create_dir(root.join("Zebra")).unwrap();
        fs::create_dir(root.join("Photos")).unwrap();
        fs::create_dir(root.join("Documents")).unwrap();
        fs::create_dir(root.join(".luna")).unwrap();
        fs::create_dir(root.join(".hidden")).unwrap();
        fs::create_dir(root.join("System Volume Information")).unwrap();
        fs::write(root.join("readme.txt"), b"hi").unwrap();

        let names = top_level_shortcuts(&root);
        assert_eq!(names, vec!["Documents", "Photos", "Zebra"]);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn shortcuts_cap_at_six() {
        let root = temp_dir();
        for i in 0..10 {
            fs::create_dir(root.join(format!("folder{i}"))).unwrap();
        }
        assert_eq!(top_level_shortcuts(&root).len(), 6);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn counts_match_scan() {
        let root = temp_dir();
        fs::create_dir(root.join("a")).unwrap();
        fs::write(root.join("b.txt"), b"x").unwrap();
        let s = top_level_counts(&root);
        assert_eq!(s.folders, 1);
        assert_eq!(s.files, 1);
        fs::remove_dir_all(&root).unwrap();
    }
}

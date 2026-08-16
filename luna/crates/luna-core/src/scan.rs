//! Read-only inspection of a foreign drive's top level.
//!
//! This is what powers "We found a 2 TB drive with 431 folders and 3,821
//! files. We haven't changed anything." It only calls metadata APIs and never
//! opens file contents.

use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TopLevelSummary {
    pub folders: u64,
    pub files: u64,
    pub unreadable: u64,
}

/// Scan only the immediate children of `root` (no recursion).
///
/// Any entry that cannot be stat'ed is counted as `unreadable` and reported,
/// never skipped silently.
pub fn scan_top_level(root: &Path) -> TopLevelSummary {
    let mut summary = TopLevelSummary::default();
    let Ok(entries) = fs::read_dir(root) else {
        summary.unreadable += 1;
        return summary;
    };

    for entry in entries.flatten() {
        match entry.file_type() {
            Ok(ft) if ft.is_dir() => summary.folders += 1,
            Ok(ft) if ft.is_file() => summary.files += 1,
            Ok(ft) if ft.is_symlink() => {
                // Symlinks count as files; contents are never followed during inspection.
                summary.files += 1;
            }
            Ok(_) => {}
            Err(_) => summary.unreadable += 1,
        }
    }
    summary
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
        p.push(format!("luna-scan-test-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn counts_top_level_only() {
        let root = temp_dir();
        fs::create_dir(root.join("a")).unwrap();
        fs::create_dir(root.join("b")).unwrap();
        fs::write(root.join("1.txt"), b"1").unwrap();
        fs::write(root.join("a/2.txt"), b"2").unwrap(); // not counted

        let s = scan_top_level(&root);
        assert_eq!(s.folders, 2);
        assert_eq!(s.files, 1);
        assert_eq!(s.unreadable, 0);
        fs::remove_dir_all(&root).unwrap();
    }
}

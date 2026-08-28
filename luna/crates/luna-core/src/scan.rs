//! Read-only inspection of a foreign drive's top level.
//!
//! This is what powers "We found a 2 TB drive with 431 folders and 3,821
//! files. We haven't changed anything." It only calls metadata APIs and never
//! opens file contents.

use std::fs;
use std::path::Path;

/// Cap on named entries returned with a summary (UI preview only).
const PREVIEW_LIMIT: usize = 24;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TopLevelEntry {
    pub name: String,
    /// `"folder"` or `"file"` (symlinks count as files; contents are never followed).
    pub kind: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TopLevelSummary {
    pub folders: u64,
    pub files: u64,
    pub unreadable: u64,
    /// Non-hidden top-level names for a short UI preview (folders first).
    pub entries: Vec<TopLevelEntry>,
}

/// Scan only the immediate children of `root` (no recursion).
///
/// Any entry that cannot be stat'ed is counted as `unreadable` and reported,
/// never skipped silently. Hidden names (leading `.`) are counted but omitted
/// from [`TopLevelSummary::entries`] so the preview matches what people expect.
pub fn scan_top_level(root: &Path) -> TopLevelSummary {
    let mut summary = TopLevelSummary::default();
    let Ok(entries) = fs::read_dir(root) else {
        summary.unreadable += 1;
        return summary;
    };

    let mut preview = Vec::new();

    for entry in entries.flatten() {
        let name = match entry.file_name().into_string() {
            Ok(n) => n,
            Err(_) => {
                summary.unreadable += 1;
                continue;
            }
        };
        let hidden = name.starts_with('.');
        match entry.file_type() {
            Ok(ft) if ft.is_dir() => {
                summary.folders += 1;
                if !hidden {
                    preview.push(TopLevelEntry {
                        name,
                        kind: "folder".into(),
                    });
                }
            }
            Ok(ft) if ft.is_file() || ft.is_symlink() => {
                // Symlinks count as files; contents are never followed during inspection.
                summary.files += 1;
                if !hidden {
                    preview.push(TopLevelEntry {
                        name,
                        kind: "file".into(),
                    });
                }
            }
            Ok(_) => {}
            Err(_) => summary.unreadable += 1,
        }
    }

    preview.sort_by(|a, b| {
        let ak = if a.kind == "folder" { 0 } else { 1 };
        let bk = if b.kind == "folder" { 0 } else { 1 };
        ak.cmp(&bk).then_with(|| {
            a.name
                .to_ascii_lowercase()
                .cmp(&b.name.to_ascii_lowercase())
        })
    });
    preview.truncate(PREVIEW_LIMIT);
    summary.entries = preview;
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
        assert_eq!(
            s.entries,
            vec![
                TopLevelEntry {
                    name: "a".into(),
                    kind: "folder".into()
                },
                TopLevelEntry {
                    name: "b".into(),
                    kind: "folder".into()
                },
                TopLevelEntry {
                    name: "1.txt".into(),
                    kind: "file".into()
                },
            ]
        );
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn preview_skips_hidden_but_still_counts() {
        let root = temp_dir();
        fs::create_dir(root.join(".luna")).unwrap();
        fs::create_dir(root.join("Photos")).unwrap();
        fs::write(root.join(".secret"), b"x").unwrap();
        fs::write(root.join("readme.txt"), b"hi").unwrap();

        let s = scan_top_level(&root);
        assert_eq!(s.folders, 2);
        assert_eq!(s.files, 2);
        assert_eq!(
            s.entries,
            vec![
                TopLevelEntry {
                    name: "Photos".into(),
                    kind: "folder".into()
                },
                TopLevelEntry {
                    name: "readme.txt".into(),
                    kind: "file".into()
                },
            ]
        );
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn preview_caps_at_limit() {
        let root = temp_dir();
        for i in 0..30 {
            fs::write(root.join(format!("f{i}.txt")), b"x").unwrap();
        }
        let s = scan_top_level(&root);
        assert_eq!(s.files, 30);
        assert_eq!(s.entries.len(), PREVIEW_LIMIT);
        fs::remove_dir_all(&root).unwrap();
    }
}

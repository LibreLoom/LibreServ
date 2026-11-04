//! What is using Luna's own disk, and the parts of it that can be cleared.
//!
//! Luna keeps its software, its settings, the editor packs and the temporary
//! copies of documents being edited on one small built-in disk. The packs are
//! the bulk of it and can't go (the editors need them); the temporary copies
//! and half-downloaded updates are the parts that grow and can be swept.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::Serialize;

use crate::drives::summary;

/// A leftover update download older than this is from an install that never
/// finished. A live download is removed as soon as it is used, so nothing
/// this old can still be in flight.
const STALE_DOWNLOAD_SECS: u64 = 24 * 60 * 60;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct StorageItem {
    /// Stable id the web keys on; never shown to anyone.
    pub id: String,
    /// Plain-language name of what this is.
    pub label: String,
    pub bytes: u64,
    /// True when "Free up space" clears this.
    pub removable: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct StorageReport {
    pub total_bytes: u64,
    pub free_bytes: u64,
    pub used_bytes: u64,
    /// Biggest first, with everything unrecognised folded into one row.
    pub items: Vec<StorageItem>,
}

/// One row per thing Luna knows it keeps on its own disk.
struct Part {
    id: &'static str,
    label: &'static str,
    /// Paths under the data dir that make up this part.
    paths: &'static [&'static str],
    /// A file rather than a folder (`luna.db` and its sidecars).
    files: bool,
    removable: bool,
}

const PARTS: &[Part] = &[
    Part {
        id: "office_pack",
        label: "Office editor",
        paths: &["eurooffice"],
        files: false,
        removable: false,
    },
    Part {
        id: "diagram_pack",
        label: "Diagram editor",
        paths: &["drawio"],
        files: false,
        removable: false,
    },
    Part {
        id: "software",
        label: "Luna's software",
        paths: &["bin"],
        files: false,
        removable: false,
    },
    Part {
        id: "temporary",
        label: "Temporary files from open documents",
        paths: &["office_bundles"],
        files: false,
        removable: true,
    },
    Part {
        id: "downloads",
        label: "Downloaded updates",
        paths: &["updates"],
        files: false,
        removable: true,
    },
    Part {
        id: "logs",
        label: "Logs",
        paths: &["logs"],
        files: false,
        removable: false,
    },
    Part {
        id: "settings",
        label: "Accounts and settings",
        paths: &["luna.db", "luna.db-wal", "luna.db-shm"],
        files: true,
        removable: false,
    },
];

/// Space used by Luna's own disk, split by what is using it.
pub fn report(data_dir: &Path) -> StorageReport {
    let space = summary::disk_space(data_dir).unwrap_or_default();
    let mut items: Vec<StorageItem> = PARTS
        .iter()
        .map(|part| {
            let bytes = part
                .paths
                .iter()
                .map(|p| {
                    let path = data_dir.join(p);
                    if part.files {
                        file_bytes(&path)
                    } else {
                        tree_bytes(&path)
                    }
                })
                .sum();
            StorageItem {
                id: part.id.to_string(),
                label: part.label.to_string(),
                bytes,
                removable: part.removable,
            }
        })
        .filter(|item| item.bytes > 0)
        .collect();

    // Whatever is left is not something Luna can name: a stray file, a folder
    // from an older version. It still takes space, so it gets a row rather
    // than quietly vanishing from the total.
    let known: u64 = items.iter().map(|i| i.bytes).sum();
    let other = space.used_bytes.saturating_sub(known);
    if other > 0 {
        items.push(StorageItem {
            id: "other".to_string(),
            label: "Other files".to_string(),
            bytes: other,
            removable: false,
        });
    }
    items.sort_by(|a, b| b.bytes.cmp(&a.bytes).then_with(|| a.id.cmp(&b.id)));

    StorageReport {
        total_bytes: space.total_bytes,
        free_bytes: space.free_bytes,
        used_bytes: space.used_bytes,
        items,
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct CleanupResult {
    pub freed_bytes: u64,
    /// Ids of the parts that were cleared, so the page can say what it did.
    pub cleared: Vec<String>,
}

/// Clear what Luna can safely make again: temporary copies of documents that
/// no editor has open, and update downloads from installs that never finished.
///
/// `live_keys` are the document keys with an editor still attached — their
/// copies are in use and stay.
pub fn cleanup(data_dir: &Path, live_keys: &[String]) -> CleanupResult {
    let mut freed = 0u64;
    let mut cleared = Vec::new();

    let bundles = data_dir.join("office_bundles");
    let mut removed_bundles = 0u64;
    if let Ok(entries) = std::fs::read_dir(&bundles) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if live_keys.iter().any(|k| k == &name) {
                continue;
            }
            let path = entry.path();
            let bytes = tree_bytes(&path);
            let gone = if path.is_dir() {
                std::fs::remove_dir_all(&path).is_ok()
            } else {
                std::fs::remove_file(&path).is_ok()
            };
            if gone {
                removed_bundles += bytes;
            }
        }
    }
    if removed_bundles > 0 {
        freed += removed_bundles;
        cleared.push("temporary".to_string());
    }

    let downloads = data_dir.join("updates");
    let mut removed_downloads = 0u64;
    if let Ok(entries) = std::fs::read_dir(&downloads) {
        for entry in entries.flatten() {
            let path = entry.path();
            let stale = entry
                .metadata()
                .and_then(|m| m.modified())
                .map(|t| {
                    SystemTime::now()
                        .duration_since(t)
                        .map(|age| age > Duration::from_secs(STALE_DOWNLOAD_SECS))
                        .unwrap_or(false)
                })
                .unwrap_or(false);
            if !stale {
                continue;
            }
            let bytes = if path.is_dir() {
                tree_bytes(&path)
            } else {
                file_bytes(&path)
            };
            let gone = if path.is_dir() {
                std::fs::remove_dir_all(&path).is_ok()
            } else {
                std::fs::remove_file(&path).is_ok()
            };
            if gone {
                removed_downloads += bytes;
            }
        }
    }
    if removed_downloads > 0 {
        freed += removed_downloads;
        cleared.push("downloads".to_string());
    }

    CleanupResult {
        freed_bytes: freed,
        cleared,
    }
}

fn file_bytes(path: &Path) -> u64 {
    std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

/// Bytes under `path`, following the same "allocated blocks" idea as `du` so
/// the rows add up to what the disk reports. Symlinks are not followed: a
/// link to a drive must never count as Luna's own storage.
fn tree_bytes(path: &Path) -> u64 {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return 0;
    };
    if meta.file_type().is_symlink() {
        return 0;
    }
    if !meta.is_dir() {
        return blocks(&meta);
    }
    let mut total = blocks(&meta);
    let Ok(entries) = std::fs::read_dir(path) else {
        return total;
    };
    let mut stack: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
    while let Some(next) = stack.pop() {
        let Ok(meta) = std::fs::symlink_metadata(&next) else {
            continue;
        };
        if meta.file_type().is_symlink() {
            continue;
        }
        total += blocks(&meta);
        if meta.is_dir()
            && let Ok(entries) = std::fs::read_dir(&next)
        {
            stack.extend(entries.flatten().map(|e| e.path()));
        }
    }
    total
}

#[cfg(unix)]
fn blocks(meta: &std::fs::Metadata) -> u64 {
    use std::os::unix::fs::MetadataExt;
    meta.blocks().saturating_mul(512)
}

#[cfg(not(unix))]
fn blocks(meta: &std::fs::Metadata) -> u64 {
    meta.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn names_the_packs_and_leaves_out_what_is_not_there() {
        let d = dir();
        std::fs::create_dir_all(d.path().join("eurooffice/sdkjs")).unwrap();
        std::fs::write(d.path().join("eurooffice/sdkjs/a.js"), vec![0u8; 4096]).unwrap();
        std::fs::create_dir_all(d.path().join("logs")).unwrap();
        std::fs::write(d.path().join("logs/luna.log"), b"line\n").unwrap();

        let report = report(d.path());
        let ids: Vec<&str> = report.items.iter().map(|i| i.id.as_str()).collect();
        assert!(ids.contains(&"office_pack"), "{ids:?}");
        assert!(ids.contains(&"logs"), "{ids:?}");
        assert!(
            !ids.contains(&"drawio"),
            "no drawio folder, so no row: {ids:?}"
        );
        let pack = report.items.iter().find(|i| i.id == "office_pack").unwrap();
        assert!(pack.bytes >= 4096);
        assert!(!pack.removable);
    }

    #[test]
    fn items_are_biggest_first() {
        let d = dir();
        std::fs::create_dir_all(d.path().join("eurooffice")).unwrap();
        std::fs::write(d.path().join("eurooffice/big"), vec![0u8; 200_000]).unwrap();
        std::fs::create_dir_all(d.path().join("logs")).unwrap();
        std::fs::write(d.path().join("logs/small"), vec![0u8; 4096]).unwrap();

        let report = report(d.path());
        let sizes: Vec<u64> = report.items.iter().map(|i| i.bytes).collect();
        assert!(sizes.windows(2).all(|w| w[0] >= w[1]), "{sizes:?}");
    }

    #[test]
    fn cleanup_keeps_the_copy_an_editor_still_has_open() {
        let d = dir();
        let bundles = d.path().join("office_bundles");
        std::fs::create_dir_all(bundles.join("open-key")).unwrap();
        std::fs::write(bundles.join("open-key/Editor.bin"), vec![1u8; 8192]).unwrap();
        std::fs::create_dir_all(bundles.join("old-key")).unwrap();
        std::fs::write(bundles.join("old-key/Editor.bin"), vec![1u8; 4096]).unwrap();

        let result = cleanup(d.path(), &["open-key".to_string()]);
        assert!(result.freed_bytes >= 4096);
        assert_eq!(result.cleared, vec!["temporary".to_string()]);
        assert!(
            bundles.join("open-key/Editor.bin").exists(),
            "a live editor keeps its copy"
        );
        assert!(!bundles.join("old-key").exists());
    }

    #[test]
    fn cleanup_leaves_a_download_that_is_still_fresh() {
        let d = dir();
        let updates = d.path().join("updates");
        std::fs::create_dir_all(&updates).unwrap();
        std::fs::write(updates.join("luna-update-fresh-os"), vec![0u8; 4096]).unwrap();

        let result = cleanup(d.path(), &[]);
        assert_eq!(result.freed_bytes, 0);
        assert!(result.cleared.is_empty());
        assert!(updates.join("luna-update-fresh-os").exists());
    }

    #[test]
    fn cleanup_is_quiet_when_there_is_nothing_to_clear() {
        let d = dir();
        let result = cleanup(d.path(), &[]);
        assert_eq!(result.freed_bytes, 0);
        assert!(result.cleared.is_empty());
    }

    #[test]
    fn a_symlink_is_not_counted_as_lunas_own_storage() {
        let d = dir();
        let target = dir();
        std::fs::write(target.path().join("huge"), vec![0u8; 100_000]).unwrap();
        std::fs::create_dir_all(d.path().join("logs")).unwrap();
        std::os::unix::fs::symlink(target.path(), d.path().join("logs/link")).unwrap();

        let report = report(d.path());
        // A row is dropped when it uses no space at all, so "no row" and "a
        // tiny row" both mean the link was skipped. Following it would give
        // the 100,000-byte target, which always makes a row.
        let logs = report
            .items
            .iter()
            .find(|i| i.id == "logs")
            .map(|i| i.bytes)
            .unwrap_or(0);
        assert!(logs < 100_000, "followed the symlink: {logs}");
    }
}

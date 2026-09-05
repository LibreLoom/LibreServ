//! Destination and overlap rules for backup jobs and sync pairs.

use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LunaRef {
    pub drive_id: String,
    /// Relative path on the drive ("" = drive root).
    pub path: String,
}

impl LunaRef {
    pub fn normalized(drive_id: &str, path: &str) -> Self {
        Self {
            drive_id: drive_id.to_string(),
            path: normalize_remote(path),
        }
    }

    pub fn key(&self) -> String {
        format!("{}:{}", self.drive_id, self.path)
    }
}

pub fn normalize_remote(path: &str) -> String {
    path.trim()
        .trim_matches('/')
        .split('/')
        .filter(|s| !s.is_empty() && *s != ".")
        .collect::<Vec<_>>()
        .join("/")
}

pub fn paths_overlap(a: &str, b: &str) -> bool {
    let a = normalize_remote(a);
    let b = normalize_remote(b);
    if a == b {
        return true;
    }
    if a.is_empty() || b.is_empty() {
        // Drive root overlaps everything on that drive.
        return true;
    }
    a.starts_with(&(b.clone() + "/")) || b.starts_with(&(a + "/"))
}

pub fn local_paths_overlap(a: &Path, b: &Path) -> bool {
    let Ok(a) = a.canonicalize() else {
        return lexical_under(a, b) || lexical_under(b, a) || a == b;
    };
    let Ok(b) = b.canonicalize() else {
        return false;
    };
    a == b || a.starts_with(&b) || b.starts_with(&a)
}

fn lexical_under(child: &Path, parent: &Path) -> bool {
    let c: Vec<_> = child.components().collect();
    let p: Vec<_> = parent.components().collect();
    c.len() > p.len() && c.starts_with(&p)
}

pub fn validate_local_dirs(paths: &[String]) -> Result<Vec<PathBuf>, String> {
    let mut out = Vec::new();
    for p in paths {
        let path = PathBuf::from(p);
        if !path.is_dir() {
            return Err(format!(
                "“{p}” is not a folder on this computer. Choose a folder that exists."
            ));
        }
        out.push(path);
    }
    for i in 0..out.len() {
        for j in (i + 1)..out.len() {
            if local_paths_overlap(&out[i], &out[j]) {
                return Err(
                    "Two backup folders sit inside each other. Pick separate folders.".into(),
                );
            }
        }
    }
    Ok(out)
}

pub fn validate_luna_folder(drive_id: &str, path: &str) -> Result<LunaRef, String> {
    if drive_id.is_empty()
        || !drive_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("Choose a drive on Luna.".into());
    }
    let norm = normalize_remote(path);
    for part in norm.split('/').filter(|s| !s.is_empty()) {
        if part == ".." || part.contains('\0') {
            return Err("That Luna folder path is not valid.".into());
        }
    }
    Ok(LunaRef {
        drive_id: drive_id.to_string(),
        path: norm,
    })
}

/// Local child folder that will hold the synced Luna folder.
pub fn resolved_sync_local(parent: &Path, luna_folder_name: &str) -> Result<PathBuf, String> {
    if !parent.is_dir() {
        return Err(
            "Choose a folder on this computer that exists. Luna will put the synced folder inside it."
                .into(),
        );
    }
    let name = luna_folder_name.trim();
    if name.is_empty() || name == "." || name == ".." || name.contains('/') || name.contains('\\') {
        return Err("That Luna folder name is not valid for syncing.".into());
    }
    let child = parent.join(name);
    // Disallow syncing onto filesystem roots as the child itself when parent is `/`.
    if parent.components().count() <= 1
        && matches!(
            parent.components().next(),
            Some(Component::RootDir) | Some(Component::Prefix(_))
        )
    {
        return Err(
            "Choose a normal folder on this computer (for example your home folder), not the whole disk."
                .into(),
        );
    }
    Ok(child)
}

pub fn luna_folder_basename(path: &str) -> String {
    let norm = normalize_remote(path);
    if norm.is_empty() {
        return String::new();
    }
    norm.rsplit('/').next().unwrap_or("Luna").to_string()
}

/// Folder name on this computer for a whole-drive sync (drive label, filesystem-safe).
pub fn sanitize_sync_folder_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | '\0' => '-',
            c => c,
        })
        .collect::<String>()
        .trim()
        .trim_matches('.')
        .to_string();
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        "Luna Drive".into()
    } else {
        cleaned
    }
}

/// Local child folder name for a sync: Luna folder leaf, or a sanitized drive label for drive root.
pub fn sync_local_basename(remote_path: &str, drive_label: &str) -> String {
    let leaf = luna_folder_basename(remote_path);
    if leaf.is_empty() {
        sanitize_sync_folder_name(drive_label)
    } else {
        leaf
    }
}

#[derive(Debug, Clone, Default)]
pub struct ExistingJobs {
    pub backup_sources: Vec<PathBuf>,
    pub backup_dests: Vec<LunaRef>,
    pub sync_locals: Vec<PathBuf>,
    pub sync_remotes: Vec<LunaRef>,
}

pub fn check_backup_against(
    sources: &[PathBuf],
    dest: &LunaRef,
    existing: &ExistingJobs,
    skip_backup_dest_key: Option<&str>,
) -> Result<(), String> {
    for src in sources {
        for sync_local in &existing.sync_locals {
            if local_paths_overlap(src, sync_local) {
                return Err(
                    "That folder is already used by Sync. Pick a different folder to back up."
                        .into(),
                );
            }
        }
    }
    for other in &existing.backup_dests {
        if skip_backup_dest_key == Some(other.key().as_str()) {
            continue;
        }
        if other.drive_id != dest.drive_id {
            continue;
        }
        if other.path == dest.path {
            return Err(
                "Another backup already uses this Luna folder. Choose a different folder.".into(),
            );
        }
        if paths_overlap(&other.path, &dest.path) {
            return Err(
                "That Luna folder sits inside another backup's folder (or the other way around). Choose a separate folder."
                    .into(),
            );
        }
    }
    for remote in &existing.sync_remotes {
        if remote.drive_id != dest.drive_id {
            continue;
        }
        if paths_overlap(&remote.path, &dest.path) {
            return Err(
                "That Luna folder is already used by Sync. Choose a different backup destination."
                    .into(),
            );
        }
    }
    Ok(())
}

pub fn check_sync_against(
    local: &Path,
    remote: &LunaRef,
    existing: &ExistingJobs,
    skip_sync_remote_key: Option<&str>,
) -> Result<(), String> {
    for src in &existing.backup_sources {
        if local_paths_overlap(local, src) {
            return Err(
                "That folder overlaps a Backup folder. Pick a different place for Sync.".into(),
            );
        }
    }
    for other in &existing.sync_locals {
        if skip_sync_remote_key.is_some() && other == local {
            continue;
        }
        if local_paths_overlap(local, other) {
            return Err(
                "That sync folder overlaps another sync. Pick a different folder on this computer."
                    .into(),
            );
        }
    }
    for other in &existing.sync_remotes {
        if skip_sync_remote_key == Some(other.key().as_str()) {
            continue;
        }
        if other.drive_id != remote.drive_id {
            continue;
        }
        if paths_overlap(&other.path, &remote.path) {
            return Err(
                "That Luna folder is already synced (or sits inside another sync). Choose a different folder."
                    .into(),
            );
        }
    }
    for dest in &existing.backup_dests {
        if dest.drive_id != remote.drive_id {
            continue;
        }
        if paths_overlap(&dest.path, &remote.path) {
            return Err(
                "That Luna folder overlaps a Backup destination. Choose a different folder to sync."
                    .into(),
            );
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_overlap_detects_nesting() {
        assert!(paths_overlap("a/b", "a/b"));
        assert!(paths_overlap("a", "a/b"));
        assert!(paths_overlap("a/b", "a"));
        assert!(!paths_overlap("a/b", "a/c"));
        assert!(paths_overlap("", "photos"));
    }

    #[test]
    fn basename_from_path() {
        assert_eq!(luna_folder_basename("Photos/Family"), "Family");
        assert_eq!(luna_folder_basename("Family"), "Family");
        assert_eq!(luna_folder_basename(""), "");
        assert_eq!(luna_folder_basename("/"), "");
    }

    #[test]
    fn sanitize_drive_label_for_local_folder() {
        assert_eq!(sanitize_sync_folder_name("Photos"), "Photos");
        assert_eq!(sanitize_sync_folder_name("Family / Media"), "Family - Media");
        assert_eq!(sanitize_sync_folder_name("  "), "Luna Drive");
        assert_eq!(sanitize_sync_folder_name(".."), "Luna Drive");
        assert_eq!(sanitize_sync_folder_name(".hidden."), "hidden");
    }

    #[test]
    fn sync_basename_uses_drive_label_for_root() {
        assert_eq!(sync_local_basename("", "Archive"), "Archive");
        assert_eq!(sync_local_basename("Photos/Family", "Archive"), "Family");
    }

    #[test]
    fn drive_root_overlaps_every_folder_on_drive() {
        assert!(paths_overlap("", "photos"));
        assert!(paths_overlap("photos", ""));
    }
}

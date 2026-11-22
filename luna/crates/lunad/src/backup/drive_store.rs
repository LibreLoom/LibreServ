//! A drive backup's storage on its target drive (plan §3, §4).
//!
//! Layout: `<target-root>/{prefix}-backups/<protection-id>/`
//! - `current/`: plain files mirroring the source.
//! - `versions/<unix-seconds>/<rel>`: earlier copies of changed or deleted
//!   files, moved there (never hardlinked) when replaced.
//! - `manifest.json`: what this backup is, so the drive describes itself.

use std::collections::BTreeMap;
use std::fs;
use std::io::{self, ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};

use super::access_list::AccessList;
use crate::drives::layout::Layout;

pub const MANIFEST: &str = "manifest.json";
pub const MANIFEST_FORMAT: u32 = 1;

/// How long a deleted file's last copy is kept (plan §3).
pub const DELETED_KEEP_SECS: i64 = 30 * 86_400;

const DAY_SECS: i64 = 86_400;

/// Upper bounds of the retention buckets by age: a day, a week, a month
/// (plan §3).
const VERSION_BUCKETS: [i64; 3] = [DAY_SECS, 7 * DAY_SECS, 31 * DAY_SECS];

/// FAT stores modification times at 2-second precision, so a copy written
/// there reads back up to one second off. Two seconds counts as unchanged.
const MTIME_TOLERANCE_SECS: i64 = 2;

const FAT32_MAX_FILE: u64 = 4 * 1024 * 1024 * 1024 - 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Manifest {
    pub format: u32,
    pub protection_id: String,
    /// The lasting Luna id (plan §5). None until this Luna has a cloud identity.
    #[serde(default)]
    pub luna_id: Option<String>,
    pub source_drive_id: String,
    /// The source drive's name when last seen, for "came from" labels.
    pub source_drive_label: String,
    pub source_path: String,
    /// Owner user id for a private item's backup.
    pub private_owner: Option<String>,
    pub created_by: String,
    pub created_at: i64,
    /// Saved at each successful run (plan §2).
    pub access: AccessList,
    pub last_ok_at: i64,
    /// Files deleted from the source: rel path → deletion time on the
    /// backup's own clock ([`Manifest::clock`]).
    pub deleted: BTreeMap<String, i64>,
    /// Total seconds the deleted-files clock has been frozen.
    pub paused_secs: i64,
    /// When the current freeze began; 0 while running.
    pub paused_since: i64,
}

impl Manifest {
    /// The backup's own clock: wall time minus every frozen stretch, so a
    /// missing source never ages its deleted files out.
    pub fn clock(&self, now: i64) -> i64 {
        let current_freeze = if self.paused_since > 0 {
            (now - self.paused_since).max(0)
        } else {
            0
        };
        now - self.paused_secs - current_freeze
    }

    /// Freeze the clock (source missing or gone). No-op when already frozen.
    pub fn pause(&mut self, now: i64) {
        if self.paused_since == 0 {
            self.paused_since = now;
        }
    }

    /// Unfreeze the clock. No-op when running.
    pub fn resume(&mut self, now: i64) {
        if self.paused_since != 0 {
            self.paused_secs += (now - self.paused_since).max(0);
            self.paused_since = 0;
        }
    }
}

/// What [`Store::put`] did with one file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Put {
    Unchanged,
    Added,
    /// The previous copy moved into `versions/`.
    Updated,
}

/// One backup's directory on its target drive.
#[derive(Debug, Clone)]
pub struct Store {
    root: PathBuf,
}

impl Store {
    /// The store for `protection_id` on the drive mounted at `target_root`,
    /// creating its directories when missing.
    pub fn open(
        target_root: &Path,
        layout: &Layout,
        protection_id: &str,
    ) -> std::io::Result<Store> {
        check_protection_id(protection_id)?;
        if !target_root.is_dir() {
            return Err(io::Error::new(
                ErrorKind::NotFound,
                "The drive is not connected.",
            ));
        }
        // A backup drive's contents are not trusted. The store's folders can
        // have been replaced by links to anywhere on the Luna while the drive
        // was away, and `create_dir_all` would follow them. Build each folder
        // in turn and refuse a link instead of writing through it.
        let backups = layout.backups_name();
        let root = ensure_dir(target_root, &[backups.as_str(), protection_id])?;
        ensure_dir(&root, &["current"])?;
        ensure_dir(&root, &["versions"])?;
        Ok(Store { root })
    }

    /// The store if it already exists; never creates anything.
    pub fn existing(target_root: &Path, layout: &Layout, protection_id: &str) -> Option<Store> {
        check_protection_id(protection_id).ok()?;
        let backups = layout.backups_dir(target_root);
        let root = backups.join(protection_id);
        (is_real_dir(&backups) && is_real_dir(&root)).then_some(Store { root })
    }

    /// The two folders every write goes through. A store read from a drive can
    /// have had either swapped for a link since it was opened.
    fn check_dirs(&self) -> io::Result<()> {
        check_real_dirs(&self.root, &["current"])?;
        check_real_dirs(&self.root, &["versions"])
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn current_dir(&self) -> PathBuf {
        self.root.join("current")
    }

    pub fn versions_dir(&self) -> PathBuf {
        self.root.join("versions")
    }

    pub fn read_manifest(&self) -> std::io::Result<Option<Manifest>> {
        match fs::read(self.root.join(MANIFEST)) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map(Some)
                .map_err(|e| io::Error::new(ErrorKind::InvalidData, e)),
            Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// Write the manifest atomically (temp file, then rename).
    pub fn write_manifest(&self, manifest: &Manifest) -> std::io::Result<()> {
        // The store folder itself is drive content too: a link there would
        // put the manifest in a folder of the drive author's choosing.
        if !is_real_dir(&self.root) {
            return Err(not_a_folder());
        }
        let bytes = serde_json::to_vec_pretty(manifest)
            .map_err(|e| io::Error::new(ErrorKind::InvalidData, e))?;
        let mut tmp = tempfile::Builder::new()
            .prefix(".manifest.tmp-")
            .rand_bytes(8)
            .tempfile_in(&self.root)?;
        tmp.as_file_mut().write_all(&bytes)?;
        tmp.as_file().sync_all()?;
        tmp.persist(self.root.join(MANIFEST)).map_err(|e| e.error)?;
        Ok(())
    }

    /// Copy `src` to `current/<rel>` unless the copy there already matches
    /// (size and mtime). The new copy is first written to a temp file next
    /// to the destination, so a failed copy (source gone, disk full) leaves
    /// `current/` as it was. Only then does a different existing copy move
    /// to `versions/<now>/<rel>`, and the temp file is renamed into place.
    /// The new copy keeps the source mtime.
    pub fn put(
        &self,
        rel: &str,
        src: &Path,
        src_meta: &std::fs::Metadata,
        now: i64,
    ) -> std::io::Result<Put> {
        let segs = rel_segments(rel)?;
        self.check_dirs()?;
        let dst = join_rel(&self.current_dir(), &segs);
        // Check for an unchanged copy first: most files on a repeat run are
        // unchanged, and they should not pay a stat walk up the parent chain.
        let existing = match fs::symlink_metadata(&dst) {
            Ok(meta) if meta.is_file() => {
                if meta.len() == src_meta.len() && same_mtime(&meta, src_meta) {
                    return Ok(Put::Unchanged);
                }
                true
            }
            Ok(_) => {
                return Err(io::Error::new(
                    ErrorKind::AlreadyExists,
                    "The backup has a folder where this file should go.",
                ));
            }
            // A missing parent folder (or a file where one should be) is left
            // to ensure_dir below, which reports it as before.
            Err(e) if matches!(e.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory) => false,
            Err(e) => return Err(e),
        };
        ensure_dir(&self.current_dir(), &segs[..segs.len() - 1])?;

        // Copy first: until the new copy is complete, the old one stays put.
        let staged = stage_copy(src, src_meta, &dst)?;
        let mut moved_old = None;
        if existing {
            let (old, parents) = self.version_paths(now, rel)?;
            let parents: Vec<&str> = parents.iter().map(String::as_str).collect();
            check_real_dirs(&self.versions_dir(), &parents)?;
            fs::rename(&dst, &old)?;
            moved_old = Some(old);
        }
        check_real_dirs(&self.current_dir(), &segs[..segs.len() - 1])?;
        if let Err(e) = staged.persist(&dst) {
            // Dropping the failed temp file removes it. Put the old copy back.
            if let Some(old) = moved_old {
                let _ = fs::rename(&old, &dst);
            }
            return Err(e);
        }
        Ok(if existing { Put::Updated } else { Put::Added })
    }

    /// The source no longer has `rel`: move `current/<rel>` to
    /// `versions/<now>/<rel>`. Returns whether there was a copy to move.
    pub fn remove(&self, rel: &str, now: i64) -> std::io::Result<bool> {
        let segs = rel_segments(rel)?;
        self.check_dirs()?;
        let src = join_rel(&self.current_dir(), &segs);
        match fs::symlink_metadata(&src) {
            Ok(meta) if meta.is_file() => {}
            Ok(_) => {
                return Err(io::Error::new(
                    ErrorKind::InvalidData,
                    "The backup has a folder where this file should be.",
                ));
            }
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok(false),
            Err(e) => return Err(e),
        }
        let (old, parents) = self.version_paths(now, rel)?;
        let parents: Vec<&str> = parents.iter().map(String::as_str).collect();
        check_real_dirs(&self.versions_dir(), &parents)?;
        fs::rename(&src, &old)?;
        prune_empty_parents(&src, &self.current_dir());
        Ok(true)
    }

    /// Every file under `current/`, as rel paths.
    pub fn current_files(&self) -> std::io::Result<Vec<String>> {
        let mut files = walk_files(&self.current_dir())?;
        files.sort();
        Ok(files)
    }

    /// Version directory timestamps, oldest first.
    pub fn version_times(&self) -> std::io::Result<Vec<i64>> {
        let entries = match fs::read_dir(self.versions_dir()) {
            Ok(entries) => entries,
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e),
        };
        let mut times = Vec::new();
        for entry in entries {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            if let Some(t) = entry
                .file_name()
                .to_str()
                .and_then(|s| s.parse::<i64>().ok())
            {
                times.push(t);
            }
        }
        times.sort_unstable();
        Ok(times)
    }

    /// Apply retention (plan §3): drop earlier versions not kept by
    /// [`keep_versions`] per file, and the last copy of files deleted more
    /// than [`DELETED_KEEP_SECS`] ago on the manifest's clock (removing them
    /// from `manifest.deleted`). Empty version dirs are removed. Returns the
    /// number of files removed.
    ///
    /// Also: a file in `manifest.deleted` that is back in `current/` is no
    /// longer deleted, so its entry is dropped. A deleted file that is still
    /// inside its 30 days always keeps its latest copy, whatever the age
    /// buckets say, since that copy is the file's last version.
    pub fn thin(&self, manifest: &mut Manifest, now: i64) -> std::io::Result<u64> {
        for rel in self.current_files()? {
            manifest.deleted.remove(&rel);
        }
        let clock = manifest.clock(now);

        let mut by_rel: BTreeMap<String, Vec<i64>> = BTreeMap::new();
        for t in self.version_times()? {
            for rel in walk_files(&self.versions_dir().join(t.to_string()))? {
                by_rel.entry(rel).or_default().push(t);
            }
        }

        let mut removed = 0;
        let expired: Vec<String> = manifest
            .deleted
            .iter()
            .filter(|(_, at)| clock - **at > DELETED_KEEP_SECS)
            .map(|(rel, _)| rel.clone())
            .collect();
        for rel in &expired {
            for t in by_rel.remove(rel).unwrap_or_default() {
                if remove_file_if_exists(&self.version_path(t, rel)?)? {
                    removed += 1;
                }
            }
            manifest.deleted.remove(rel);
        }

        for (rel, times) in &by_rel {
            let mut times = times.clone();
            times.sort_unstable();
            let keep = match times.split_last() {
                Some((latest, earlier)) if manifest.deleted.contains_key(rel) => {
                    let mut keep = keep_versions(earlier, now);
                    keep.push(*latest);
                    keep
                }
                _ => keep_versions(&times, now),
            };
            for t in times.iter().filter(|t| !keep.contains(t)) {
                if remove_file_if_exists(&self.version_path(*t, rel)?)? {
                    removed += 1;
                }
            }
        }

        prune_empty_dirs(&self.versions_dir())?;
        Ok(removed)
    }

    /// Free space on a full drive by deleting old versions (plan §3). Walks
    /// `versions/<t>` oldest first and deletes every file in a folder, except
    /// the newest copy of a file deleted less than [`DELETED_KEEP_SECS`] ago
    /// on the manifest's clock. It stops after the first folder that frees
    /// bytes, so the caller can retry its write. `current/` is never touched.
    /// Returns the bytes freed, or 0 when nothing is left to remove.
    pub fn free_space_by_thinning(&self, manifest: &mut Manifest, now: i64) -> io::Result<u64> {
        let clock = manifest.clock(now);
        let times = self.version_times()?;

        // Newest version time and copy count per rel, to protect and to
        // spot files whose last copy is gone.
        let mut newest: BTreeMap<String, i64> = BTreeMap::new();
        let mut copies: BTreeMap<String, usize> = BTreeMap::new();
        for t in &times {
            for rel in walk_files(&self.versions_dir().join(t.to_string()))? {
                *copies.entry(rel.clone()).or_default() += 1;
                let entry = newest.entry(rel).or_insert(*t);
                *entry = (*entry).max(*t);
            }
        }
        // A file still in current/ is a copy too. Its deleted entry must stay
        // until that copy has moved into versions/.
        for rel in self.current_files()? {
            *copies.entry(rel).or_default() += 1;
        }
        let young_deleted: Vec<String> = manifest
            .deleted
            .iter()
            .filter(|(_, at)| clock - **at <= DELETED_KEEP_SECS)
            .map(|(rel, _)| rel.clone())
            .collect();
        let protected = |rel: &str, t: i64| {
            newest.get(rel) == Some(&t) && young_deleted.iter().any(|r| r == rel)
        };

        for t in times {
            let dir = self.versions_dir().join(t.to_string());
            let mut freed = 0;
            for rel in walk_files(&dir)? {
                if protected(&rel, t) {
                    continue;
                }
                let path = self.version_path(t, &rel)?;
                let size = match fs::symlink_metadata(&path) {
                    Ok(meta) => meta.len(),
                    Err(e) if e.kind() == ErrorKind::NotFound => continue,
                    Err(e) => return Err(e),
                };
                if remove_file_if_exists(&path)? {
                    freed += size;
                    if let Some(count) = copies.get_mut(&rel) {
                        *count -= 1;
                        if *count == 0 {
                            manifest.deleted.remove(&rel);
                        }
                    }
                }
            }
            prune_empty_dirs(&dir)?;
            let _ = fs::remove_dir(&dir);
            if freed > 0 {
                return Ok(freed);
            }
        }
        Ok(0)
    }

    /// `versions/<t>/<rel>`.
    fn version_path(&self, t: i64, rel: &str) -> io::Result<PathBuf> {
        Ok(join_rel(
            &self.versions_dir().join(t.to_string()),
            &rel_segments(rel)?,
        ))
    }

    /// `versions/<t>/<rel>`, making the folders it needs without following a
    /// link, and returning the folders a rename must re-check just before it.
    fn version_paths(&self, t: i64, rel: &str) -> io::Result<(PathBuf, Vec<String>)> {
        let segs = rel_segments(rel)?;
        let stamp = t.to_string();
        let mut parents = vec![stamp.clone()];
        parents.extend(segs[..segs.len() - 1].iter().map(|seg| seg.to_string()));
        let refs: Vec<&str> = parents.iter().map(String::as_str).collect();
        ensure_dir(&self.versions_dir(), &refs)?;
        Ok((join_rel(&self.versions_dir().join(&stamp), &segs), parents))
    }
}

/// Every backup store on the drive mounted at `target_root`.
pub fn list_stores(target_root: &Path, layout: &Layout) -> Vec<Store> {
    let backups = layout.backups_dir(target_root);
    // A link in place of the backups folder would list another folder's
    // contents as backups, and removing one would rename that folder away.
    if !is_real_dir(&backups) {
        return Vec::new();
    }
    let Ok(entries) = fs::read_dir(&backups) else {
        return Vec::new();
    };
    let mut stores: Vec<Store> = entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            check_protection_id(&name).ok()?;
            Some(Store { root: entry.path() })
        })
        .collect();
    stores.sort_by(|a, b| a.root.cmp(&b.root));
    stores
}

/// Retention for one file's earlier versions (plan §3): given their times,
/// which to keep. At most one per bucket, the oldest in each: up to 1 day
/// old, up to 1 week, up to ~1 month (31 days). Older ones are dropped.
///
/// A time after `now` (the clock moved back) counts as age zero. Input may
/// be in any order; the result is sorted ascending.
pub fn keep_versions(times: &[i64], now: i64) -> Vec<i64> {
    let mut oldest: [Option<i64>; 3] = [None; 3];
    for &t in times {
        let age = now - t;
        let bucket = if age <= VERSION_BUCKETS[0] {
            0
        } else if age <= VERSION_BUCKETS[1] {
            1
        } else if age <= VERSION_BUCKETS[2] {
            2
        } else {
            continue;
        };
        oldest[bucket] = Some(oldest[bucket].map_or(t, |o| o.min(t)));
    }
    let mut keep: Vec<i64> = oldest.into_iter().flatten().collect();
    keep.sort_unstable();
    keep
}

/// What a target drive's filesystem can't do (plan §4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct FsLimits {
    /// `a` and `A` are the same name (exFAT/FAT).
    pub case_insensitive: bool,
    /// Largest file it can hold (FAT: 4 GiB - 1).
    pub max_file: Option<u64>,
    /// Names can't hold `: * ? " < > | \\`, control characters, or end in a
    /// dot or space (exFAT/FAT).
    pub reserved_chars: bool,
}

/// The limits of the filesystem holding `target_root`, read from
/// `/proc/mounts` the way `drives/detect.rs` reads it. Best-effort: anything
/// unknown gives the default (no limits).
pub fn fs_limits(target_root: &Path) -> FsLimits {
    let Ok(mounts) = fs::read_to_string("/proc/mounts") else {
        return FsLimits::default();
    };
    let path = fs::canonicalize(target_root).unwrap_or_else(|_| target_root.to_path_buf());
    let fstype = fs_type_at(&mounts, &path).unwrap_or_default();
    limits_for_fs(&fstype)
}

/// `fuseblk` is what `/proc/mounts` shows for any filesystem driven through
/// FUSE, such as exFAT (exfat-fuse) or NTFS (ntfs-3g). The real type is not
/// visible there, and reading it would mean shelling out to `blkid`, which
/// we do not do. Both FUSE drivers used for removable drives are
/// case-insensitive and have no 4 GiB limit, so `fuseblk` gets those limits.
fn limits_for_fs(fstype: &str) -> FsLimits {
    match fstype.to_ascii_lowercase().as_str() {
        "exfat" | "fuseblk" => FsLimits {
            case_insensitive: true,
            max_file: None,
            reserved_chars: true,
        },
        "vfat" | "fat" | "fat32" | "msdos" => FsLimits {
            case_insensitive: true,
            max_file: Some(FAT32_MAX_FILE),
            reserved_chars: true,
        },
        _ => FsLimits::default(),
    }
}

/// The filesystem type of the most specific mount containing `path`.
pub(crate) fn fs_type_at(mounts: &str, path: &Path) -> Option<String> {
    let mut best: Option<(usize, String)> = None;
    for line in mounts.lines() {
        let mut fields = line.split_whitespace();
        let (Some(_device), Some(point), Some(fstype)) =
            (fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        let point = PathBuf::from(unescape_mount(point));
        if !path.starts_with(&point) {
            continue;
        }
        let len = point.as_os_str().len();
        if best.as_ref().is_none_or(|(best_len, _)| len > *best_len) {
            best = Some((len, fstype.to_string()));
        }
    }
    best.map(|(_, fstype)| fstype)
}

/// `/proc/mounts` escapes space, tab, newline and backslash as octal.
fn unescape_mount(s: &str) -> String {
    s.replace("\\040", " ")
        .replace("\\011", "\t")
        .replace("\\012", "\n")
        .replace("\\134", "\\")
}

/// A protection id is one folder name: no separators, no `..`, no NUL.
fn check_protection_id(id: &str) -> io::Result<()> {
    if id.is_empty() || id == "." || id.contains("..") || id.contains('/') || id.contains('\0') {
        return Err(io::Error::new(
            ErrorKind::InvalidInput,
            "The backup id is not a valid folder name.",
        ));
    }
    Ok(())
}

/// Split a `/`-joined relative path into its segments. Rejects absolute
/// paths, empty segments, `.`, `..` and NUL.
pub(crate) fn rel_segments(rel: &str) -> io::Result<Vec<&str>> {
    if rel.is_empty() {
        return Err(invalid_rel(rel));
    }
    let segs: Vec<&str> = rel.split('/').collect();
    for seg in &segs {
        if seg.is_empty() || *seg == "." || *seg == ".." || seg.contains('\0') {
            return Err(invalid_rel(rel));
        }
    }
    Ok(segs)
}

fn invalid_rel(rel: &str) -> io::Error {
    io::Error::new(
        ErrorKind::InvalidInput,
        format!("Not a valid file path: {rel:?}"),
    )
}

pub(crate) fn join_rel(base: &Path, segs: &[&str]) -> PathBuf {
    segs.iter()
        .fold(base.to_path_buf(), |path, seg| path.join(seg))
}

/// True for a real folder, never a link: `symlink_metadata` does not follow
/// the last component.
fn is_real_dir(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|meta| meta.is_dir())
}

/// The store's folder, or one of its folders, was swapped for a link or a
/// plain file. Nothing may be written through it.
fn not_a_folder() -> io::Error {
    io::Error::new(
        ErrorKind::InvalidData,
        "The backup's folder on this drive was replaced with something else, so Luna won't write to it.",
    )
}

/// Make every folder named by `segs` under `base`, refusing a link or a file
/// where a folder belongs. A drive's contents are untrusted media:
/// `create_dir_all` follows a `current` link to any folder on the Luna, and
/// every later write lands there as root.
fn ensure_dir(base: &Path, segs: &[&str]) -> io::Result<PathBuf> {
    let mut dir = base.to_path_buf();
    for seg in segs {
        if seg.is_empty() || *seg == "." || *seg == ".." || seg.contains('/') || seg.contains('\0')
        {
            return Err(io::Error::new(
                ErrorKind::InvalidInput,
                "The backup folder's name is not valid.",
            ));
        }
        dir.push(seg);
        match fs::symlink_metadata(&dir) {
            Ok(meta) if !meta.is_dir() => return Err(not_a_folder()),
            Ok(_) => {}
            Err(e) if e.kind() == ErrorKind::NotFound => match fs::create_dir(&dir) {
                Ok(()) => {}
                // Another run made it first; it still has to be a real folder.
                Err(e) if e.kind() == ErrorKind::AlreadyExists && is_real_dir(&dir) => {}
                Err(e) => return Err(e),
            },
            Err(e) => return Err(e),
        }
    }
    Ok(dir)
}

/// Refuse a link or a non-folder in `base` or in the folders `segs` names
/// under it. Checked again right before a temp file or an old copy is renamed
/// into place, so a folder swapped after [`ensure_dir`] cannot redirect the
/// write.
fn check_real_dirs(base: &Path, segs: &[&str]) -> io::Result<()> {
    if !is_real_dir(base) {
        return Err(not_a_folder());
    }
    let mut dir = base.to_path_buf();
    for seg in segs {
        dir.push(seg);
        if !is_real_dir(&dir) {
            return Err(not_a_folder());
        }
    }
    Ok(())
}

/// A temp file name for `copy_atomic`: never a name the store would keep.
fn is_temp_name(name: &str) -> bool {
    name.starts_with('.') && name.contains(".tmp-")
}

/// Every regular file under `base` as a `/`-joined rel path, skipping our
/// temp files and never following symlinks. A missing `base` is empty.
fn walk_files(base: &Path) -> io::Result<Vec<String>> {
    let mut out = Vec::new();
    let mut stack = vec![(base.to_path_buf(), String::new())];
    while let Some((dir, prefix)) = stack.pop() {
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == ErrorKind::NotFound && prefix.is_empty() => break,
            Err(e) => return Err(e),
        };
        for entry in entries {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if is_temp_name(&name) {
                continue;
            }
            let rel = if prefix.is_empty() {
                name
            } else {
                format!("{prefix}/{name}")
            };
            let file_type = entry.file_type()?;
            if file_type.is_dir() {
                stack.push((entry.path(), rel));
            } else if file_type.is_file() {
                out.push(rel);
            }
        }
    }
    Ok(out)
}

/// Remove empty directories below `dir` (not `dir` itself).
fn prune_empty_dirs(dir: &Path) -> io::Result<()> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    for entry in entries {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            prune_empty_dirs(&entry.path())?;
            let _ = fs::remove_dir(entry.path());
        }
    }
    Ok(())
}

/// Remove the parents of `start` up to, not including, `stop`, while empty.
fn prune_empty_parents(start: &Path, stop: &Path) {
    let mut dir = start.parent();
    while let Some(d) = dir {
        if d == stop || !d.starts_with(stop) || fs::remove_dir(d).is_err() {
            break;
        }
        dir = d.parent();
    }
}

fn remove_file_if_exists(path: &Path) -> io::Result<bool> {
    match fs::remove_file(path) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}

/// A copy staged under a temp name in the destination's folder. Nothing is
/// visible at the destination until [`Staged::persist`]; dropping it removes
/// the temp file.
struct Staged {
    path: PathBuf,
    file: Option<fs::File>,
}

impl Staged {
    fn file(&mut self) -> &mut fs::File {
        self.file.as_mut().expect("the staged file is open")
    }

    fn persist(mut self, dst: &Path) -> io::Result<()> {
        drop(self.file.take());
        fs::rename(&self.path, dst)?;
        // The temp name is gone; its drop must not touch the destination.
        std::mem::forget(self);
        Ok(())
    }
}

impl Drop for Staged {
    fn drop(&mut self) {
        drop(self.file.take());
        let _ = fs::remove_file(&self.path);
    }
}

/// Create `path` only if nothing has that name, and never through a link.
fn create_new_file(path: &Path) -> io::Result<fs::File> {
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.custom_flags(libc::O_NOFOLLOW);
    }
    opts.open(path)
}

/// Copy `src` into a temp file in `dst`'s directory, keeping the source
/// mtime. Nothing is visible at `dst` until the caller persists the temp
/// file; dropping it removes the temp file. A source that no longer exists
/// comes back as `NotFound`, so the caller can skip the file. The temp file is
/// created with `create_new` (which never follows a link) and `O_NOFOLLOW`.
fn stage_copy(src: &Path, src_meta: &fs::Metadata, dst: &Path) -> io::Result<Staged> {
    let mut src_file = fs::File::open(src).map_err(|e| {
        if e.kind() == ErrorKind::NotFound {
            io::Error::new(ErrorKind::NotFound, "The file is no longer in the source.")
        } else {
            e
        }
    })?;
    let dir = dst.parent().unwrap_or(Path::new("."));
    let name = dst
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let prefix = format!(".{name}.tmp-");
    let mut staged = None;
    for _ in 0..16 {
        let path = dir.join(format!("{prefix}{}", uuid::Uuid::new_v4().simple()));
        match create_new_file(&path) {
            Ok(file) => {
                staged = Some(Staged {
                    path,
                    file: Some(file),
                });
                break;
            }
            Err(e) if e.kind() == ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    let Some(mut staged) = staged else {
        return Err(io::Error::new(
            ErrorKind::AlreadyExists,
            "Luna couldn't find a free name for a copy on this drive.",
        ));
    };
    io::copy(&mut src_file, staged.file())?;
    staged.file().set_modified(src_meta.modified()?)?;
    staged.file().sync_all()?;
    Ok(staged)
}

/// Modification time in whole seconds since the Unix epoch.
fn mtime_secs(meta: &fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .map_or(0, |t| match t.duration_since(UNIX_EPOCH) {
            Ok(d) => d.as_secs() as i64,
            Err(e) => -(e.duration().as_secs() as i64),
        })
}

fn same_mtime(a: &fs::Metadata, b: &fs::Metadata) -> bool {
    (mtime_secs(a) - mtime_secs(b)).abs() <= MTIME_TOLERANCE_SECS
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    const ID: &str = "backup-one";
    const NOW: i64 = 2_000_000_000;

    fn layout() -> Layout {
        Layout::from_prefix(".luna-3f6a8c1e-9b2d-4a7c-8e5f-1a2b3c4d5e6f")
    }

    fn source(dir: &Path, name: &str, body: &[u8], mtime: i64) -> PathBuf {
        let path = dir.join(name);
        fs::write(&path, body).unwrap();
        let file = fs::OpenOptions::new().write(true).open(&path).unwrap();
        file.set_modified(UNIX_EPOCH + Duration::from_secs(mtime as u64))
            .unwrap();
        path
    }

    fn meta(path: &Path) -> fs::Metadata {
        fs::metadata(path).unwrap()
    }

    fn manifest() -> Manifest {
        Manifest {
            format: MANIFEST_FORMAT,
            protection_id: ID.into(),
            luna_id: None,
            source_drive_id: "drive-1".into(),
            source_drive_label: "Photos".into(),
            source_path: "/Photos".into(),
            private_owner: None,
            created_by: "user-1".into(),
            created_at: 0,
            access: AccessList::default(),
            last_ok_at: 0,
            deleted: BTreeMap::new(),
            paused_secs: 0,
            paused_since: 0,
        }
    }

    #[test]
    fn put_adds_unchanged_and_updates_keeping_the_old_copy() {
        let target = tempfile::tempdir().unwrap();
        let store = Store::open(target.path(), &layout(), ID).unwrap();
        let src_dir = tempfile::tempdir().unwrap();

        let s = source(src_dir.path(), "a.txt", b"one", 1_700_000_000);
        assert_eq!(
            store.put("a.txt", &s, &meta(&s), 1_700_000_100).unwrap(),
            Put::Added
        );
        assert_eq!(
            store.put("a.txt", &s, &meta(&s), 1_700_000_200).unwrap(),
            Put::Unchanged
        );

        let s2 = source(src_dir.path(), "a.txt", b"two!", 1_700_000_300);
        assert_eq!(
            store.put("a.txt", &s2, &meta(&s2), 1_700_000_400).unwrap(),
            Put::Updated
        );

        let current = store.current_dir().join("a.txt");
        assert_eq!(fs::read(&current).unwrap(), b"two!");
        assert_eq!(mtime_secs(&meta(&current)), 1_700_000_300);
        assert_eq!(
            fs::read(store.versions_dir().join("1700000400/a.txt")).unwrap(),
            b"one"
        );
        assert_eq!(store.current_files().unwrap(), vec!["a.txt".to_string()]);
        assert_eq!(store.version_times().unwrap(), vec![1_700_000_400]);
    }

    #[test]
    fn put_creates_parent_folders_and_leaves_no_temp_files() {
        let target = tempfile::tempdir().unwrap();
        let store = Store::open(target.path(), &layout(), ID).unwrap();
        let src_dir = tempfile::tempdir().unwrap();
        let s = source(src_dir.path(), "b.txt", b"hello", 1_700_000_000);
        store.put("deep/er/b.txt", &s, &meta(&s), NOW).unwrap();
        assert_eq!(
            store.current_files().unwrap(),
            vec!["deep/er/b.txt".to_string()]
        );
        let names: Vec<_> = fs::read_dir(store.current_dir().join("deep/er"))
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(names, vec!["b.txt".to_string()]);
    }

    #[test]
    fn remove_moves_the_copy_and_prunes_empty_folders() {
        let target = tempfile::tempdir().unwrap();
        let store = Store::open(target.path(), &layout(), ID).unwrap();
        let src_dir = tempfile::tempdir().unwrap();
        let s = source(src_dir.path(), "c.txt", b"gone soon", 1_700_000_000);
        store.put("sub/c.txt", &s, &meta(&s), NOW).unwrap();

        assert!(store.remove("sub/c.txt", NOW + 5).unwrap());
        assert!(store.current_files().unwrap().is_empty());
        assert!(!store.current_dir().join("sub").exists());
        assert_eq!(
            fs::read(store.versions_dir().join(format!("{}/sub/c.txt", NOW + 5))).unwrap(),
            b"gone soon"
        );
        assert!(!store.remove("sub/c.txt", NOW + 6).unwrap());
    }

    #[test]
    fn keep_versions_table() {
        let now = NOW;
        let d = DAY_SECS;
        let cases: Vec<(Vec<i64>, Vec<i64>)> = vec![
            (vec![], vec![]),
            (vec![now - 3600], vec![now - 3600]),
            (vec![now - 3600, now - 20 * 3600], vec![now - 20 * 3600]),
            // 10 and 30 days share the (7d, 31d] bucket: only the oldest stays.
            (
                vec![now - 2 * d, now - 10 * d, now - 30 * d],
                vec![now - 30 * d, now - 2 * d],
            ),
            (vec![now - 40 * d], vec![]),
            (vec![now - 2 * d, now - 6 * d], vec![now - 6 * d]),
            (vec![now + 5], vec![now + 5]),
            (
                vec![now - 10 * d, now - 2 * d],
                vec![now - 10 * d, now - 2 * d],
            ),
            // Exactly one day is in the first bucket; one second more is in the second.
            (vec![now - d, now - d - 1], vec![now - d - 1, now - d]),
            (vec![now - 31 * d], vec![now - 31 * d]),
            (vec![now - 31 * d - 1], vec![]),
        ];
        for (times, want) in cases {
            assert_eq!(keep_versions(&times, now), want, "times {times:?}");
        }
    }

    #[test]
    fn clock_stops_while_paused() {
        let mut m = manifest();
        m.pause(100);
        m.pause(150); // already frozen: keeps the first start
        assert_eq!(m.clock(150), 100);
        m.resume(200);
        assert_eq!(m.clock(200), 100);
        assert_eq!(m.clock(300), 200);
    }

    #[test]
    fn thin_applies_versions_and_deleted_files_with_frozen_clock() {
        let target = tempfile::tempdir().unwrap();
        let store = Store::open(target.path(), &layout(), ID).unwrap();
        let src_dir = tempfile::tempdir().unwrap();
        let versions = store.versions_dir();
        let put_version = |t: i64, rel: &str| {
            let p = versions.join(t.to_string()).join(rel);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, b"old").unwrap();
        };
        let d = DAY_SECS;

        // keep.txt: a 40-day copy (dropped) and a 20-day copy (kept).
        let s = source(src_dir.path(), "keep.txt", b"now", 1_700_000_000);
        store.put("keep.txt", &s, &meta(&s), NOW).unwrap();
        put_version(NOW - 40 * d, "keep.txt");
        put_version(NOW - 20 * d, "keep.txt");

        // old.txt: deleted 80 days ago on the wall clock. The source went
        // missing 40 days ago, so only 40 days have passed on the frozen
        // clock: 40 > 30, so it expires.
        put_version(NOW - 80 * d, "old.txt");

        // paused.txt: the source went missing at p0 = NOW - 40d. Its deletion
        // (NOW - 45d wall clock) is 5 days old on the frozen clock, so it
        // stays. Its latest copy is 45 days old on the wall clock, which is
        // past the 31-day buckets, but the latest copy must still be kept.
        let p0 = NOW - 40 * d;
        let mut m = manifest();
        m.pause(p0);
        m.deleted.insert("paused.txt".into(), p0 - 5 * d);
        put_version(p0 - 5 * d, "paused.txt");
        put_version(p0 - 10 * d, "paused.txt"); // earlier copy, 50 days old: dropped
        m.deleted.insert("old.txt".into(), NOW - 80 * d);

        let removed = store.thin(&mut m, NOW).unwrap();
        assert_eq!(
            removed, 3,
            "keep.txt 40-day copy, old.txt, and paused.txt 50-day copy"
        );
        assert!(versions.join(format!("{}/paused.txt", p0 - 5 * d)).exists());
        assert!(
            !versions
                .join(format!("{}/paused.txt", p0 - 10 * d))
                .exists()
        );
        assert!(!versions.join(format!("{}/old.txt", NOW - 80 * d)).exists());
        assert!(versions.join(format!("{}/keep.txt", NOW - 20 * d)).exists());
        assert!(!versions.join(format!("{}/keep.txt", NOW - 40 * d)).exists());
        assert_eq!(
            m.deleted.keys().cloned().collect::<Vec<_>>(),
            vec!["paused.txt".to_string()]
        );

        // Put it back in the source: no longer deleted.
        let s2 = source(src_dir.path(), "paused.txt", b"back", 1_700_000_000);
        store.put("paused.txt", &s2, &meta(&s2), NOW).unwrap();
        store.thin(&mut m, NOW).unwrap();
        assert!(m.deleted.is_empty());
    }

    #[test]
    fn manifest_round_trip_and_missing_file() {
        let target = tempfile::tempdir().unwrap();
        let store = Store::open(target.path(), &layout(), ID).unwrap();
        assert_eq!(store.read_manifest().unwrap(), None);
        let mut m = manifest();
        m.deleted.insert("x/y.txt".into(), 5);
        m.paused_since = 7;
        store.write_manifest(&m).unwrap();
        assert_eq!(store.read_manifest().unwrap(), Some(m));
    }

    #[test]
    fn invalid_ids_and_paths_are_rejected() {
        let target = tempfile::tempdir().unwrap();
        let lay = layout();
        for id in ["", ".", "..", "a/b", "a..b", "a\0b"] {
            let err = Store::open(target.path(), &lay, id).unwrap_err();
            assert_eq!(err.kind(), ErrorKind::InvalidInput, "id {id:?}");
            assert!(Store::existing(target.path(), &lay, id).is_none());
        }
        let store = Store::open(target.path(), &lay, ID).unwrap();
        let src_dir = tempfile::tempdir().unwrap();
        let s = source(src_dir.path(), "z.txt", b"z", 1_700_000_000);
        for rel in [
            "",
            "/abs.txt",
            "../escape.txt",
            "a/../b",
            "a//b",
            "a/./b",
            "trailing/",
        ] {
            assert_eq!(
                store.put(rel, &s, &meta(&s), NOW).unwrap_err().kind(),
                ErrorKind::InvalidInput,
                "put {rel:?}"
            );
            assert_eq!(
                store.remove(rel, NOW).unwrap_err().kind(),
                ErrorKind::InvalidInput,
                "remove {rel:?}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_link_in_place_of_current_or_versions_is_refused() {
        use std::os::unix::fs::symlink;

        let target = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let lay = layout();
        let root = lay.backups_dir(target.path()).join(ID);
        fs::create_dir_all(&root).unwrap();
        // The drive was taken away and `current` replaced by a link to
        // somewhere else on the Luna.
        symlink(outside.path(), root.join("current")).unwrap();
        fs::create_dir_all(root.join("versions")).unwrap();

        assert!(Store::open(target.path(), &lay, ID).is_err());
        assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);

        // Even a store that did not come through `open` refuses to write.
        let store = Store { root: root.clone() };
        let src_dir = tempfile::tempdir().unwrap();
        let s = source(src_dir.path(), "a.txt", b"x", 1_700_000_000);
        assert!(store.put("a.txt", &s, &meta(&s), NOW).is_err());
        assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);

        // The same for `versions`.
        fs::remove_file(root.join("current")).unwrap();
        fs::create_dir_all(root.join("current")).unwrap();
        fs::remove_dir(root.join("versions")).unwrap();
        symlink(outside.path(), root.join("versions")).unwrap();
        assert!(Store::open(target.path(), &lay, ID).is_err());
        assert!(store.put("a.txt", &s, &meta(&s), NOW).is_err());
        assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
    }

    #[test]
    fn list_stores_returns_only_valid_folders() {
        let target = tempfile::tempdir().unwrap();
        let lay = layout();
        Store::open(target.path(), &lay, "one").unwrap();
        Store::open(target.path(), &lay, "two").unwrap();
        fs::create_dir_all(lay.backups_dir(target.path()).join("bad name.")).unwrap();
        fs::write(lay.backups_dir(target.path()).join("stray-file"), b"x").unwrap();
        let names: Vec<String> = list_stores(target.path(), &lay)
            .iter()
            .map(|s| s.root().file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            names,
            vec![
                "bad name.".to_string(),
                "one".to_string(),
                "two".to_string()
            ]
        );
        assert!(list_stores(target.path().join("missing").as_path(), &lay).is_empty());
    }

    #[test]
    fn fs_limits_from_mount_table() {
        let mounts = "/dev/sda1 / ext4 rw 0 0\n\
                      /dev/sdb1 /run/media/max/STICK vfat rw 0 0\n\
                      /dev/sdc1 /run/media/max/My\\040Disk exfat rw 0 0\n";
        let stick = fs_type_at(mounts, Path::new("/run/media/max/STICK/Luna")).unwrap();
        assert_eq!(
            limits_for_fs(&stick),
            FsLimits {
                case_insensitive: true,
                max_file: Some(FAT32_MAX_FILE),
                reserved_chars: true,
            }
        );
        let disk = fs_type_at(mounts, Path::new("/run/media/max/My Disk")).unwrap();
        assert_eq!(
            limits_for_fs(&disk),
            FsLimits {
                case_insensitive: true,
                max_file: None,
                reserved_chars: true,
            }
        );
        let root = fs_type_at(mounts, Path::new("/home/max")).unwrap();
        assert_eq!(limits_for_fs(&root), FsLimits::default());
        assert_eq!(limits_for_fs(""), FsLimits::default());
    }

    #[test]
    fn fuseblk_is_case_insensitive_without_size_limit() {
        assert_eq!(
            limits_for_fs("fuseblk"),
            FsLimits {
                case_insensitive: true,
                max_file: None,
                reserved_chars: true,
            }
        );
    }

    #[test]
    fn put_with_vanished_source_keeps_the_current_copy() {
        let target = tempfile::tempdir().unwrap();
        let store = Store::open(target.path(), &layout(), ID).unwrap();
        let src_dir = tempfile::tempdir().unwrap();
        let s = source(src_dir.path(), "a.txt", b"one", 1_700_000_000);
        store.put("a.txt", &s, &meta(&s), NOW).unwrap();

        let s2 = source(src_dir.path(), "a.txt", b"two!", 1_700_000_300);
        let m2 = meta(&s2);
        fs::remove_file(&s2).unwrap();
        let err = store
            .put("a.txt", &s2, &m2, NOW + 100)
            .expect_err("the source is gone");
        assert_eq!(err.kind(), ErrorKind::NotFound);

        assert_eq!(fs::read(store.current_dir().join("a.txt")).unwrap(), b"one");
        assert!(store.version_times().unwrap().is_empty());
        let names: Vec<_> = fs::read_dir(store.current_dir())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, vec![std::ffi::OsString::from("a.txt")]);
    }

    #[test]
    fn free_space_by_thinning_removes_oldest_first_and_protects_recent_deletes() {
        let target = tempfile::tempdir().unwrap();
        let store = Store::open(target.path(), &layout(), ID).unwrap();
        let src_dir = tempfile::tempdir().unwrap();
        let versions = store.versions_dir();
        let put_version = |t: i64, rel: &str| {
            let p = versions.join(t.to_string()).join(rel);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, b"old").unwrap();
        };
        let d = DAY_SECS;

        // keep.txt is in current/ and has two old copies. Those may go.
        let s = source(src_dir.path(), "keep.txt", b"now", 1_700_000_000);
        store.put("keep.txt", &s, &meta(&s), NOW).unwrap();
        put_version(NOW - 40 * d, "keep.txt");
        put_version(NOW - 20 * d, "keep.txt");

        // old.txt was deleted 80 days ago: its only copy may go.
        put_version(NOW - 80 * d, "old.txt");

        // gone.txt was deleted 5 days ago: its older copy may go, but its
        // newest copy is protected.
        put_version(NOW - 10 * d, "gone.txt");
        put_version(NOW - 6 * d, "gone.txt");

        let mut m = manifest();
        m.deleted.insert("old.txt".into(), NOW - 80 * d);
        m.deleted.insert("gone.txt".into(), NOW - 5 * d);

        // Each call frees one folder, oldest first.
        assert_eq!(store.free_space_by_thinning(&mut m, NOW).unwrap(), 3);
        assert!(!versions.join(format!("{}", NOW - 80 * d)).exists());
        assert!(!m.deleted.contains_key("old.txt"));

        assert_eq!(store.free_space_by_thinning(&mut m, NOW).unwrap(), 3);
        assert!(!versions.join(format!("{}/keep.txt", NOW - 40 * d)).exists());
        assert_eq!(store.free_space_by_thinning(&mut m, NOW).unwrap(), 3);
        assert!(!versions.join(format!("{}/keep.txt", NOW - 20 * d)).exists());
        assert_eq!(store.free_space_by_thinning(&mut m, NOW).unwrap(), 3);
        assert!(!versions.join(format!("{}/gone.txt", NOW - 10 * d)).exists());

        // Only the protected copy is left: nothing to free.
        assert_eq!(store.free_space_by_thinning(&mut m, NOW).unwrap(), 0);
        assert!(versions.join(format!("{}/gone.txt", NOW - 6 * d)).exists());
        assert!(m.deleted.contains_key("gone.txt"));
        assert_eq!(
            fs::read(store.current_dir().join("keep.txt")).unwrap(),
            b"now"
        );
    }

    #[test]
    fn free_space_by_thinning_keeps_deleted_entry_while_current_copy_waits_to_move() {
        let target = tempfile::tempdir().unwrap();
        let store = Store::open(target.path(), &layout(), ID).unwrap();
        let src_dir = tempfile::tempdir().unwrap();
        let d = DAY_SECS;

        // waiting.txt was deleted 80 days ago. Its old version may go, but
        // its newest copy is still in current/ waiting to move, so the
        // deleted entry must stay.
        let s = source(src_dir.path(), "waiting.txt", b"now", 1_700_000_000);
        store.put("waiting.txt", &s, &meta(&s), NOW).unwrap();
        let p = store
            .versions_dir()
            .join((NOW - 80 * d).to_string())
            .join("waiting.txt");
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p.clone(), b"old").unwrap();

        let mut m = manifest();
        m.deleted.insert("waiting.txt".into(), NOW - 80 * d);

        assert_eq!(store.free_space_by_thinning(&mut m, NOW).unwrap(), 3);
        assert!(!p.exists());
        assert!(m.deleted.contains_key("waiting.txt"));
        assert_eq!(
            fs::read(store.current_dir().join("waiting.txt")).unwrap(),
            b"now"
        );
    }

    #[test]
    fn free_space_by_thinning_returns_zero_when_empty() {
        let target = tempfile::tempdir().unwrap();
        let store = Store::open(target.path(), &layout(), ID).unwrap();
        let mut m = manifest();
        assert_eq!(store.free_space_by_thinning(&mut m, NOW).unwrap(), 0);
    }
}

//! Which files a backup copies (plan §2 "What's included").
//!
//! Everything under the source, judged by path segments *below* the source
//! root: a segment inside any drive's `.luna-<uuid>` namespace is Luna's own
//! (trash, thumbs, upload parts, marker files, other backups, private items)
//! and is skipped, except a form's files folder, which travels with its form.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use crate::api::forms::form_files_dir_hash;

/// One regular file a backup should copy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    /// Path relative to the source root, `/`-joined, no leading slash. For a
    /// single-file source, the file's own name.
    pub rel: String,
    /// Absolute path on disk.
    pub abs: PathBuf,
    pub size: u64,
    /// Modification time, unix seconds.
    pub mtime: i64,
}

/// True when `segment` (one path component) is inside any drive's Luna
/// namespace (`luna_core::marker::extract_prefix`).
pub fn is_luna_segment(segment: &str) -> bool {
    luna_core::marker::extract_prefix(segment).is_some()
}

/// Every file to copy under `source` (an absolute, already resolved file or
/// directory). Never follows symlinks.
pub fn walk(source: &Path) -> std::io::Result<Vec<Entry>> {
    let meta = fs::symlink_metadata(source)?;
    let mut out = Vec::new();
    if meta.is_file() {
        // The source's own name is not judged: it may itself be a Luna name.
        if let Some(name) = source.file_name().and_then(|n| n.to_str())
            && let Some(entry) = entry_for(source, name.to_string())?
        {
            out.push(entry);
        }
    } else if meta.is_dir() {
        walk_dir(source, "", false, &mut out)?;
    }
    out.sort_by(|a, b| a.rel.cmp(&b.rel));
    Ok(out)
}

/// Collects the files under `dir`. `rel_dir` is `dir`'s path relative to the
/// source root (empty for the root). `inside_form` is true once a matched form
/// files folder is being walked: everything in it travels with the form.
fn walk_dir(
    dir: &Path,
    rel_dir: &str,
    inside_form: bool,
    out: &mut Vec<Entry>,
) -> std::io::Result<()> {
    let mut kids = Vec::new();
    for item in fs::read_dir(dir)? {
        let item = item?;
        // Non-UTF-8 names cannot be addressed by the file API, so skip them.
        let Ok(name) = item.file_name().into_string() else {
            continue;
        };
        kids.push((name, item.file_type()?, item.path()));
    }

    // Hashes of this directory's visible regular files. A form files folder
    // here counts as a match only when one of them is its form.
    let visible_tags: HashSet<String> = if inside_form {
        HashSet::new()
    } else {
        kids.iter()
            .filter(|(name, ft, _)| ft.is_file() && !is_luna_segment(name))
            .map(|(name, _, _)| form_files_dir_hash(name))
            .collect()
    };

    for (name, ft, path) in kids {
        let rel = join_rel(rel_dir, &name);
        if !inside_form && is_luna_segment(&name) {
            let is_matched_form_folder =
                ft.is_dir() && form_folder_tag(&name).is_some_and(|tag| visible_tags.contains(tag));
            if is_matched_form_folder {
                walk_dir(&path, &rel, true, out)?;
            }
            continue;
        }
        if ft.is_symlink() {
            continue;
        }
        if ft.is_dir() {
            walk_dir(&path, &rel, inside_form, out)?;
        } else if ft.is_file()
            && let Some(entry) = entry_for(&path, rel)?
        {
            out.push(entry);
        }
    }
    Ok(())
}

/// The hex tag of a `<luna-prefix>-form-<16 hex>` folder name, if it is one.
fn form_folder_tag(segment: &str) -> Option<&str> {
    let prefix = luna_core::marker::extract_prefix(segment)?;
    let tag = segment.get(prefix.len()..)?.strip_prefix("-form-")?;
    (tag.len() == 16 && tag.bytes().all(|b| b.is_ascii_hexdigit())).then_some(tag)
}

fn join_rel(rel_dir: &str, name: &str) -> String {
    if rel_dir.is_empty() {
        name.to_string()
    } else {
        format!("{rel_dir}/{name}")
    }
}

/// Stat a regular file for the walk. `None` when it vanished after listing,
/// so one deleted file does not fail the whole backup.
fn entry_for(abs: &Path, rel: String) -> std::io::Result<Option<Entry>> {
    let meta = match fs::metadata(abs) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    let mtime = match meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
    {
        Some(d) => d.as_secs() as i64,
        None => 0,
    };
    Ok(Some(Entry {
        rel,
        abs: abs.to_path_buf(),
        size: meta.len(),
        mtime,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    const PREFIX: &str = ".luna-0b5e9c3a-1f2d-4c6b-8a7e-123456789abc";

    fn touch(root: &Path, rel: &str) {
        let path = root.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, rel.as_bytes()).unwrap();
    }

    fn rels(source: &Path) -> Vec<String> {
        walk(source).unwrap().into_iter().map(|e| e.rel).collect()
    }

    #[test]
    fn luna_segment_matches_only_real_luna_names() {
        assert!(is_luna_segment(PREFIX));
        assert!(is_luna_segment(&format!("{PREFIX}-trash")));
        assert!(is_luna_segment(&format!("{PREFIX}.sqlite3")));
        assert!(!is_luna_segment(".luna-notes"));
        assert!(!is_luna_segment(".luna-"));
        assert!(!is_luna_segment("notes.txt"));
    }

    #[test]
    fn nested_files_are_included_sorted_with_size() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        touch(root, "top.txt");
        touch(root, "docs/a/b.txt");
        let entries = walk(root).unwrap();
        let rels: Vec<_> = entries.iter().map(|e| e.rel.as_str()).collect();
        assert_eq!(rels, ["docs/a/b.txt", "top.txt"]);
        assert_eq!(entries[0].size, "docs/a/b.txt".len() as u64);
        assert!(entries[0].mtime > 0);
    }

    #[test]
    fn luna_bookkeeping_is_skipped() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        touch(root, "keep.txt");
        touch(root, &format!("{PREFIX}-trash/old.txt"));
        touch(root, &format!("{PREFIX}-thumbs/pic.jpg"));
        touch(root, &format!("{PREFIX}-upload.1.2.part"));
        touch(root, &format!("{PREFIX}.sqlite3"));
        touch(root, &format!("docs/{PREFIX}-trash/nested.txt"));
        assert_eq!(rels(root), ["keep.txt"]);
    }

    #[test]
    fn user_files_named_like_luna_or_temp_are_included() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        touch(root, ".luna-notes");
        touch(root, ".notes.part");
        touch(root, "docs/.luna-notes/inner.txt");
        assert_eq!(
            rels(root),
            [".luna-notes", ".notes.part", "docs/.luna-notes/inner.txt"]
        );
    }

    #[test]
    fn private_item_folder_is_skipped_with_contents() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        touch(
            root,
            &format!("{PREFIX}-ABCDEFGHIJKLMNOPQRSTUVWX23/secret.txt"),
        );
        touch(root, "visible.txt");
        assert_eq!(rels(root), ["visible.txt"]);
    }

    #[test]
    fn form_folder_is_included_when_its_form_is_visible() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let form = "survey.lunaform";
        let folder = format!("{PREFIX}-form-{}", form_files_dir_hash(form));
        touch(root, form);
        touch(root, &format!("{folder}/answers/1.txt"));
        assert_eq!(
            rels(root),
            [format!("{folder}/answers/1.txt"), form.to_string()]
        );
    }

    #[test]
    fn form_folder_is_skipped_without_a_visible_form() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let folder = format!("{PREFIX}-form-{}", form_files_dir_hash("gone.lunaform"));
        touch(root, &format!("{folder}/answers/1.txt"));
        // A Luna-named file does not count as a visible form.
        let hidden = format!("{PREFIX}-private.lunaform");
        let folder2 = format!("{PREFIX}-form-{}", form_files_dir_hash(&hidden));
        touch(root, &hidden);
        touch(root, &format!("{folder2}/answers/1.txt"));
        assert!(rels(root).iter().all(|r| !r.contains("-form-")));
        assert!(rels(root).is_empty());
    }

    #[test]
    fn luna_named_source_directory_still_walks_its_children() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join(format!("{PREFIX}-backup-src"));
        touch(&source, "a.txt");
        touch(&source, &format!("{PREFIX}-trash/skip.txt"));
        assert_eq!(rels(&source), ["a.txt"]);
    }

    #[test]
    fn single_file_source_uses_its_own_name() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(format!("{PREFIX}-named.txt"));
        fs::write(&file, b"hello").unwrap();
        let entries = walk(&file).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].rel, format!("{PREFIX}-named.txt"));
        assert_eq!(entries[0].size, 5);
        assert_eq!(entries[0].abs, file);
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_never_followed() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.txt"), b"x").unwrap();
        let root = dir.path().join("root");
        touch(&root, "real.txt");
        std::os::unix::fs::symlink(outside.path(), root.join("linked-dir")).unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("secret.txt"),
            root.join("linked-file.txt"),
        )
        .unwrap();
        assert_eq!(rels(&root), ["real.txt"]);
    }
}

//! Path jail.
//!
//! Every filesystem operation in Luna resolves a user-supplied relative path
//! against a drive root and then verifies, with canonicalized paths, that the
//! result is still inside that root. Symlink escape and `..` traversal are
//! impossible by construction.

use std::path::{Component, Path, PathBuf};

#[derive(Debug, thiserror::Error)]
pub enum PathError {
    #[error("path is not absolute")]
    Absolute,
    #[error("path escapes the drive root")]
    Escape,
    #[error("path does not exist: {0}")]
    NotFound(#[source] std::io::Error),
    #[error("io error: {0}")]
    Io(#[source] std::io::Error),
}

/// Resolve `rel` inside `root`, returning the canonical existing path.
///
/// The returned path is guaranteed to start with the canonicalized `root`
/// component-for-component. This protects against `..` and symlinked
/// directories pointing outside the root.
pub fn resolve_child(root: &Path, rel: &str) -> Result<PathBuf, PathError> {
    if rel.is_empty() || rel == "." {
        return canonical_root(root);
    }

    let requested = Path::new(rel);
    if requested.is_absolute() {
        return Err(PathError::Absolute);
    }

    // Lexical guard first (cheap) before touching the filesystem.
    for component in requested.components() {
        if matches!(
            component,
            Component::ParentDir | Component::Prefix(_) | Component::RootDir
        ) {
            return Err(PathError::Escape);
        }
    }

    let canonical_root = canonical_root(root)?;
    let joined = canonical_root.join(requested);
    let canonical = joined.canonicalize().map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => PathError::NotFound(e),
        _ => PathError::Io(e),
    })?;

    if !canonical.starts_with(&canonical_root) {
        return Err(PathError::Escape);
    }
    Ok(canonical)
}

fn canonical_root(root: &Path) -> Result<PathBuf, PathError> {
    root.canonicalize().map_err(PathError::Io)
}

fn lexical_rel(rel: &str) -> Result<&Path, PathError> {
    if rel.is_empty() || rel == "." {
        return Ok(Path::new(""));
    }
    let requested = Path::new(rel);
    if requested.is_absolute() {
        return Err(PathError::Absolute);
    }
    for component in requested.components() {
        if matches!(
            component,
            Component::ParentDir | Component::Prefix(_) | Component::RootDir
        ) {
            return Err(PathError::Escape);
        }
    }
    Ok(requested)
}

/// True when `child` is `prefix` or a descendant, compared component-wise on
/// already-canonical paths (so a grant of `family` cannot be left via a
/// symlink to another folder on the same drive).
pub fn is_under_prefix(prefix: &Path, child: &Path) -> bool {
    child.starts_with(prefix)
}

/// Resolve `rel` inside `root` without following any symlink component.
///
/// Unlike [`resolve_child`], a symlink anywhere in the path is an escape —
/// even when its target would still be inside `root`.
pub fn resolve_child_nofollow(root: &Path, rel: &str) -> Result<PathBuf, PathError> {
    walk_nofollow(root, rel, false)
}

/// Resolve `rel` for a create (last component may be missing). Every existing
/// component must be a real directory, not a symlink.
pub fn resolve_for_create_nofollow(root: &Path, rel: &str) -> Result<PathBuf, PathError> {
    walk_nofollow(root, rel, true)
}

fn walk_nofollow(root: &Path, rel: &str, last_may_missing: bool) -> Result<PathBuf, PathError> {
    let requested = lexical_rel(rel)?;
    let canonical_root = canonical_root(root)?;
    if requested.as_os_str().is_empty() {
        return Ok(canonical_root);
    }
    let components: Vec<_> = requested.components().collect();
    let mut current = canonical_root.clone();
    for (i, component) in components.iter().enumerate() {
        let Component::Normal(name) = component else {
            return Err(PathError::Escape);
        };
        let next = current.join(name);
        if !next.starts_with(&canonical_root) {
            return Err(PathError::Escape);
        }
        match std::fs::symlink_metadata(&next) {
            Ok(meta) if meta.file_type().is_symlink() => return Err(PathError::Escape),
            Ok(_) => current = next,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                if last_may_missing {
                    // Remainder is a path we will create; join lexically and stop
                    // touching the filesystem so a later component cannot be a link.
                    current = next;
                    for extra in components.iter().skip(i + 1) {
                        let Component::Normal(name) = extra else {
                            return Err(PathError::Escape);
                        };
                        current = current.join(name);
                        if !current.starts_with(&canonical_root) {
                            return Err(PathError::Escape);
                        }
                    }
                    break;
                } else {
                    return Err(PathError::NotFound(e));
                }
            }
            Err(e) => return Err(PathError::Io(e)),
        }
    }
    if !current.starts_with(&canonical_root) {
        return Err(PathError::Escape);
    }
    Ok(current)
}

/// Open a file without following a final symlink (`O_NOFOLLOW` on Unix).
pub fn open_nofollow(root: &Path, rel: &str) -> Result<(std::fs::File, PathBuf), PathError> {
    let path = resolve_child_nofollow(root, rel)?;
    let mut opts = std::fs::OpenOptions::new();
    opts.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.custom_flags(libc::O_NOFOLLOW);
    }
    let file = opts.open(&path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => PathError::NotFound(e),
        _ => PathError::Io(e),
    })?;
    Ok((file, path))
}

/// Open a file inside the jail and verify, against the *actually opened* file
/// descriptor, that it still lives under `root`.
///
/// `resolve_child` canonicalizes the path, but there is a small window between
/// that check and a later `File::open` where a malicious drive (the drives are
/// user-supplied content) could swap an intermediate directory for a symlink
/// pointing outside the root. Re-checking the opened fd via `/proc/self/fd`
/// closes that race: whatever object was really opened is verified.
#[cfg(target_os = "linux")]
pub fn open_verified(root: &Path, rel: &str) -> Result<(std::fs::File, PathBuf), PathError> {
    use std::os::unix::io::AsRawFd;
    let path = resolve_child(root, rel)?;
    let file = std::fs::File::open(&path).map_err(PathError::Io)?;
    let link =
        std::fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd())).map_err(PathError::Io)?;
    let canonical_root = root.canonicalize().map_err(PathError::Io)?;
    if !link.starts_with(&canonical_root) {
        return Err(PathError::Escape);
    }
    Ok((file, path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir() -> PathBuf {
        let mut p = std::env::temp_dir();
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        p.push(format!("luna-path-test-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn child_resolves_inside() {
        let root = temp_dir();
        fs::write(root.join("a.txt"), b"a").unwrap();
        let p = resolve_child(&root, "a.txt").unwrap();
        assert!(p.starts_with(root.canonicalize().unwrap()));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn dotdot_is_rejected_lexically() {
        let root = temp_dir();
        assert!(matches!(
            resolve_child(&root, "../etc/passwd"),
            Err(PathError::Escape)
        ));
        assert!(matches!(
            resolve_child(&root, "a/../../etc"),
            Err(PathError::Escape)
        ));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn absolute_path_is_rejected() {
        let root = temp_dir();
        assert!(matches!(
            resolve_child(&root, "/etc/passwd"),
            Err(PathError::Absolute)
        ));
        fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn symlink_escape_is_rejected() {
        use std::os::unix::fs::symlink;
        let root = temp_dir();
        let outside = temp_dir();
        fs::write(outside.join("secret.txt"), b"secret").unwrap();
        symlink(&outside, root.join("escape")).unwrap();

        let err = resolve_child(&root, "escape/secret.txt").unwrap_err();
        assert!(matches!(err, PathError::Escape), "got {err:?}");
        fs::remove_dir_all(&root).unwrap();
        fs::remove_dir_all(&outside).unwrap();
    }

    #[test]
    fn empty_rel_returns_root() {
        let root = temp_dir();
        let p = resolve_child(&root, ".").unwrap();
        assert_eq!(p, root.canonicalize().unwrap());
        fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn nofollow_rejects_symlink_even_inside_root() {
        use std::os::unix::fs::symlink;
        let root = temp_dir();
        fs::create_dir(root.join("real")).unwrap();
        fs::write(root.join("real/a.txt"), b"a").unwrap();
        symlink(root.join("real"), root.join("link")).unwrap();
        assert!(matches!(
            resolve_child_nofollow(&root, "link/a.txt"),
            Err(PathError::Escape)
        ));
        // Following canonicalize still stays in-jail for resolve_child.
        let followed = resolve_child(&root, "link/a.txt").unwrap();
        assert!(followed.starts_with(root.canonicalize().unwrap()));
        fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn nofollow_rejects_symlink_escape() {
        use std::os::unix::fs::symlink;
        let root = temp_dir();
        let outside = temp_dir();
        fs::write(outside.join("secret.txt"), b"secret").unwrap();
        symlink(&outside, root.join("escape")).unwrap();
        assert!(matches!(
            resolve_child_nofollow(&root, "escape/secret.txt"),
            Err(PathError::Escape)
        ));
        fs::remove_dir_all(&root).unwrap();
        fs::remove_dir_all(&outside).unwrap();
    }

    #[test]
    fn create_nofollow_allows_missing_leaf() {
        let root = temp_dir();
        fs::create_dir(root.join("dir")).unwrap();
        let dest = resolve_for_create_nofollow(&root, "dir/new.txt").unwrap();
        assert_eq!(dest.file_name().unwrap(), "new.txt");
        let nested = resolve_for_create_nofollow(&root, "dir/a/b/c").unwrap();
        assert!(nested.ends_with("a/b/c"));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn is_under_prefix_is_component_wise() {
        let root = temp_dir();
        let family = root.join("family");
        let photos = family.join("photos");
        fs::create_dir_all(&photos).unwrap();
        let family_c = family.canonicalize().unwrap();
        let photos_c = photos.canonicalize().unwrap();
        assert!(is_under_prefix(&family_c, &photos_c));
        assert!(!is_under_prefix(
            &family_c,
            &root
                .join("other")
                .canonicalize()
                .unwrap_or(root.join("other"))
        ));
        fs::remove_dir_all(&root).unwrap();
    }
}

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
}

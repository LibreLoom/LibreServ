//! Path rules for names that come from Luna.
//!
//! A folder listing is server input: on the LAN it travels plain HTTP, so it
//! can be forged. Nothing from it may become a filesystem path unchecked —
//! these helpers are the one place that decides what is safe to join under
//! the sync folder.

use std::path::{Component, Path, PathBuf};

/// One remote file or folder name, never a path. Rejects separators (both
/// directions — `\` is a separator on Windows), `.`/`..`, NUL, and empties:
/// anything that could climb out of the sync root once joined locally.
pub fn valid_remote_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains(['/', '\\'])
        && !name.contains('\0')
}

/// Join a `/`-separated remote-relative path under `root`, or `None` when it
/// would land outside `root`. Pure component work — the filesystem is never
/// touched, so this is safe for files that do not exist yet.
///
/// `valid_remote_name` is checked per segment AND the platform's own parser
/// must see each segment as one ordinary component (never a root, drive
/// prefix, or parent step) — belt and suspenders for Windows, where `C:` or
/// a `\` sneak past a naive join.
pub fn join_under(root: &Path, rel: &str) -> Option<PathBuf> {
    let mut out = root.to_path_buf();
    let mut pushed = false;
    for part in rel.split('/') {
        if !valid_remote_name(part) {
            return None;
        }
        match Path::new(part).components().next() {
            Some(Component::Normal(name)) if name.as_encoded_bytes() == part.as_bytes() => {}
            _ => return None,
        }
        out.push(part);
        pushed = true;
    }
    if !pushed || !out.starts_with(root) {
        return None;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_names_reject_traversal() {
        assert!(valid_remote_name("photo.jpg"));
        assert!(valid_remote_name("a b.txt"));
        assert!(valid_remote_name("..hidden-ok")); // not a traversal step
        assert!(!valid_remote_name(".."));
        assert!(!valid_remote_name("."));
        assert!(!valid_remote_name(""));
        assert!(!valid_remote_name("a/b"));
        assert!(!valid_remote_name("a\\b"));
        assert!(!valid_remote_name("a\0b"));
        assert!(!valid_remote_name("../etc"));
    }

    #[test]
    fn join_under_builds_nested_paths() {
        let root = Path::new("/sync/root");
        assert_eq!(
            join_under(root, "sub/dir/photo.jpg").unwrap(),
            root.join("sub").join("dir").join("photo.jpg")
        );
        assert_eq!(join_under(root, "top.txt").unwrap(), root.join("top.txt"));
    }

    #[test]
    fn join_under_refuses_to_escape() {
        let root = Path::new("/sync/root");
        // "C:/x" is platform-dependent: a `C:` directory is safe (if odd) on
        // Unix, but a drive-prefix escape on Windows — where the Prefix
        // check rejects it. `\` names are rejected everywhere.
        for bad in [
            "../x",
            "a/../../x",
            "/abs/path",
            "a//b",
            "a/",
            "",
            "..",
            "a\\b",
            "C:\\win.ini",
            "\0",
        ] {
            assert!(join_under(root, bad).is_none(), "accepted {bad:?}");
        }
    }
}

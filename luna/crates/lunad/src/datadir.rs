//! The data directory's security boundary.
//!
//! The data directory holds the device token, the session signing key, the
//! user database, and the update binaries the daemon runs. On the Luna OS
//! image the daemon runs as root, so a data directory that belongs to
//! somebody else is a way to read those secrets and to swap the binaries.
//!
//! Three rules, then: the directory is created owner-only (never briefly
//! world-readable, because that is where the secrets land), it must belong to
//! the account the daemon runs as, and the way to it must not let another
//! account swap the directory for one of their own.

use std::path::Path;

#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};

/// The mode the data directory carries: only its owner may look inside.
#[cfg(unix)]
pub const DATA_DIR_MODE: u32 = 0o700;

/// The account the daemon runs as. Root on the Luna OS image, the signed-in
/// person everywhere else.
#[cfg(unix)]
pub fn current_uid() -> u32 {
    // SAFETY: geteuid() is always safe to call and cannot fail.
    unsafe { libc::geteuid() }
}

/// The group the daemon runs as. A parent directory that this group may
/// write is one the daemon trusts — those are the same people.
#[cfg(unix)]
pub fn current_gid() -> u32 {
    // SAFETY: getegid() is always safe to call and cannot fail.
    unsafe { libc::getegid() }
}

/// The groups the daemon belongs to. A parent directory that one of these
/// groups may write belongs to the same people as the daemon, so it is not
/// a way for a stranger to swap the data directory.
#[cfg(unix)]
fn current_groups() -> Vec<u32> {
    // SAFETY: getgroups() with a null pointer only reports the number of
    // groups the process belongs to.
    let count = unsafe { libc::getgroups(0, std::ptr::null_mut()) };
    if count <= 0 {
        return vec![current_gid()];
    }
    let mut groups = vec![0u32; count as usize];
    // SAFETY: the buffer holds `count` entries, which is what is asked for.
    let filled = unsafe {
        libc::getgroups(
            count as libc::c_int,
            groups.as_mut_ptr() as *mut libc::gid_t,
        )
    };
    if filled < 0 {
        return vec![current_gid()];
    }
    groups.truncate(filled as usize);
    groups.push(current_gid());
    groups
}

/// Non-Unix builds do not have Unix ownership checks, but keep the startup
/// helper available so the daemon still compiles on those targets.
#[cfg(not(unix))]
pub fn current_uid() -> u32 {
    0
}

/// Non-Unix builds have no groups either.
#[cfg(not(unix))]
pub fn current_gid() -> u32 {
    0
}

#[derive(Debug)]
pub struct OwnershipError(String);

impl std::fmt::Display for OwnershipError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for OwnershipError {}

/// Whether startup may use the explicitly enabled temporary-data fallback.
/// An ownership failure must never be hidden by starting with an empty DB.
pub fn is_ownership_error(error: &anyhow::Error) -> bool {
    error.downcast_ref::<OwnershipError>().is_some()
}

/// Prepare the data directory for use.
///
/// Creates it when it is missing — owner-only from the start — keeps it
/// owner-only when it already existed with looser permissions, and refuses a
/// directory that belongs to another account. Nothing inside is moved or
/// removed: the data stays where the person put it.
pub fn prepare(path: &Path, owner_uid: u32) -> anyhow::Result<()> {
    // A relative data directory still has to be checked against the
    // directories it really sits in, so work with the full path.
    let path = absolute(path)?;

    // The parents keep their usual permissions; only the data directory
    // itself is owner-only.
    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
    {
        std::fs::create_dir_all(parent).map_err(|err| {
            anyhow::anyhow!(
                "could not create the data directory {}: {err}",
                path.display()
            )
        })?;
    }

    // The way to the data directory is checked before anything is put in it:
    // a parent that lets another account in is refused outright, and no
    // directory is left behind in it.
    #[cfg(unix)]
    check_parents(&path, owner_uid)?;

    #[cfg(unix)]
    match std::fs::DirBuilder::new().mode(DATA_DIR_MODE).create(&path) {
        Ok(()) => {}
        // It was already there — that is the normal case, not a failure.
        Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {}
        // Everything else: keep the reason, it says whether the path is
        // blocked, unwritable, or something else.
        Err(err) => {
            return Err(anyhow::anyhow!(
                "could not create the data directory {}: {err}",
                path.display()
            ));
        }
    }
    #[cfg(not(unix))]
    match std::fs::create_dir(&path) {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(err) => {
            return Err(anyhow::anyhow!(
                "could not create the data directory {}: {err}",
                path.display()
            ));
        }
    }
    if !path.is_dir() {
        return Err(anyhow::anyhow!(
            "the data directory {} is not a directory",
            path.display()
        ));
    }

    #[cfg(unix)]
    {
        // The directory has to belong to the account the daemon runs as. A
        // directory owned by somebody else would hand that person the device
        // token, the signing key, and the database.
        let meta = std::fs::metadata(&path)?;
        if meta.uid() != owner_uid {
            return Err(OwnershipError(format!(
                "the data directory {} belongs to another account (uid {}), so Luna cannot keep its secrets in it. Make the folder owned by the account Luna runs as, or point LUNA_DATA_DIR at a private folder of your own",
                path.display(),
                meta.uid()
            )).into());
        }
        // Owner-only, even when it already existed with looser permissions.
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(DATA_DIR_MODE))?;
    }
    #[cfg(not(unix))]
    let _ = owner_uid;

    Ok(())
}

/// The full path of a data directory, so the parent check sees the real
/// directories even when the configured path is relative.
///
/// The path is also resolved through any symlink in it. A data directory
/// that is a link points somewhere else, and it is that place — and the
/// parent of that place — that another account could rename. Checking the
/// link's own parents would miss exactly the case this module exists for.
fn absolute(path: &Path) -> anyhow::Result<std::path::PathBuf> {
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        let current = std::env::current_dir().map_err(|err| {
            anyhow::anyhow!(
                "could not work out the current folder for the data directory {}: {err}",
                path.display()
            )
        })?;
        current.join(path)
    };
    Ok(resolve_symlinks(&path))
}

/// Resolve the symlinks in the longest part of the path that exists.
///
/// A path that does not exist yet cannot be resolved as a whole, so the
/// deepest existing ancestor is resolved and the rest is put back on. That
/// way a data directory that does not exist yet under a symlinked parent
/// still gets the real parent checked.
fn resolve_symlinks(path: &Path) -> std::path::PathBuf {
    let mut current = path;
    let mut tail: Vec<&std::ffi::OsStr> = Vec::new();
    // Walk up until something exists that can be resolved.
    while std::fs::symlink_metadata(current).is_err() {
        let Some(name) = current.file_name() else {
            break;
        };
        let Some(parent) = current.parent() else {
            break;
        };
        tail.push(name);
        current = parent;
    }
    let mut resolved = std::fs::canonicalize(current).unwrap_or_else(|_| current.to_path_buf());
    for name in tail.iter().rev() {
        resolved.push(name);
    }
    resolved
}

/// Check every directory above the data directory.
///
/// A parent that another account may write lets that account rename the
/// data directory and put their own in its place — with the device token
/// and the signing key inside it. Two things stop that:
///
/// - The parent has to belong to the daemon's account or to root. The owner
///   of a directory may always rename what is inside it, whatever the
///   permissions say.
/// - Otherwise the parent must not let anybody else in. A sticky directory
///   (like /tmp) already does that: the sticky bit means only the owner of
///   an entry may rename it, so our data directory is safe inside it even
///   though other accounts may write there too. Without the sticky bit, the
///   parent must not be writable by other accounts — except by a group the
///   daemon itself belongs to, which is the same people.
#[cfg(unix)]
fn check_parents(path: &Path, owner_uid: u32) -> anyhow::Result<()> {
    let own_groups = current_groups();
    for parent in path.ancestors().skip(1) {
        if parent.as_os_str().is_empty() {
            continue;
        }
        let meta = std::fs::metadata(parent)?;
        if !meta.is_dir() {
            continue;
        }
        let mode = meta.permissions().mode();
        let uid = meta.uid();
        let gid = meta.gid();

        // The owner of a directory may rename what is inside it. Somebody
        // else's directory is therefore never a safe place for the data.
        if uid != owner_uid && uid != 0 {
            return Err(OwnershipError(format!(
                "the parent directory {} belongs to another account, so Luna cannot protect its data directory. Move the data directory to a private folder of your own, or point LUNA_DATA_DIR at one",
                parent.display()
            )).into());
        }

        // A sticky directory protects its entries: only their owner may
        // rename or remove them. /tmp is the everyday case.
        if mode & 0o1000 != 0 {
            continue;
        }

        let writable_by_others = mode & 0o002 != 0;
        let writable_by_group = mode & 0o020 != 0;
        let trusted_group = !writable_by_group || own_groups.contains(&gid);
        if writable_by_others || !trusted_group {
            return Err(OwnershipError(format!(
                "the parent directory {} is not safely owned, so Luna cannot protect its data directory. Move the data directory to a private folder of your own, or point LUNA_DATA_DIR at one",
                parent.display()
            )).into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn mode(path: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn creates_the_data_directory_owner_only() {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("luna");
        prepare(&data, current_uid()).unwrap();
        assert!(data.is_dir());
        #[cfg(unix)]
        assert_eq!(mode(&data), DATA_DIR_MODE);
    }

    #[test]
    fn creates_missing_parents_and_keeps_them_ordinary() {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("a/b/c/luna");
        prepare(&data, current_uid()).unwrap();
        assert!(data.is_dir());
        #[cfg(unix)]
        assert_eq!(mode(&data), DATA_DIR_MODE);
    }

    #[test]
    fn tightens_a_directory_that_was_too_open() {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("luna");
        std::fs::create_dir(&data).unwrap();
        #[cfg(unix)]
        std::fs::set_permissions(&data, std::fs::Permissions::from_mode(0o755)).unwrap();
        prepare(&data, current_uid()).unwrap();
        #[cfg(unix)]
        assert_eq!(mode(&data), DATA_DIR_MODE);
    }

    /// The data stays where it is: preparing the directory must not move or
    /// remove what is inside it.
    #[test]
    fn keeps_the_data_that_is_already_there() {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("luna");
        std::fs::create_dir(&data).unwrap();
        std::fs::write(data.join("luna.db"), b"rows").unwrap();
        std::fs::write(data.join("device-token"), b"SEC-1").unwrap();
        prepare(&data, current_uid()).unwrap();
        assert_eq!(std::fs::read(data.join("luna.db")).unwrap(), b"rows");
        assert_eq!(std::fs::read(data.join("device-token")).unwrap(), b"SEC-1");
    }

    /// A directory owned by somebody else is refused — that is the case
    /// where a root daemon would hand its secrets to another account.
    #[test]
    fn refuses_a_directory_owned_by_somebody_else() {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("luna");
        std::fs::create_dir(&data).unwrap();
        let other = current_uid().wrapping_add(1);
        let cause = prepare(&data, other).unwrap_err();
        assert!(is_ownership_error(&cause));
        let err = cause.to_string();
        assert!(err.contains("another account"), "unexpected error: {err}");
        // The directory is left alone — no data moved, nothing deleted.
        assert!(data.is_dir());
    }

    /// The message tells the person what to do about it.
    #[test]
    fn the_foreign_owner_error_says_how_to_fix_it() {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("luna");
        std::fs::create_dir(&data).unwrap();
        let cause = prepare(&data, current_uid().wrapping_add(1)).unwrap_err();
        let err = cause.to_string();
        assert!(err.contains("LUNA_DATA_DIR"), "unexpected error: {err}");
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_directory_under_an_untrusted_writable_parent() {
        let root = tempfile::tempdir().unwrap();
        let parent = root.path().join("shared");
        std::fs::create_dir(&parent).unwrap();
        std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o777)).unwrap();
        let data = parent.join("luna");

        let error = prepare(&data, current_uid()).unwrap_err();

        assert!(is_ownership_error(&error));
        assert!(error.to_string().contains("parent directory"));
        // Nothing was left behind in a place that is not safe.
        assert!(!data.exists());
    }

    /// A parent that the daemon's own group may write is a normal shared
    /// folder, not a hostile one: it must not be refused.
    #[cfg(unix)]
    #[test]
    fn accepts_a_parent_the_own_group_may_write() {
        let root = tempfile::tempdir().unwrap();
        let parent = root.path().join("shared");
        std::fs::create_dir(&parent).unwrap();
        std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o770)).unwrap();
        let data = parent.join("luna");

        prepare(&data, current_uid()).unwrap();

        assert!(data.is_dir());
        assert_eq!(mode(&data), DATA_DIR_MODE);
    }

    /// A sticky parent that other accounts may write — /tmp and friends —
    /// cannot be used to rename the data directory, so it is allowed.
    #[cfg(unix)]
    #[test]
    fn accepts_a_sticky_parent_other_accounts_may_write() {
        let root = tempfile::tempdir().unwrap();
        let parent = root.path().join("sticky");
        std::fs::create_dir(&parent).unwrap();
        std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o1777)).unwrap();
        let data = parent.join("luna");

        prepare(&data, current_uid()).unwrap();

        assert!(data.is_dir());
        assert_eq!(mode(&data), DATA_DIR_MODE);
    }

    /// A relative data directory is checked against the folders it really
    /// sits in, not skipped.
    #[test]
    fn a_relative_data_directory_resolves_to_a_full_path() {
        let root = tempfile::tempdir().unwrap();
        let relative = std::path::Path::new("luna-data");
        let resolved = absolute(&root.path().join(relative)).unwrap();
        assert!(resolved.is_absolute());
        assert!(resolved.ends_with(relative));
    }

    /// A data directory that is a symlink points somewhere else, and it is
    /// the parent of THAT place that could rename it. The check has to
    /// follow the link.
    #[cfg(unix)]
    #[test]
    fn follows_a_symlinked_data_directory_to_its_real_parent() {
        let root = tempfile::tempdir().unwrap();
        // The real parent, and the data directory inside it.
        let real_parent = root.path().join("real");
        std::fs::create_dir(&real_parent).unwrap();
        let real_data = real_parent.join("luna");
        std::fs::create_dir(&real_data).unwrap();

        // A link to it, from a folder that is perfectly safe.
        let link_parent = root.path().join("link-parent");
        std::fs::create_dir(&link_parent).unwrap();
        let link = link_parent.join("luna");
        std::os::unix::fs::symlink(&real_data, &link).unwrap();

        // The link's own parent is safe, but the real parent is not — so
        // the real parent is what decides.
        std::fs::set_permissions(&real_parent, std::fs::Permissions::from_mode(0o777)).unwrap();

        let error = prepare(&link, current_uid()).unwrap_err();

        assert!(is_ownership_error(&error), "unexpected error: {error}");
        // The message names the directory that is actually the problem.
        assert!(
            error
                .to_string()
                .contains(&real_parent.display().to_string()),
            "the error must name the real parent, got: {error}"
        );
    }

    /// A symlink to a safe place is fine: the check follows the link and
    /// finds nothing wrong there.
    #[cfg(unix)]
    #[test]
    fn accepts_a_symlinked_data_directory_in_a_safe_place() {
        let root = tempfile::tempdir().unwrap();
        let real_parent = root.path().join("real");
        std::fs::create_dir(&real_parent).unwrap();
        let real_data = real_parent.join("luna");
        std::fs::create_dir(&real_data).unwrap();

        let link = root.path().join("luna-link");
        std::os::unix::fs::symlink(&real_data, &link).unwrap();

        prepare(&link, current_uid()).unwrap();

        // The real directory is the one that got secured.
        assert_eq!(mode(&real_data), DATA_DIR_MODE);
    }

    #[test]
    fn reports_a_directory_it_cannot_create() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("not-a-dir");
        std::fs::write(&file, b"x").unwrap();
        let data = file.join("luna");
        let error = prepare(&data, current_uid()).unwrap_err();
        // The reason the directory could not be made is kept, not replaced by
        // a generic sentence.
        assert!(
            error
                .to_string()
                .contains("could not create the data directory")
        );
    }

    /// A file where the data directory should be is not a data directory.
    #[test]
    fn refuses_a_file_in_the_data_directory_place() {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("luna");
        std::fs::write(&data, b"x").unwrap();
        assert!(prepare(&data, current_uid()).is_err());
    }
}

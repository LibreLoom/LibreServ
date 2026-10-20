//! The data directory's security boundary.
//!
//! The data directory holds the device token, the session signing key, the
//! user database, and the update binaries the daemon runs. On the Luna OS
//! image the daemon runs as root, so a data directory that belongs to
//! somebody else is a way to read those secrets and to swap the binaries.
//!
//! Two rules, then: the directory is created owner-only (never briefly
//! world-readable, because that is where the secrets land), and it must belong
//! to the account the daemon runs as.

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

/// Non-Unix builds do not have Unix ownership checks, but keep the startup
/// helper available so the daemon still compiles on those targets.
#[cfg(not(unix))]
pub fn current_uid() -> u32 {
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

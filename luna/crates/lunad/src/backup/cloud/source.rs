use std::io::ErrorKind;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

use rusqlite::Connection;

use crate::backup::drive_backup::FOLDER_GONE_REASON;
use crate::backup::{scope, status};
use crate::db;
use crate::drives::layout::Layout;
use crate::files::{self, FilesError};

use super::format::Tree;
use super::retention;
use super::run::{CloudOutcome, lock, problem_outcome};

const NOT_CONNECTED: &str = "Waiting: The drive this backup copies isn’t connected.";
const UNREADABLE: &str = "Luna couldn't read the folder being backed up.";

pub(super) const MASS_DELETE: &str =
    "Most of the files in this folder are gone. Check the folder before running the backup again.";
pub(super) const CHECK_FAILED: &str =
    "Luna couldn't compare this folder with the last cloud copy. Try again.";

pub(super) enum Unavailable {
    Gone(&'static str),
    Waiting(String),
}

impl Unavailable {
    pub(super) fn record(self, db: &crate::Db, id: &str, now: i64) -> anyhow::Result<CloudOutcome> {
        let conn = lock(db);
        retention::pause(&conn, id, now)?;
        match self {
            Self::Gone(reason) => {
                db::set_protection_state(&conn, id, db::PROTECTION_SOURCE_GONE, reason)?;
                Ok(problem_outcome(reason))
            }
            Self::Waiting(reason) => Ok(problem_outcome(&reason)),
        }
    }
}

pub(super) fn resolve(conn: &Connection, row: &db::ProtectionRow) -> Result<Folder, Unavailable> {
    match db::get_drive(conn, &row.source_drive) {
        Ok(Some(_)) => {}
        Ok(None) => return Err(Unavailable::Gone(db::DRIVE_FORGOTTEN_REASON)),
        Err(_) => return Err(Unavailable::Waiting(UNREADABLE.into())),
    }
    let drive = match files::drive_root(conn, &row.source_drive) {
        Ok(drive) => drive,
        Err(FilesError::UnknownDrive) => return Err(Unavailable::Waiting(NOT_CONNECTED.into())),
        Err(err) => return Err(Unavailable::Waiting(err.to_string())),
    };
    let mount = PathBuf::from(&drive.mount_point);
    let mount_identity =
        mount_identity(&mount).ok_or_else(|| Unavailable::Waiting(NOT_CONNECTED.into()))?;
    if Layout::detect(&mount).is_none() {
        return Err(Unavailable::Waiting(NOT_CONNECTED.into()));
    }
    match files::resolve_any_at(&drive, &row.source_path, false) {
        Ok((root, meta)) if meta.is_dir() => {
            let rel = files::canonical_rel(&row.source_path)
                .map_err(|_| Unavailable::Waiting(UNREADABLE.into()))?;
            let direct = luna_core::path::resolve_child_nofollow(&mount, &rel);
            if !direct.is_ok_and(|direct| direct == root) {
                return Err(Unavailable::Waiting(UNREADABLE.into()));
            }
            Ok(Folder {
                root,
                identity: (meta.dev(), meta.ino()),
                mount: Some((mount, mount_identity)),
            })
        }
        Ok(_) => {
            verify_mount(&mount, mount_identity)?;
            Err(Unavailable::Gone(FOLDER_GONE_REASON))
        }
        Err(FilesError::Io(err) | FilesError::Path(luna_core::path::PathError::NotFound(err)))
            if err.kind() == ErrorKind::NotFound =>
        {
            verify_mount(&mount, mount_identity)?;
            Err(Unavailable::Gone(FOLDER_GONE_REASON))
        }
        Err(_) => Err(Unavailable::Waiting(UNREADABLE.into())),
    }
}

pub(super) struct Folder {
    root: PathBuf,
    identity: (u64, u64),
    mount: Option<(PathBuf, (u64, u64))>,
}

impl Folder {
    #[cfg(test)]
    pub(super) fn at(root: &Path) -> Result<Self, Unavailable> {
        Ok(Self {
            root: root.to_path_buf(),
            identity: folder_identity(root)?,
            mount: None,
        })
    }

    fn verify(&self) -> Result<(), Unavailable> {
        if let Some((root, identity)) = &self.mount {
            verify_mount(root, *identity)?;
        }
        if folder_identity(&self.root)? == self.identity {
            Ok(())
        } else {
            Err(Unavailable::Waiting(UNREADABLE.into()))
        }
    }

    pub(super) fn walk(self) -> Result<Walk, Unavailable> {
        self.verify()?;
        let result = scope::walk(&self.root);
        self.verify()?;
        let files = result.map_err(|_| Unavailable::Waiting(UNREADABLE.into()))?;
        Ok(Walk {
            folder: self,
            files,
            pin: None,
        })
    }
}

pub(crate) struct Walk {
    folder: Folder,
    pub files: Vec<scope::Entry>,
    pub pin: Option<String>,
}

impl Walk {
    pub(super) fn verify(&self) -> Result<(), Unavailable> {
        self.folder.verify()
    }

    pub(super) fn read_error(
        &self,
        db: &crate::Db,
        id: &str,
        now: i64,
    ) -> anyhow::Result<CloudOutcome> {
        match self.verify() {
            Ok(()) => hold(db, id, now, UNREADABLE, false),
            Err(unavailable) => unavailable.record(db, id, now),
        }
    }

    /// The walk and the previous tree both have paths sorted in normal runs. Use a
    /// set so the comparison also handles trees written by older versions.
    pub(super) fn compare(
        &mut self,
        snapshot_id: &str,
        previous: &Tree,
        accept_missing: bool,
    ) -> bool {
        let present: std::collections::HashSet<_> =
            self.files.iter().map(|file| file.rel.as_str()).collect();
        let missing = previous
            .entries
            .iter()
            .filter(|entry| !present.contains(entry.path.as_str()))
            .count();
        if !accept_missing && status::is_mass_delete(missing, previous.entries.len()) {
            return false;
        }
        if missing != 0 {
            self.pin = Some(snapshot_id.to_string());
        }
        true
    }
}

pub(super) fn hold(
    db: &crate::Db,
    id: &str,
    now: i64,
    reason: &str,
    confirmable: bool,
) -> anyhow::Result<CloudOutcome> {
    retention::pause(&lock(db), id, now)?;
    Ok(CloudOutcome {
        source_missing: confirmable,
        ..problem_outcome(reason)
    })
}

pub(super) fn revive(db: &crate::Db, id: &str) -> anyhow::Result<()> {
    let conn = lock(db);
    if db::get_protection(&conn, id)?.is_some_and(|row| row.state == db::PROTECTION_SOURCE_GONE) {
        db::set_protection_state(&conn, id, db::PROTECTION_ACTIVE, "")?;
    }
    Ok(())
}

fn mount_identity(root: &Path) -> Option<(u64, u64)> {
    let meta = std::fs::metadata(root).ok()?;
    meta.is_dir().then(|| (meta.dev(), meta.ino()))
}

fn verify_mount(root: &Path, identity: (u64, u64)) -> Result<(), Unavailable> {
    if mount_identity(root) == Some(identity) {
        Ok(())
    } else {
        Err(Unavailable::Waiting(NOT_CONNECTED.into()))
    }
}

fn folder_identity(root: &Path) -> Result<(u64, u64), Unavailable> {
    match std::fs::symlink_metadata(root) {
        Ok(meta) if meta.is_dir() => Ok((meta.dev(), meta.ino())),
        Ok(_) => Err(Unavailable::Gone(FOLDER_GONE_REASON)),
        Err(err) if err.kind() == ErrorKind::NotFound => Err(Unavailable::Gone(FOLDER_GONE_REASON)),
        Err(_) => Err(Unavailable::Waiting(UNREADABLE.into())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_forgotten_drive_is_gone() {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        let row = db::ProtectionRow::probe(db::PROTECTION_CLOUD, "drive", "Photos", "", "");
        assert!(matches!(resolve(&conn, &row), Err(Unavailable::Gone(_))));

        db::upsert_drive(&conn, "drive", "Photos", "missing", "ext4", "", "").unwrap();
        assert!(matches!(resolve(&conn, &row), Err(Unavailable::Waiting(_))));
    }
}

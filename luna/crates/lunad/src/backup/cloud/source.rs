use std::ffi::CString;
use std::fs::{File, Metadata, OpenOptions};
use std::io::{self, ErrorKind};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::os::unix::io::{AsRawFd, FromRawFd};
use std::path::{Path, PathBuf};

use rusqlite::Connection;

use crate::backup::drive_backup::FOLDER_GONE_REASON;
use crate::backup::scope;
use crate::db;
use crate::drives::layout::Layout;
use crate::files::{self, FilesError};

use super::run::{CloudOutcome, lock, problem_outcome};

const NOT_CONNECTED: &str = "Waiting: The drive this backup copies isn’t connected.";
const UNREADABLE: &str = "Luna couldn't read the folder being backed up.";

pub(super) const CHECK_FAILED: &str =
    "Luna couldn't compare this folder with the last cloud copy. Try again.";

pub(super) enum Unavailable {
    Gone(&'static str),
    Waiting(String),
}

impl Unavailable {
    pub(super) fn record(self, db: &crate::Db, id: &str) -> anyhow::Result<CloudOutcome> {
        let conn = lock(db);
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
        // Reads go through this descriptor, so a path swapped after this point cannot redirect them.
        let dir = open_dir(&self.root).map_err(|_| Unavailable::Waiting(UNREADABLE.into()))?;
        if dir_identity(&dir) != Some(self.identity) {
            return Err(Unavailable::Waiting(UNREADABLE.into()));
        }
        let result = scope::walk(&self.root);
        self.verify()?;
        let files = result.map_err(|_| Unavailable::Waiting(UNREADABLE.into()))?;
        Ok(Walk {
            folder: self,
            dir,
            files,
        })
    }
}

pub(crate) struct Walk {
    folder: Folder,
    dir: File,
    pub files: Vec<scope::Entry>,
}

/// A file's metadata as one comparable value. Two equal stamps mean the file did not change
/// between them: a write bumps mtime and ctime, and a replacement changes the inode.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) struct Stamp {
    pub size: u64,
    pub mtime: i64,
    dev: u64,
    ino: u64,
    mtime_nsec: i64,
    ctime: i64,
    ctime_nsec: i64,
}

impl Stamp {
    fn of(meta: &Metadata) -> Self {
        Self {
            size: meta.size(),
            mtime: meta.mtime(),
            dev: meta.dev(),
            ino: meta.ino(),
            mtime_nsec: meta.mtime_nsec(),
            ctime: meta.ctime(),
            ctime_nsec: meta.ctime_nsec(),
        }
    }
}

impl Walk {
    pub(super) fn verify(&self) -> Result<(), Unavailable> {
        self.folder.verify()
    }

    /// Runs `read` on `rel` (relative to the selected root), opened without following symlinks
    /// at any component. If the file's stamp changes while `read` runs, the file is read once
    /// more; `Ok(None)` means it still changed, and the caller should skip it this run.
    pub(super) fn read_file<T>(
        &self,
        rel: &str,
        mut read: impl FnMut(&mut File) -> anyhow::Result<T>,
    ) -> anyhow::Result<Option<(T, Stamp)>> {
        for _ in 0..2 {
            let mut file = open_rel(&self.dir, rel)?;
            let before = Stamp::of(&file.metadata()?);
            let value = read(&mut file)?;
            if Stamp::of(&file.metadata()?) == before {
                return Ok(Some((value, before)));
            }
        }
        Ok(None)
    }

    pub(super) fn read_error(&self, db: &crate::Db, id: &str) -> anyhow::Result<CloudOutcome> {
        match self.verify() {
            Ok(()) => Ok(problem_outcome(UNREADABLE)),
            Err(unavailable) => unavailable.record(db, id),
        }
    }
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

fn open_dir(root: &Path) -> io::Result<File> {
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
        .open(root)
}

fn dir_identity(dir: &File) -> Option<(u64, u64)> {
    let meta = dir.metadata().ok()?;
    meta.is_dir().then(|| (meta.dev(), meta.ino()))
}

/// Opens `rel` one component at a time from `dir` with `openat` and `O_NOFOLLOW`, so a symlink
/// anywhere on the path (including one swapped in after the walk) is refused, not followed.
fn open_rel(dir: &File, rel: &str) -> io::Result<File> {
    let invalid = || io::Error::new(ErrorKind::InvalidInput, "unsafe path in the backup source");
    let parts: Vec<&str> = rel.split('/').collect();
    let mut current: Option<File> = None;
    for (index, part) in parts.iter().enumerate() {
        if part.is_empty() || *part == "." || *part == ".." {
            return Err(invalid());
        }
        let name = CString::new(*part).map_err(|_| invalid())?;
        let last = index + 1 == parts.len();
        // O_NONBLOCK keeps a FIFO swapped in at the last name from blocking the open; the
        // regular-file check below then refuses it.
        let flags = libc::O_RDONLY
            | libc::O_NOFOLLOW
            | libc::O_CLOEXEC
            | if last { libc::O_NONBLOCK } else { libc::O_DIRECTORY };
        let parent = current.as_ref().unwrap_or(dir).as_raw_fd();
        // SAFETY: `parent` is an open descriptor that outlives this call, and `name` is a
        // NUL-free C string that lives until the call returns.
        let fd = unsafe { libc::openat(parent, name.as_ptr(), flags) };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: `openat` returned a new descriptor that nothing else owns.
        current = Some(unsafe { File::from_raw_fd(fd) });
    }
    let file = current.ok_or_else(invalid)?;
    if !file.metadata()?.is_file() {
        return Err(io::Error::new(ErrorKind::InvalidData, "not a regular file"));
    }
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn symlink_swapped_in_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("root");
        let outside = dir.path().join("outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.txt"), b"secret").unwrap();
        std::fs::write(root.join("a.txt"), b"inside").unwrap();
        let handle = open_dir(&root).unwrap();

        // The walked file is replaced by a link to a file outside the selected tree.
        std::fs::remove_file(root.join("a.txt")).unwrap();
        std::os::unix::fs::symlink(outside.join("secret.txt"), root.join("a.txt")).unwrap();
        assert!(open_rel(&handle, "a.txt").is_err());

        // A directory component swapped for a link to outside is refused too.
        std::os::unix::fs::symlink(&outside, root.join("linked")).unwrap();
        assert!(open_rel(&handle, "linked/secret.txt").is_err());
    }

    #[test]
    fn file_changing_during_read_is_not_committed() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("root");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("a.txt"), b"first").unwrap();
        let walk = Walk {
            folder: Folder::at(&root).ok().unwrap(),
            dir: open_dir(&root).unwrap(),
            files: Vec::new(),
        };

        // Every read rewrites the file, so the stamp never settles and nothing is committed.
        let mut reads = 0;
        let torn = walk
            .read_file("a.txt", |file| {
                reads += 1;
                let mut buf = Vec::new();
                std::io::Read::read_to_end(file, &mut buf)?;
                std::fs::write(root.join("a.txt"), format!("changed {reads}"))?;
                Ok(buf)
            })
            .unwrap();
        assert!(torn.is_none());
        assert_eq!(reads, 2, "the file is retried once before it is skipped");

        // A file that stays put reads cleanly on the first try.
        let (data, stamp) = walk
            .read_file("a.txt", |file| {
                let mut buf = Vec::new();
                std::io::Read::read_to_end(file, &mut buf)?;
                Ok(buf)
            })
            .unwrap()
            .unwrap();
        assert_eq!(data, format!("changed {}", reads).into_bytes());
        assert_eq!(stamp.size, data.len() as u64);
    }

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

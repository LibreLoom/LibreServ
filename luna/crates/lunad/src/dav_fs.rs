//! WebDAV filesystem that never follows symlinks out of (or inside) a drive.
//!
//! dav-server's LocalFs uses ordinary `open`/`metadata`, which follow
//! symlinks. This backend resolves every path with `resolve_child_nofollow`
//! and opens files with `O_NOFOLLOW`.
//!
//! [`GrantFs`] wraps [`JailedFs`] and enforces the same folder grants as the
//! file API (admins see everything; members only what they were granted).

use std::io::{Read, Seek, SeekFrom, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use bytes::{Buf, Bytes};
use dav_server::davpath::DavPath;
use dav_server::fs::{
    DavDirEntry, DavFile, DavFileSystem, DavMetaData, FsError, FsFuture, FsResult, FsStream,
    OpenOptions, ReadDirMeta,
};
use luna_core::path::{PathError, resolve_child_nofollow, resolve_for_create_nofollow};
use rusqlite::Connection;

use crate::auth::{CurrentUser, can_access, can_browse_path};

#[derive(Clone)]
pub struct JailedFs {
    root: PathBuf,
}

impl JailedFs {
    pub fn new(root: impl AsRef<Path>) -> Self {
        Self {
            root: root.as_ref().to_path_buf(),
        }
    }

    fn rel(path: &DavPath) -> FsResult<String> {
        let p = path.as_rel_ospath();
        p.to_str().map(str::to_string).ok_or(FsError::Forbidden)
    }

    fn map_err(err: PathError) -> FsError {
        match err {
            PathError::Escape | PathError::Absolute => FsError::Forbidden,
            PathError::NotFound(_) => FsError::NotFound,
            PathError::Io(e) => io_to_fs(e),
        }
    }
}

/// Drive-jailed FS plus per-user grant checks.
#[derive(Clone)]
pub struct GrantFs {
    inner: JailedFs,
    user: CurrentUser,
    drive_id: String,
    db: Arc<Mutex<Connection>>,
}

impl GrantFs {
    pub fn new(
        root: impl AsRef<Path>,
        user: CurrentUser,
        drive_id: impl Into<String>,
        db: Arc<Mutex<Connection>>,
    ) -> Self {
        Self {
            inner: JailedFs::new(root),
            user,
            drive_id: drive_id.into(),
            db,
        }
    }

    fn rel(path: &DavPath) -> FsResult<String> {
        JailedFs::rel(path)
    }

    fn join_child(parent: &str, name: &str) -> String {
        if parent.is_empty() {
            name.to_string()
        } else {
            format!("{parent}/{name}")
        }
    }

    fn require_read(&self, rel: &str) -> FsResult<()> {
        let conn = self.db.lock().map_err(|_| FsError::GeneralFailure)?;
        if can_access(&self.user, &conn, &self.drive_id, rel, false) {
            Ok(())
        } else {
            Err(FsError::Forbidden)
        }
    }

    fn require_write(&self, rel: &str) -> FsResult<()> {
        let conn = self.db.lock().map_err(|_| FsError::GeneralFailure)?;
        if can_access(&self.user, &conn, &self.drive_id, rel, true) {
            Ok(())
        } else {
            Err(FsError::Forbidden)
        }
    }

    fn require_browse(&self, rel: &str) -> FsResult<()> {
        let conn = self.db.lock().map_err(|_| FsError::GeneralFailure)?;
        if can_browse_path(&self.user, &conn, &self.drive_id, rel) {
            Ok(())
        } else {
            Err(FsError::Forbidden)
        }
    }

    fn may_browse_child(&self, parent: &str, name: &str) -> bool {
        let child = Self::join_child(parent, name);
        let Ok(conn) = self.db.lock() else {
            return false;
        };
        can_browse_path(&self.user, &conn, &self.drive_id, &child)
    }
}

fn io_to_fs(e: std::io::Error) -> FsError {
    match e.kind() {
        std::io::ErrorKind::NotFound => FsError::NotFound,
        std::io::ErrorKind::PermissionDenied => FsError::Forbidden,
        std::io::ErrorKind::AlreadyExists => FsError::Exists,
        _ if e.raw_os_error() == Some(libc::ELOOP) => FsError::Forbidden,
        _ => FsError::GeneralFailure,
    }
}

#[derive(Debug, Clone)]
struct Meta(std::fs::Metadata);

impl DavMetaData for Meta {
    fn len(&self) -> u64 {
        self.0.len()
    }
    fn modified(&self) -> FsResult<SystemTime> {
        self.0.modified().map_err(io_to_fs)
    }
    fn is_dir(&self) -> bool {
        self.0.is_dir()
    }
    fn is_file(&self) -> bool {
        self.0.is_file()
    }
    fn is_symlink(&self) -> bool {
        self.0.file_type().is_symlink()
    }
}

#[derive(Debug)]
struct File {
    file: std::fs::File,
}

impl DavFile for File {
    fn metadata(&'_ mut self) -> FsFuture<'_, Box<dyn DavMetaData>> {
        Box::pin(async move {
            let meta = self.file.metadata().map_err(io_to_fs)?;
            Ok(Box::new(Meta(meta)) as Box<dyn DavMetaData>)
        })
    }
    fn write_buf(&'_ mut self, mut buf: Box<dyn Buf + Send>) -> FsFuture<'_, ()> {
        Box::pin(async move {
            while buf.has_remaining() {
                let n = self.file.write(buf.chunk()).map_err(io_to_fs)?;
                buf.advance(n);
            }
            Ok(())
        })
    }
    fn write_bytes(&'_ mut self, buf: Bytes) -> FsFuture<'_, ()> {
        Box::pin(async move {
            self.file.write_all(&buf).map_err(io_to_fs)?;
            Ok(())
        })
    }
    fn read_bytes(&'_ mut self, count: usize) -> FsFuture<'_, Bytes> {
        Box::pin(async move {
            let mut buf = vec![0u8; count];
            let n = self.file.read(&mut buf).map_err(io_to_fs)?;
            buf.truncate(n);
            Ok(Bytes::from(buf))
        })
    }
    fn seek(&'_ mut self, pos: SeekFrom) -> FsFuture<'_, u64> {
        Box::pin(async move { self.file.seek(pos).map_err(io_to_fs) })
    }
    fn flush(&'_ mut self) -> FsFuture<'_, ()> {
        Box::pin(async move {
            self.file.flush().map_err(io_to_fs)?;
            Ok(())
        })
    }
}

struct DirEntry {
    name: Vec<u8>,
    meta: std::fs::Metadata,
}

impl DavDirEntry for DirEntry {
    fn name(&self) -> Vec<u8> {
        self.name.clone()
    }
    fn metadata(&'_ self) -> FsFuture<'_, Box<dyn DavMetaData>> {
        let meta = self.meta.clone();
        Box::pin(async move { Ok(Box::new(Meta(meta)) as Box<dyn DavMetaData>) })
    }
}

fn open_write_requested(options: &OpenOptions) -> bool {
    options.write
        || options.append
        || options.truncate
        || options.create
        || options.create_new
}

impl DavFileSystem for JailedFs {
    fn open<'a>(
        &'a self,
        path: &'a DavPath,
        options: OpenOptions,
    ) -> FsFuture<'a, Box<dyn DavFile>> {
        Box::pin(async move {
            let rel = Self::rel(path)?;
            if crate::files::is_internal_temp(&rel) {
                return Err(FsError::NotFound);
            }
            let disk = if options.create || options.create_new {
                resolve_for_create_nofollow(&self.root, &rel).map_err(Self::map_err)?
            } else {
                resolve_child_nofollow(&self.root, &rel).map_err(Self::map_err)?
            };
            let mut opts = std::fs::OpenOptions::new();
            opts.read(options.read)
                .write(options.write)
                .append(options.append)
                .truncate(options.truncate)
                .create(options.create)
                .create_new(options.create_new)
                .custom_flags(libc::O_NOFOLLOW);
            let file = opts.open(&disk).map_err(io_to_fs)?;
            Ok(Box::new(File { file }) as Box<dyn DavFile>)
        })
    }

    fn read_dir<'a>(
        &'a self,
        path: &'a DavPath,
        _meta: ReadDirMeta,
    ) -> FsFuture<'a, FsStream<Box<dyn DavDirEntry>>> {
        Box::pin(async move {
            let rel = Self::rel(path)?;
            let dir = resolve_child_nofollow(&self.root, &rel).map_err(Self::map_err)?;
            let read = std::fs::read_dir(&dir).map_err(io_to_fs)?;
            let mut entries: Vec<FsResult<Box<dyn DavDirEntry>>> = Vec::new();
            for ent in read {
                let ent = match ent {
                    Ok(e) => e,
                    Err(e) => {
                        entries.push(Err(io_to_fs(e)));
                        continue;
                    }
                };
                let name = ent.file_name();
                let Some(name_s) = name.to_str() else {
                    continue;
                };
                if crate::files::is_internal_temp(name_s) {
                    continue;
                }
                let meta = match std::fs::symlink_metadata(ent.path()) {
                    Ok(m) => m,
                    Err(e) => {
                        entries.push(Err(io_to_fs(e)));
                        continue;
                    }
                };
                entries.push(Ok(Box::new(DirEntry {
                    name: name_s.as_bytes().to_vec(),
                    meta,
                }) as Box<dyn DavDirEntry>));
            }
            let stream = futures_util::stream::iter(entries);
            Ok(Box::pin(stream) as FsStream<Box<dyn DavDirEntry>>)
        })
    }

    fn metadata<'a>(&'a self, path: &'a DavPath) -> FsFuture<'a, Box<dyn DavMetaData>> {
        self.symlink_metadata(path)
    }

    fn symlink_metadata<'a>(&'a self, path: &'a DavPath) -> FsFuture<'a, Box<dyn DavMetaData>> {
        Box::pin(async move {
            let rel = Self::rel(path)?;
            if crate::files::is_internal_temp(&rel) {
                return Err(FsError::NotFound);
            }
            let disk = resolve_child_nofollow(&self.root, &rel).map_err(Self::map_err)?;
            let meta = std::fs::symlink_metadata(&disk).map_err(io_to_fs)?;
            Ok(Box::new(Meta(meta)) as Box<dyn DavMetaData>)
        })
    }

    fn create_dir<'a>(&'a self, path: &'a DavPath) -> FsFuture<'a, ()> {
        Box::pin(async move {
            let rel = Self::rel(path)?;
            let disk = resolve_for_create_nofollow(&self.root, &rel).map_err(Self::map_err)?;
            std::fs::create_dir(&disk).map_err(io_to_fs)
        })
    }

    fn remove_dir<'a>(&'a self, path: &'a DavPath) -> FsFuture<'a, ()> {
        Box::pin(async move {
            let rel = Self::rel(path)?;
            let disk = resolve_child_nofollow(&self.root, &rel).map_err(Self::map_err)?;
            std::fs::remove_dir(&disk).map_err(io_to_fs)
        })
    }

    fn remove_file<'a>(&'a self, path: &'a DavPath) -> FsFuture<'a, ()> {
        Box::pin(async move {
            let rel = Self::rel(path)?;
            let disk = resolve_child_nofollow(&self.root, &rel).map_err(Self::map_err)?;
            std::fs::remove_file(&disk).map_err(io_to_fs)
        })
    }

    fn rename<'a>(&'a self, from: &'a DavPath, to: &'a DavPath) -> FsFuture<'a, ()> {
        Box::pin(async move {
            let from_rel = Self::rel(from)?;
            let to_rel = Self::rel(to)?;
            let src = resolve_child_nofollow(&self.root, &from_rel).map_err(Self::map_err)?;
            let dest = resolve_for_create_nofollow(&self.root, &to_rel).map_err(Self::map_err)?;
            std::fs::rename(&src, &dest).map_err(io_to_fs)
        })
    }

    fn copy<'a>(&'a self, from: &'a DavPath, to: &'a DavPath) -> FsFuture<'a, ()> {
        Box::pin(async move {
            let from_rel = Self::rel(from)?;
            let to_rel = Self::rel(to)?;
            let src = resolve_child_nofollow(&self.root, &from_rel).map_err(Self::map_err)?;
            let dest = resolve_for_create_nofollow(&self.root, &to_rel).map_err(Self::map_err)?;
            std::fs::copy(&src, &dest).map_err(io_to_fs)?;
            Ok(())
        })
    }
}

impl DavFileSystem for GrantFs {
    fn open<'a>(
        &'a self,
        path: &'a DavPath,
        options: OpenOptions,
    ) -> FsFuture<'a, Box<dyn DavFile>> {
        Box::pin(async move {
            let rel = Self::rel(path)?;
            if open_write_requested(&options) {
                self.require_write(&rel)?;
            } else {
                self.require_read(&rel)?;
            }
            self.inner.open(path, options).await
        })
    }

    fn read_dir<'a>(
        &'a self,
        path: &'a DavPath,
        meta: ReadDirMeta,
    ) -> FsFuture<'a, FsStream<Box<dyn DavDirEntry>>> {
        Box::pin(async move {
            let rel = Self::rel(path)?;
            self.require_browse(&rel)?;
            let stream = self.inner.read_dir(path, meta).await?;
            // Filter to grant-visible children (ancestors + granted trees).
            use futures_util::StreamExt;
            let mut entries: Vec<FsResult<Box<dyn DavDirEntry>>> = Vec::new();
            let mut pinned = stream;
            while let Some(item) = pinned.next().await {
                match item {
                    Ok(ent) => {
                        let name = String::from_utf8_lossy(&ent.name()).into_owned();
                        if self.may_browse_child(&rel, &name) {
                            entries.push(Ok(ent));
                        }
                    }
                    Err(e) => entries.push(Err(e)),
                }
            }
            Ok(Box::pin(futures_util::stream::iter(entries)) as FsStream<Box<dyn DavDirEntry>>)
        })
    }

    fn metadata<'a>(&'a self, path: &'a DavPath) -> FsFuture<'a, Box<dyn DavMetaData>> {
        self.symlink_metadata(path)
    }

    fn symlink_metadata<'a>(&'a self, path: &'a DavPath) -> FsFuture<'a, Box<dyn DavMetaData>> {
        Box::pin(async move {
            let rel = Self::rel(path)?;
            self.require_browse(&rel)?;
            self.inner.symlink_metadata(path).await
        })
    }

    fn create_dir<'a>(&'a self, path: &'a DavPath) -> FsFuture<'a, ()> {
        Box::pin(async move {
            let rel = Self::rel(path)?;
            self.require_write(&rel)?;
            self.inner.create_dir(path).await
        })
    }

    fn remove_dir<'a>(&'a self, path: &'a DavPath) -> FsFuture<'a, ()> {
        Box::pin(async move {
            let rel = Self::rel(path)?;
            self.require_write(&rel)?;
            self.inner.remove_dir(path).await
        })
    }

    fn remove_file<'a>(&'a self, path: &'a DavPath) -> FsFuture<'a, ()> {
        Box::pin(async move {
            let rel = Self::rel(path)?;
            self.require_write(&rel)?;
            self.inner.remove_file(path).await
        })
    }

    fn rename<'a>(&'a self, from: &'a DavPath, to: &'a DavPath) -> FsFuture<'a, ()> {
        Box::pin(async move {
            let from_rel = Self::rel(from)?;
            let to_rel = Self::rel(to)?;
            self.require_write(&from_rel)?;
            self.require_write(&to_rel)?;
            self.inner.rename(from, to).await
        })
    }

    fn copy<'a>(&'a self, from: &'a DavPath, to: &'a DavPath) -> FsFuture<'a, ()> {
        Box::pin(async move {
            let from_rel = Self::rel(from)?;
            let to_rel = Self::rel(to)?;
            self.require_read(&from_rel)?;
            self.require_write(&to_rel)?;
            self.inner.copy(from, to).await
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    #[test]
    fn jail_rejects_symlink_escape() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.txt"), b"secret").unwrap();
        symlink(outside.path(), root.path().join("escape")).unwrap();
        let fs = JailedFs::new(root.path());
        let err = resolve_child_nofollow(root.path(), "escape/secret.txt").unwrap_err();
        assert!(matches!(err, PathError::Escape));
        drop(fs);
    }
}

//! WebDAV filesystem that never follows symlinks out of (or inside) a drive.
//!
//! dav-server's LocalFs uses ordinary `open`/`metadata`, which follow
//! symlinks. This backend resolves every path with `resolve_child_nofollow`
//! and opens files with `O_NOFOLLOW`.
//!
//! [`GrantFs`] wraps [`JailedFs`] and enforces the same folder grants as the
//! file API (admins see everything; members only what they were granted).

use std::collections::BTreeSet;
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

use crate::access::{CAP_EDIT, CAP_UPLOAD, CAP_VIEW};
use crate::auth::CurrentUser;

#[derive(Clone)]
pub struct JailedFs {
    root: PathBuf,
}

impl JailedFs {
    #[allow(dead_code)] // kept for unit tests / simple jail without gallery hooks
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
    /// Subject-tree prefix applied to every DAV rel before capability,
    /// trash, and repath checks: `/dav/home` mounts `.luna-<prefix>-members/<username>` as if it
    /// were the whole drive, while grants still resolve against the real
    /// drive-relative path.
    prefix: String,
    db: Arc<Mutex<Connection>>,
    /// Deletes buffered for the end of the request (see [`Self::buffer_remove`]).
    pending_removes: Arc<Mutex<BTreeSet<String>>>,
    /// Per-request caps context — filled on first use. A PROPFIND over a
    /// large folder evaluates caps for every child; fetching the member
    /// rows, the drive mount, and the members-container name once keeps
    /// that to one lock + a few reads per request instead of per entry.
    caps_ctx: Arc<Mutex<Option<Arc<CapsCtx>>>>,
}

/// Everything a caps evaluation needs beyond the path itself — resolved
/// once per DAV request.
struct CapsCtx {
    rows: Vec<crate::db::AccessMemberRow>,
    mount: Option<String>,
    members_name: Option<String>,
    home_here: bool,
}

impl GrantFs {
    pub fn new(
        root: impl AsRef<Path>,
        user: CurrentUser,
        drive_id: impl Into<String>,
        db: Arc<Mutex<Connection>>,
    ) -> Self {
        Self::scoped(root, "", user, drive_id, db)
    }

    /// A mount rooted inside the drive: `root` is the on-disk subtree,
    /// `prefix` the subject path it represents in the access model.
    pub fn scoped(
        root: impl AsRef<Path>,
        prefix: impl Into<String>,
        user: CurrentUser,
        drive_id: impl Into<String>,
        db: Arc<Mutex<Connection>>,
    ) -> Self {
        Self {
            inner: JailedFs::new(root),
            user,
            drive_id: drive_id.into(),
            prefix: prefix.into(),
            db,
            pending_removes: Arc::new(Mutex::new(BTreeSet::new())),
            caps_ctx: Arc::new(Mutex::new(None)),
        }
    }

    /// The shared caps context for this request — built under one lock on
    /// first use, then reused for every entry the request touches.
    fn caps_ctx(&self) -> FsResult<Arc<CapsCtx>> {
        let mut guard = self.caps_ctx.lock().map_err(|_| FsError::GeneralFailure)?;
        if let Some(ctx) = guard.as_ref() {
            return Ok(ctx.clone());
        }
        let conn = self.db.lock().map_err(|_| FsError::GeneralFailure)?;
        let drive = crate::db::get_drive(&conn, &self.drive_id).ok().flatten();
        let mount = drive
            .as_ref()
            .filter(|d| !d.mount_point.is_empty())
            .map(|d| d.mount_point.clone());
        let members_name = mount
            .as_deref()
            .and_then(|m| crate::drives::drive_db::prefix_for(Path::new(m)))
            .map(|p| crate::member_home::members_dir_name(&p));
        let ctx = Arc::new(CapsCtx {
            rows: crate::db::list_access_members_for_user(&conn, &self.user.id).unwrap_or_default(),
            mount,
            members_name,
            home_here: crate::member_home::home_on_drive(&conn, &self.user.id, &self.drive_id),
        });
        *guard = Some(ctx.clone());
        Ok(ctx)
    }

    /// This caller's capability bits on `subject` — evaluated against the
    /// request-cached rows/mount/container instead of hitting the db and
    /// the drive marker for every child of a PROPFIND.
    fn caps_for(&self, ctx: &CapsCtx, subject: &str) -> crate::access::Caps {
        crate::auth::caps_on_path_preloaded(
            &self.user,
            &self.drive_id,
            subject,
            &ctx.rows,
            ctx.mount.as_deref(),
            ctx.members_name.as_deref(),
        )
    }

    fn browsable(&self, ctx: &CapsCtx, subject: &str, caps: crate::access::Caps) -> bool {
        crate::auth::can_browse_path_preloaded(
            &self.user,
            &self.drive_id,
            subject,
            caps,
            &ctx.rows,
            ctx.members_name.as_deref(),
            ctx.home_here,
        )
    }

    /// The subject path a DAV rel stands for in the access model —
    /// `""` on `/dav/home` is the member's `.luna-<prefix>-members/<username>` home root.
    fn subject_rel(&self, rel: &str) -> String {
        Self::join_child(&self.prefix, rel)
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

    fn require_cap(&self, rel: &str, cap: crate::access::Caps) -> FsResult<()> {
        let ctx = self.caps_ctx()?;
        let subject = self.subject_rel(rel);
        let caps = self.caps_for(&ctx, &subject);
        if caps & cap == cap {
            Ok(())
        } else {
            Err(FsError::Forbidden)
        }
    }

    /// Gate a write-mode `open`: brand-new files are an upload into their
    /// folder; rewriting an existing file is an edit (upload-only members
    /// must not overwrite what they can only add).
    ///
    /// Returns the options to actually open with: when the existence check
    /// found no file, `create_new` is forced on so a file appearing between
    /// the check and the open fails atomically instead of being truncated.
    fn require_open_caps(&self, rel: &str, mut options: OpenOptions) -> FsResult<OpenOptions> {
        if !open_write_requested(&options) {
            self.require_cap(rel, CAP_VIEW)?;
            return Ok(options);
        }
        if options.create_new {
            self.require_cap(rel, CAP_UPLOAD)?;
            return Ok(options);
        }
        if options.create {
            return match resolve_child_nofollow(&self.inner.root, rel) {
                Ok(_) => {
                    self.require_cap(rel, CAP_EDIT)?;
                    Ok(options)
                }
                Err(PathError::NotFound(_)) => {
                    self.require_cap(rel, CAP_UPLOAD)?;
                    options.create_new = true;
                    Ok(options)
                }
                Err(e) => Err(JailedFs::map_err(e)),
            };
        }
        self.require_cap(rel, CAP_EDIT)?;
        Ok(options)
    }

    /// Browse gate plus the caller's capability bits on the path — the caps
    /// distinguish a viewable path from a traversal-only waypoint on the
    /// way to a deeper grant.
    fn browse_caps(&self, rel: &str) -> FsResult<crate::access::Caps> {
        let ctx = self.caps_ctx()?;
        let subject = self.subject_rel(rel);
        let caps = self.caps_for(&ctx, &subject);
        if self.browsable(&ctx, &subject, caps) {
            Ok(caps)
        } else {
            Err(FsError::Forbidden)
        }
    }

    fn require_browse(&self, rel: &str) -> FsResult<()> {
        self.browse_caps(rel).map(|_| ())
    }

    /// How a directory child may appear to this caller: fully (CAP_VIEW), as
    /// a traversal waypoint on the path to a deeper grant (listed, but with
    /// masked metadata), or not at all.
    fn child_visibility(&self, parent: &str, name: &str) -> Visibility {
        let child = self.subject_rel(&Self::join_child(parent, name));
        let Ok(ctx) = self.caps_ctx() else {
            return Visibility::Hidden;
        };
        let caps = self.caps_for(&ctx, &child);
        if !self.browsable(&ctx, &child, caps) {
            return Visibility::Hidden;
        }
        if caps & CAP_VIEW == CAP_VIEW {
            Visibility::Full
        } else {
            Visibility::Waypoint
        }
    }

    /// Buffer a delete for the end of the request. dav-server walks a tree
    /// bottom-up — every child is removed before its directory — so an eager
    /// `delete_to_trash` per call scatters one DELETE into per-child trash
    /// entries. Buffering and flushing at `Drop` lets the requested path move
    /// once, whole subtree included. Runs the checks eagerly so dav-server
    /// still gets real errors.
    fn buffer_remove(&self, rel: &str) -> FsResult<()> {
        // Check before `require_cap`: a real `.luna-trash/…` path would
        // otherwise compute caps through the alias's origin remap.
        if is_reserved(rel) {
            return Err(FsError::NotFound);
        }
        // The mount/drive root itself never moves to trash — only user
        // deletion and home-drive migration may take out a home root.
        let rel = rel.trim_matches('/');
        if rel.is_empty() || crate::member_home::is_home_root(&self.subject_rel(rel)) {
            return Err(FsError::Forbidden);
        }
        self.require_cap(rel, CAP_EDIT)?;
        let mut pending = self
            .pending_removes
            .lock()
            .map_err(|_| FsError::GeneralFailure)?;
        pending.insert(rel.to_string());
        Ok(())
    }

    /// Physically trash every buffered remove at or under `rel`, shallowest
    /// first (an ancestor's move carries its pending descendants with it).
    /// Used when a later op in the same request needs the path to really be
    /// gone — e.g. dav-server deleting an overwritten destination before a
    /// rename or copy lands on it.
    fn flush_pending_under(&self, rel: &str) -> FsResult<()> {
        let mut targets: Vec<String> = {
            let pending = self
                .pending_removes
                .lock()
                .map_err(|_| FsError::GeneralFailure)?;
            pending
                .iter()
                .filter(|r| crate::access::path_contains(rel, r))
                .cloned()
                .collect()
        };
        targets.sort_by_key(|t| t.matches('/').count());
        let mut trashed: Vec<String> = Vec::new();
        for t in targets {
            if trashed
                .iter()
                .any(|done| crate::access::path_contains(done, &t))
            {
                continue;
            }
            self.delete_to_trash(&t)?;
            trashed.push(t);
        }
        if let Ok(mut pending) = self.pending_removes.lock() {
            pending.retain(|r| !trashed.iter().any(|d| crate::access::path_contains(d, r)));
        }
        Ok(())
    }

    /// The file API never overwrites, so a COPY/MOVE onto an existing
    /// destination must fail — even when the caller cannot see it.
    /// dav-server deletes the destination first only when its
    /// (browse-gated) `symlink_metadata` succeeds, so the existence check
    /// here must run on the *inner* fs: without it, an upload-only member
    /// could COPY/MOVE over a drop-box file they cannot even list.
    async fn require_dest_free(&self, path: &DavPath) -> FsResult<()> {
        match self.inner.symlink_metadata(path).await {
            Ok(_) => Err(FsError::Exists),
            Err(FsError::NotFound) => Ok(()),
            Err(e) => Err(e),
        }
    }

    /// Route a DAV delete through the same path as the file API:
    /// `delete_to_trash` moves the entry into `{prefix}-trash`, writes
    /// `trash_meta`, and revokes every subject grant at or under the path —
    /// a raw unlink would let member/link grants resurrect onto whatever
    /// later occupies the name.
    fn delete_to_trash(&self, rel: &str) -> FsResult<()> {
        let subject = self.subject_rel(rel);
        // The home root itself never moves to trash — only user deletion
        // and home-drive migration may take it out.
        if crate::member_home::is_home_root(&subject) {
            return Err(FsError::Forbidden);
        }
        let conn = self.db.lock().map_err(|_| FsError::GeneralFailure)?;
        crate::files::delete_to_trash(&conn, &self.drive_id, &subject)
            .map(|_| ())
            .map_err(files_to_fs)
    }

    /// Shares follow the file: retarget member/link subject rows from
    /// `from_rel` to `to_rel` after a successful same-drive rename. DAV
    /// paths are real fs rels, which equal the API paths subjects store
    /// everywhere DAV can reach (trash paths are refused by `is_reserved`).
    fn repath(&self, from_rel: &str, to_rel: &str) -> FsResult<()> {
        let conn = self.db.lock().map_err(|_| FsError::GeneralFailure)?;
        crate::access::repath_subjects(
            &conn,
            &self.drive_id,
            &self.subject_rel(from_rel),
            &self.subject_rel(to_rel),
        )
        .map(|_| ())
        .map_err(|_| FsError::GeneralFailure)
    }
}

impl Drop for GrantFs {
    /// Flush buffered removes shallowest-first: an ancestor's trash move
    /// carries its still-pending descendants with it, so the requested
    /// DELETE lands as one trash entry instead of per-child litter.
    /// `GrantFs` is built per request, so this runs at request teardown.
    fn drop(&mut self) {
        let mut rels: Vec<String> = {
            let Ok(mut pending) = self.pending_removes.lock() else {
                return;
            };
            std::mem::take(&mut *pending).into_iter().collect()
        };
        rels.sort_by_key(|r| r.matches('/').count());
        let mut trashed: Vec<String> = Vec::new();
        for rel in rels {
            if trashed
                .iter()
                .any(|done| crate::access::path_contains(done, &rel))
            {
                continue;
            }
            if self.delete_to_trash(&rel).is_ok() {
                trashed.push(rel);
            }
        }
    }
}

/// How a directory child may appear in a listing (see
/// [`GrantFs::child_visibility`]).
enum Visibility {
    /// Outside every grant and not on the way to one.
    Hidden,
    /// Ancestor of a deeper grant: listed so the tree is reachable, but
    /// metadata is masked (see [`WaypointMeta`]).
    Waypoint,
    /// Caller holds CAP_VIEW on it.
    Full,
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

/// Metadata for a traversal-only waypoint ancestor: keeps the real node type
/// (dir/file/symlink) but masks size and timestamps. Real metadata on
/// folders the caller cannot view would leak the activity inside them —
/// mtimes and sizes changing is an oracle for other people's writes.
#[derive(Debug, Clone)]
struct WaypointMeta(Box<dyn DavMetaData>);

impl DavMetaData for WaypointMeta {
    fn len(&self) -> u64 {
        0
    }
    fn modified(&self) -> FsResult<SystemTime> {
        Ok(SystemTime::UNIX_EPOCH)
    }
    fn is_dir(&self) -> bool {
        self.0.is_dir()
    }
    fn is_file(&self) -> bool {
        self.0.is_file()
    }
    fn is_symlink(&self) -> bool {
        self.0.is_symlink()
    }
}

/// A directory entry whose metadata answers through [`WaypointMeta`].
struct WaypointEntry(Box<dyn DavDirEntry>);

impl DavDirEntry for WaypointEntry {
    fn name(&self) -> Vec<u8> {
        self.0.name()
    }
    fn metadata(&'_ self) -> FsFuture<'_, Box<dyn DavMetaData>> {
        Box::pin(async move {
            let meta = self.0.metadata().await?;
            Ok(Box::new(WaypointMeta(meta)) as Box<dyn DavMetaData>)
        })
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
    options.write || options.append || options.truncate || options.create || options.create_new
}

/// Names DAV must never address, at any depth: everything `is_internal_temp`
/// covers (`.luna-<uuid>` namespace, `.part` upload temps) plus a literal
/// `.luna-trash` segment. `.luna-trash` is the file API's alias for the
/// drive's real `{prefix}-trash` dir — a real entry by that name would
/// shadow the alias, and `caps_on_path` remaps `.luna-trash/<x>` through
/// `trash_original_path` onto unrelated origins, so the name is refused
/// outright rather than treated as an ordinary folder.
fn is_reserved(rel: &str) -> bool {
    crate::files::is_internal_temp(rel)
        || rel
            .split('/')
            .any(|seg| seg == crate::files::TRASH_API_ALIAS)
}

/// Map a `files` module error onto a DAV status.
fn files_to_fs(e: crate::files::FilesError) -> FsError {
    match e {
        crate::files::FilesError::Path(p) => JailedFs::map_err(p),
        crate::files::FilesError::Io(e) => io_to_fs(e),
        crate::files::FilesError::UnknownDrive => FsError::NotFound,
        crate::files::FilesError::MissingDriveDb | crate::files::FilesError::Db(_) => {
            FsError::GeneralFailure
        }
    }
}

impl DavFileSystem for JailedFs {
    fn open<'a>(
        &'a self,
        path: &'a DavPath,
        options: OpenOptions,
    ) -> FsFuture<'a, Box<dyn DavFile>> {
        Box::pin(async move {
            let rel = Self::rel(path)?;
            if is_reserved(&rel) {
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
            if is_reserved(&rel) {
                return Err(FsError::NotFound);
            }
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
                if is_reserved(name_s) {
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
            if is_reserved(&rel) {
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
            if is_reserved(&rel) {
                return Err(FsError::Forbidden);
            }
            let disk = resolve_for_create_nofollow(&self.root, &rel).map_err(Self::map_err)?;
            std::fs::create_dir(&disk).map_err(io_to_fs)
        })
    }

    fn remove_dir<'a>(&'a self, path: &'a DavPath) -> FsFuture<'a, ()> {
        Box::pin(async move {
            let rel = Self::rel(path)?;
            if is_reserved(&rel) {
                return Err(FsError::NotFound);
            }
            let disk = resolve_child_nofollow(&self.root, &rel).map_err(Self::map_err)?;
            std::fs::remove_dir(&disk).map_err(io_to_fs)
        })
    }

    fn remove_file<'a>(&'a self, path: &'a DavPath) -> FsFuture<'a, ()> {
        Box::pin(async move {
            let rel = Self::rel(path)?;
            if is_reserved(&rel) {
                return Err(FsError::NotFound);
            }
            let disk = resolve_child_nofollow(&self.root, &rel).map_err(Self::map_err)?;
            std::fs::remove_file(&disk).map_err(io_to_fs)
        })
    }

    fn rename<'a>(&'a self, from: &'a DavPath, to: &'a DavPath) -> FsFuture<'a, ()> {
        Box::pin(async move {
            let from_rel = Self::rel(from)?;
            let to_rel = Self::rel(to)?;
            if is_reserved(&from_rel) || is_reserved(&to_rel) {
                return Err(FsError::Forbidden);
            }
            let src = resolve_child_nofollow(&self.root, &from_rel).map_err(Self::map_err)?;
            let dest = resolve_for_create_nofollow(&self.root, &to_rel).map_err(Self::map_err)?;
            // Never clobber: an atomic no-replace move closes the window
            // between the caller's existence check and the rename, where a
            // plain rename(2) would silently replace a just-created file.
            // dav-server deletes an overwritten destination first anyway.
            match crate::files::try_rename_move(&src, &dest).map_err(files_to_fs)? {
                true => Ok(()),
                // A move inside one jail root cannot be cross-device.
                false => Err(FsError::GeneralFailure),
            }
        })
    }

    fn copy<'a>(&'a self, from: &'a DavPath, to: &'a DavPath) -> FsFuture<'a, ()> {
        Box::pin(async move {
            let from_rel = Self::rel(from)?;
            let to_rel = Self::rel(to)?;
            if is_reserved(&from_rel) || is_reserved(&to_rel) {
                return Err(FsError::Forbidden);
            }
            let src = resolve_child_nofollow(&self.root, &from_rel).map_err(Self::map_err)?;
            let dest = resolve_for_create_nofollow(&self.root, &to_rel).map_err(Self::map_err)?;
            // create_new: an atomic no-clobber create — `std::fs::copy`
            // truncates an existing destination, which must fail instead.
            let mut src_file = std::fs::OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_NOFOLLOW)
                .open(&src)
                .map_err(io_to_fs)?;
            let mut dst_file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .custom_flags(libc::O_NOFOLLOW)
                .open(&dest)
                .map_err(io_to_fs)?;
            std::io::copy(&mut src_file, &mut dst_file).map_err(io_to_fs)?;
            // Match fs::copy: the destination inherits the source's mode.
            if let Ok(meta) = src_file.metadata() {
                let _ = dst_file.set_permissions(meta.permissions());
            }
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
            if options.create || options.create_new {
                // A path this request already "deleted" (buffered into one
                // trash entry) must physically go before the create checks.
                self.flush_pending_under(&rel)?;
            }
            let options = self.require_open_caps(&rel, options)?;
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
            // Filter to grant-visible children; traversal-waypoint ancestors
            // are listed but report masked metadata.
            use futures_util::StreamExt;
            let mut entries: Vec<FsResult<Box<dyn DavDirEntry>>> = Vec::new();
            let mut pinned = stream;
            while let Some(item) = pinned.next().await {
                match item {
                    Ok(ent) => {
                        let name = String::from_utf8_lossy(&ent.name()).into_owned();
                        match self.child_visibility(&rel, &name) {
                            Visibility::Hidden => {}
                            Visibility::Full => entries.push(Ok(ent)),
                            Visibility::Waypoint => entries
                                .push(Ok(Box::new(WaypointEntry(ent)) as Box<dyn DavDirEntry>)),
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
            let caps = self.browse_caps(&rel)?;
            let meta = self.inner.symlink_metadata(path).await?;
            if caps & CAP_VIEW == CAP_VIEW {
                Ok(meta)
            } else {
                // Traversal waypoint: keep the node type real but mask size
                // and timestamps — real metadata on unviewable ancestors is
                // an activity oracle.
                Ok(Box::new(WaypointMeta(meta)) as Box<dyn DavMetaData>)
            }
        })
    }

    fn create_dir<'a>(&'a self, path: &'a DavPath) -> FsFuture<'a, ()> {
        Box::pin(async move {
            let rel = Self::rel(path)?;
            self.flush_pending_under(&rel)?;
            self.require_cap(&rel, CAP_UPLOAD)?;
            self.inner.create_dir(path).await
        })
    }

    fn remove_dir<'a>(&'a self, path: &'a DavPath) -> FsFuture<'a, ()> {
        Box::pin(async move {
            let rel = Self::rel(path)?;
            self.buffer_remove(&rel)
        })
    }

    fn remove_file<'a>(&'a self, path: &'a DavPath) -> FsFuture<'a, ()> {
        Box::pin(async move {
            let rel = Self::rel(path)?;
            self.buffer_remove(&rel)
        })
    }

    fn rename<'a>(&'a self, from: &'a DavPath, to: &'a DavPath) -> FsFuture<'a, ()> {
        Box::pin(async move {
            let from_rel = Self::rel(from)?;
            let to_rel = Self::rel(to)?;
            // A scoped mount's root (the member's home dir) is fixed — only
            // user deletion or home-drive migration may relocate it.
            if crate::member_home::is_home_root(&self.subject_rel(&from_rel))
                || crate::member_home::is_home_root(&self.subject_rel(&to_rel))
            {
                return Err(FsError::Forbidden);
            }
            self.require_cap(&from_rel, CAP_EDIT)?;
            self.require_cap(&to_rel, CAP_UPLOAD)?;
            // dav-server deletes an overwritten destination inside this same
            // request; those removes are buffered, so run them now.
            self.flush_pending_under(&to_rel)?;
            self.require_dest_free(to).await?;
            self.inner.rename(from, to).await?;
            self.repath(&from_rel, &to_rel)
        })
    }

    fn copy<'a>(&'a self, from: &'a DavPath, to: &'a DavPath) -> FsFuture<'a, ()> {
        Box::pin(async move {
            let from_rel = Self::rel(from)?;
            let to_rel = Self::rel(to)?;
            self.require_cap(&from_rel, CAP_VIEW)?;
            self.require_cap(&to_rel, CAP_UPLOAD)?;
            self.flush_pending_under(&to_rel)?;
            self.require_dest_free(to).await?;
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

    /// An adopted drive (marker + microdb + drives row) so trash/layout
    /// helpers work, plus the db handle GrantFs checks grants against.
    struct Fixture {
        _dir: tempfile::TempDir,
        root: PathBuf,
        db: Arc<Mutex<Connection>>,
        drive_id: String,
    }

    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
        let drive_id = "drive-1".to_string();
        let root = dir.path().join("drive");
        std::fs::create_dir_all(&root).unwrap();
        let marker = luna_core::marker::Marker::new(&drive_id, "Test");
        let prefix = luna_core::marker::pick_prefix(&root).unwrap();
        crate::drives::drive_db::create(&root, &marker, &prefix).unwrap();
        crate::db::upsert_drive(
            &conn,
            &drive_id,
            "Test",
            "as_is",
            "ext4",
            "sdz",
            root.to_str().unwrap(),
        )
        .unwrap();
        Fixture {
            _dir: dir,
            root,
            db: Arc::new(Mutex::new(conn)),
            drive_id,
        }
    }

    fn davpath(rel: &str) -> DavPath {
        DavPath::new(&format!("/{rel}")).unwrap()
    }

    fn admin() -> CurrentUser {
        CurrentUser {
            id: "admin-1".into(),
            username: "admin".into(),
            role: "admin".into(),
        }
    }

    fn member(id: &str) -> CurrentUser {
        CurrentUser {
            id: id.into(),
            username: id.into(),
            role: "user".into(),
        }
    }

    fn grant(fx: &Fixture, user_id: &str, path: &str, caps: crate::access::Caps) {
        let conn = fx.db.lock().unwrap();
        crate::db::insert_access_member(
            &conn,
            &crate::db::AccessMemberRow {
                id: format!("g-{user_id}-{}", path.replace('/', "_")),
                subject_kind: crate::access::KIND_PATH.into(),
                drive_id: fx.drive_id.clone(),
                path: path.into(),
                album_id: String::new(),
                user_id: user_id.into(),
                caps,
                created_by: "test".into(),
            },
        )
        .unwrap();
    }

    fn member_paths(fx: &Fixture, user_id: &str) -> Vec<String> {
        let conn = fx.db.lock().unwrap();
        crate::db::list_access_members_for_user(&conn, user_id)
            .unwrap()
            .into_iter()
            .map(|r| r.path)
            .collect()
    }

    /// View on `docs/`, upload-only on `drop/`: the destination exists but
    /// is invisible, so dav-server never deletes it first. COPY must still
    /// refuse rather than clobber `payroll.pdf`.
    #[tokio::test]
    async fn grantfs_copy_never_overwrites_invisible_destination() {
        let fx = fixture();
        std::fs::create_dir_all(fx.root.join("docs")).unwrap();
        std::fs::create_dir_all(fx.root.join("drop")).unwrap();
        std::fs::write(fx.root.join("docs/a.txt"), b"a").unwrap();
        std::fs::write(fx.root.join("drop/payroll.pdf"), b"payroll").unwrap();
        grant(&fx, "sam", "docs", CAP_VIEW);
        grant(&fx, "sam", "drop", CAP_UPLOAD);
        let fs = GrantFs::new(&fx.root, member("sam"), fx.drive_id.clone(), fx.db.clone());

        let err = fs
            .copy(&davpath("docs/a.txt"), &davpath("drop/payroll.pdf"))
            .await
            .unwrap_err();
        assert_eq!(err, FsError::Exists);
        assert_eq!(
            std::fs::read(fx.root.join("drop/payroll.pdf")).unwrap(),
            b"payroll"
        );
    }

    /// Same hole through MOVE: full access on `docs/`, upload-only on
    /// `drop/` — the existing destination must survive.
    #[tokio::test]
    async fn grantfs_move_never_overwrites_invisible_destination() {
        let fx = fixture();
        std::fs::create_dir_all(fx.root.join("docs")).unwrap();
        std::fs::create_dir_all(fx.root.join("drop")).unwrap();
        std::fs::write(fx.root.join("docs/a.txt"), b"a").unwrap();
        std::fs::write(fx.root.join("drop/payroll.pdf"), b"payroll").unwrap();
        grant(&fx, "sam", "docs", crate::access::CAP_ALL);
        grant(&fx, "sam", "drop", CAP_UPLOAD);
        let fs = GrantFs::new(&fx.root, member("sam"), fx.drive_id.clone(), fx.db.clone());

        let err = fs
            .rename(&davpath("docs/a.txt"), &davpath("drop/payroll.pdf"))
            .await
            .unwrap_err();
        assert_eq!(err, FsError::Exists);
        assert_eq!(
            std::fs::read(fx.root.join("drop/payroll.pdf")).unwrap(),
            b"payroll"
        );
        assert!(fx.root.join("docs/a.txt").exists());
    }

    /// A MOVE/COPY into a writable folder still works when the destination
    /// does not exist.
    #[tokio::test]
    async fn grantfs_move_into_writable_destination_still_works() {
        let fx = fixture();
        std::fs::create_dir_all(fx.root.join("docs")).unwrap();
        std::fs::create_dir_all(fx.root.join("drop")).unwrap();
        std::fs::write(fx.root.join("docs/a.txt"), b"a").unwrap();
        grant(&fx, "sam", "docs", crate::access::CAP_ALL);
        grant(&fx, "sam", "drop", crate::access::CAP_ALL);
        let fs = GrantFs::new(&fx.root, member("sam"), fx.drive_id.clone(), fx.db.clone());

        fs.rename(&davpath("docs/a.txt"), &davpath("drop/new.txt"))
            .await
            .unwrap();
        assert_eq!(std::fs::read(fx.root.join("drop/new.txt")).unwrap(), b"a");
        assert!(!fx.root.join("docs/a.txt").exists());
    }

    /// DELETE goes through `delete_to_trash`: the entry lands in the real
    /// `{prefix}-trash` dir with metadata, and grants on the path die.
    #[tokio::test]
    async fn grantfs_delete_routes_to_trash_and_revokes_grants() {
        let fx = fixture();
        std::fs::write(fx.root.join("gone.txt"), b"x").unwrap();
        grant(&fx, "sam", "gone.txt", crate::access::CAP_ALL);
        let fs = GrantFs::new(&fx.root, admin(), fx.drive_id.clone(), fx.db.clone());

        fs.remove_file(&davpath("gone.txt")).await.unwrap();

        // Removes are buffered into one trash entry per request; dropping
        // the per-request fs runs the actual move.
        drop(fs);
        assert!(!fx.root.join("gone.txt").exists());
        let prefix = crate::drives::drive_db::prefix_for(&fx.root).unwrap();
        let trash = fx.root.join(format!("{prefix}-trash"));
        let entries: Vec<String> = std::fs::read_dir(&trash)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        let entry = entries
            .iter()
            .find(|n| n.ends_with("-gone.txt"))
            .expect("deleted file should land in trash");
        // Trash metadata records the origin under the API alias.
        let conn = fx.db.lock().unwrap();
        let origin =
            crate::files::trash_original_path(&conn, &fx.drive_id, &format!(".luna-trash/{entry}"))
                .unwrap();
        assert_eq!(origin.as_deref(), Some("gone.txt"));
        // "Trash is a revoke": the member grant on the deleted path is gone.
        assert!(
            crate::db::list_access_members_for_user(&conn, "sam")
                .unwrap()
                .is_empty()
        );
    }

    /// A DAV rename retargets member/link subject rows — a grant on the old
    /// path must follow the file instead of resurrecting onto the next
    /// occupant of the name.
    #[tokio::test]
    async fn grantfs_rename_repaths_member_grants() {
        let fx = fixture();
        std::fs::create_dir_all(fx.root.join("docs/sub")).unwrap();
        std::fs::write(fx.root.join("docs/sub/f.txt"), b"f").unwrap();
        grant(&fx, "sam", "docs", CAP_VIEW);
        grant(&fx, "sam", "docs/sub", CAP_VIEW);
        let fs = GrantFs::new(&fx.root, admin(), fx.drive_id.clone(), fx.db.clone());

        fs.rename(&davpath("docs"), &davpath("moved"))
            .await
            .unwrap();

        let mut paths = member_paths(&fx, "sam");
        paths.sort();
        assert_eq!(paths, vec!["moved".to_string(), "moved/sub".to_string()]);
    }

    /// `MKCOL .luna-trash` (at any depth) would create a real dir shadowing
    /// the API alias — refuse it, and refuse rename/copy into it too.
    #[tokio::test]
    async fn grantfs_rejects_trash_alias_paths() {
        let fx = fixture();
        std::fs::create_dir_all(fx.root.join("docs")).unwrap();
        std::fs::write(fx.root.join("docs/a.txt"), b"a").unwrap();
        let fs = GrantFs::new(&fx.root, admin(), fx.drive_id.clone(), fx.db.clone());

        assert_eq!(
            fs.create_dir(&davpath(".luna-trash")).await.unwrap_err(),
            FsError::Forbidden
        );
        assert_eq!(
            fs.create_dir(&davpath("docs/.luna-trash"))
                .await
                .unwrap_err(),
            FsError::Forbidden
        );
        assert!(
            fs.rename(&davpath("docs/a.txt"), &davpath(".luna-trash/a.txt"))
                .await
                .is_err()
        );
        assert!(
            fs.copy(&davpath("docs/a.txt"), &davpath("docs/.luna-trash"))
                .await
                .is_err()
        );
        assert!(fx.root.join("docs/a.txt").exists());
        assert!(!fx.root.join(".luna-trash").exists());
    }

    fn trash_entries(root: &Path) -> Vec<String> {
        let prefix = crate::drives::drive_db::prefix_for(root).unwrap();
        let trash = root.join(format!("{prefix}-trash"));
        match std::fs::read_dir(&trash) {
            Ok(read) => read
                .filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect(),
            Err(_) => Vec::new(),
        }
    }

    /// A recursive DELETE (children first, the directory last — the order
    /// dav-server's `delete_items` uses) must land as ONE trash entry for
    /// the requested path, not a scatter of per-child entries.
    #[tokio::test]
    async fn grantfs_delete_tree_lands_as_one_trash_entry() {
        let fx = fixture();
        std::fs::create_dir_all(fx.root.join("a/sub")).unwrap();
        std::fs::write(fx.root.join("a/f.txt"), b"f").unwrap();
        std::fs::write(fx.root.join("a/sub/g.txt"), b"g").unwrap();
        let fs = GrantFs::new(&fx.root, admin(), fx.drive_id.clone(), fx.db.clone());

        fs.remove_file(&davpath("a/sub/g.txt")).await.unwrap();
        fs.remove_file(&davpath("a/f.txt")).await.unwrap();
        fs.remove_dir(&davpath("a/sub")).await.unwrap();
        fs.remove_dir(&davpath("a")).await.unwrap();

        // Buffered until the per-request fs is torn down.
        assert!(fx.root.join("a").exists());
        drop(fs);

        assert!(!fx.root.join("a").exists());
        let entries = trash_entries(&fx.root);
        assert_eq!(entries.len(), 1, "one tree delete = one trash entry");
        assert!(
            entries[0].ends_with("-a"),
            "top-level dir trashed: {entries:?}"
        );
        // The whole subtree went with it.
        let trash = fx.root.join(format!(
            "{}-trash/{}",
            crate::drives::drive_db::prefix_for(&fx.root).unwrap(),
            entries[0]
        ));
        assert!(trash.join("sub/g.txt").exists());
        assert!(trash.join("f.txt").exists());
    }

    /// MOVE overwriting a visible destination: dav-server deletes the dest
    /// first (a buffered remove), then renames. The rename must flush the
    /// buffer — and the noreplace move must not clobber if it didn't.
    #[tokio::test]
    async fn grantfs_move_over_deleted_destination_works() {
        let fx = fixture();
        std::fs::create_dir_all(fx.root.join("docs")).unwrap();
        std::fs::create_dir_all(fx.root.join("drop")).unwrap();
        std::fs::write(fx.root.join("docs/a.txt"), b"a").unwrap();
        std::fs::write(fx.root.join("drop/existing.txt"), b"old").unwrap();
        grant(&fx, "sam", "docs", crate::access::CAP_ALL);
        grant(&fx, "sam", "drop", crate::access::CAP_ALL);
        let fs = GrantFs::new(&fx.root, member("sam"), fx.drive_id.clone(), fx.db.clone());

        fs.remove_file(&davpath("drop/existing.txt")).await.unwrap();
        fs.rename(&davpath("docs/a.txt"), &davpath("drop/existing.txt"))
            .await
            .unwrap();

        assert_eq!(
            std::fs::read(fx.root.join("drop/existing.txt")).unwrap(),
            b"a"
        );
        let entries = trash_entries(&fx.root);
        assert_eq!(entries.len(), 1);
        assert!(entries[0].ends_with("-existing.txt"));
    }

    /// An upload-only member can PUT a new name, but a second PUT onto the
    /// now-existing file is an edit, and a create_new open on an existing
    /// file fails atomically — never a silent clobber.
    #[tokio::test]
    async fn grantfs_upload_only_member_cannot_overwrite() {
        let fx = fixture();
        std::fs::create_dir_all(fx.root.join("drop")).unwrap();
        grant(&fx, "sam", "drop", CAP_UPLOAD);
        let fs = GrantFs::new(&fx.root, member("sam"), fx.drive_id.clone(), fx.db.clone());

        let create_put = || OpenOptions {
            write: true,
            create: true,
            truncate: true,
            ..Default::default()
        };
        fs.open(&davpath("drop/new.txt"), create_put())
            .await
            .unwrap();
        assert_eq!(std::fs::read(fx.root.join("drop/new.txt")).unwrap(), b"");

        // Exists now: rewriting needs CAP_EDIT, which an upload grant lacks.
        assert_eq!(
            fs.open(&davpath("drop/new.txt"), create_put())
                .await
                .unwrap_err(),
            FsError::Forbidden
        );
        // Exclusive create on an existing file fails instead of truncating.
        assert_eq!(
            fs.open(
                &davpath("drop/new.txt"),
                OpenOptions {
                    write: true,
                    create_new: true,
                    ..Default::default()
                }
            )
            .await
            .unwrap_err(),
            FsError::Exists
        );
    }

    /// The raw jailed fs never clobbers either: rename and copy onto an
    /// existing destination fail instead of replacing it.
    #[tokio::test]
    async fn jailedfs_rename_and_copy_never_clobber() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("a.txt"), b"a").unwrap();
        std::fs::write(root.path().join("b.txt"), b"b").unwrap();
        let fs = JailedFs::new(root.path());

        assert_eq!(
            fs.rename(&davpath("a.txt"), &davpath("b.txt"))
                .await
                .unwrap_err(),
            FsError::Exists
        );
        assert_eq!(
            fs.copy(&davpath("a.txt"), &davpath("b.txt"))
                .await
                .unwrap_err(),
            FsError::Exists
        );
        assert_eq!(std::fs::read(root.path().join("b.txt")).unwrap(), b"b");
        assert!(root.path().join("a.txt").exists());
    }

    /// A member with a deep grant can PROPFIND ancestor dirs to reach it,
    /// but those waypoints must not leak real sizes/mtimes — that would be
    /// an activity-timing oracle inside folders they cannot see.
    #[tokio::test]
    async fn grantfs_waypoint_ancestor_metadata_is_masked() {
        let fx = fixture();
        std::fs::create_dir_all(fx.root.join("family/photos")).unwrap();
        std::fs::write(fx.root.join("family/photos/a.txt"), b"a").unwrap();
        grant(&fx, "sam", "family/photos", CAP_VIEW);
        let fs = GrantFs::new(&fx.root, member("sam"), fx.drive_id.clone(), fx.db.clone());

        // The waypoint ancestor: dir type stays real, everything else masked.
        let meta = fs.symlink_metadata(&davpath("family")).await.unwrap();
        assert!(meta.is_dir());
        assert_eq!(meta.len(), 0);
        assert_eq!(meta.modified().unwrap(), SystemTime::UNIX_EPOCH);

        // The granted path reports real metadata.
        let real = std::fs::symlink_metadata(fx.root.join("family/photos")).unwrap();
        let meta = fs
            .symlink_metadata(&davpath("family/photos"))
            .await
            .unwrap();
        assert!(meta.is_dir());
        assert_eq!(meta.modified().unwrap(), real.modified().unwrap());

        // PROPFIND-style listing: `family` shows up in the root listing but
        // with masked entry metadata.
        use futures_util::StreamExt;
        let mut stream = fs
            .read_dir(&davpath(""), ReadDirMeta::DataSymlink)
            .await
            .unwrap();
        let mut found = false;
        while let Some(item) = stream.next().await {
            let ent = item.unwrap();
            if ent.name() == b"family" {
                found = true;
                let m = ent.metadata().await.unwrap();
                assert!(m.is_dir());
                assert_eq!(m.len(), 0);
                assert_eq!(m.modified().unwrap(), SystemTime::UNIX_EPOCH);
            }
        }
        assert!(found, "waypoint ancestor must still be listed");

        // Admins (and the grant inside it) see real metadata.
        let admin_fs = GrantFs::new(&fx.root, admin(), fx.drive_id.clone(), fx.db.clone());
        let meta = admin_fs.symlink_metadata(&davpath("family")).await.unwrap();
        assert_eq!(
            meta.modified().unwrap(),
            std::fs::symlink_metadata(fx.root.join("family"))
                .unwrap()
                .modified()
                .unwrap()
        );
    }
}

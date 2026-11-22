//! The single erase. One function, one path, for every caller.
//!
//! The order is always:
//!
//! 1. check everything that can be checked **before** touching the drive
//!    (tools installed, same physical disk, not the system disk);
//! 2. quiesce a registered drive (refuse open documents and running copies,
//!    hold backup run slots, flush the RAM cache, stop indexers, unmount, close
//!    any open LUKS mapping), and unmount every other mount on the disk;
//! 3. re-verify the disk, and for a no-wait preview that it is still empty;
//! 4. `wipefs` each partition and the disk, one GPT partition across the whole
//!    disk, then either `mkfs.exfat` or LUKS2 (password on stdin) + `mkfs.ext4`;
//! 5. mount the exact new partition (or mapper), write and verify a fresh
//!    `.luna-*` marker, copy the cloud recovery files onto it, and register the
//!    drive in one transaction.
//!
//! **The marker is the commit point.** A format interrupted anywhere leaves no
//! valid marker, so after a restart the drive simply shows as needing setup and
//! leads back into the flow. Destructive work never resumes on its own.
//!
//! **Only this module may call the destructive tools** (see [`super::tools`]).
//! Nothing here decides whether an erase is *allowed*: previews, the 30 second
//! wait and the Admin check belong to the caller.

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::Context;
use luna_core::marker::{self, Marker};
use rusqlite::{Connection, params};
use zeroize::Zeroizing;

use super::inspect::DiskIdentity;
use super::tools::{
    DiskTools, EXFAT_LABEL_MAX, EXT4_LABEL_MAX, PartitionKind, ToolError, volume_label,
};
use super::{FormattingDriveGuard, Phase};
use crate::drives::crypt::luks::{Luks, mapper_path, pbkdf_kib_from};
use crate::drives::{DriveManager, drive_db};
use crate::{AppState, db};

#[derive(Debug, thiserror::Error)]
pub enum FormatError {
    #[error(
        "Something is still using this drive, so Luna can't erase it. Close whatever has it open, then try again."
    )]
    Busy,
    #[error(
        "This drive stopped responding, so Luna couldn't erase it. Unplug it, plug it back in, and try again."
    )]
    Unresponsive,
    #[error("Luna can't prepare drives. This Luna is missing a program it needs ({0}).")]
    MissingTool(String),
    #[error("This isn't the drive that was shown. Look at the drive again.")]
    DriveChanged,
    #[error(
        "Files appeared on this drive since the preview. Look at the drive again before erasing it."
    )]
    NoLongerEmpty,
    #[error(
        "This is a test drive made from a folder. A folder can't be protected with a password."
    )]
    MockEncryption,
    #[error("{0}")]
    Other(String),
}

impl From<ToolError> for FormatError {
    fn from(e: ToolError) -> Self {
        match e {
            ToolError::Missing(tool) => FormatError::MissingTool(tool.to_string()),
            ToolError::TimedOut(_) => FormatError::Unresponsive,
            ToolError::WrongPassword => FormatError::Other(ToolError::WrongPassword.to_string()),
            ToolError::Failed(message) => FormatError::Other(message),
        }
    }
}

/// Anything unplanned (database, file or marker errors) goes to the log; the
/// person gets one plain sentence, never raw error text.
impl From<anyhow::Error> for FormatError {
    fn from(e: anyhow::Error) -> Self {
        tracing::warn!(error = %format!("{e:#}"), "drive erase hit an unexpected error");
        FormatError::Other(
            "Luna ran into a problem with this drive. Unplug it, plug it back in, and try again."
                .into(),
        )
    }
}

/// A failed run, and whether anything was written to the drive before it failed.
#[derive(Debug)]
pub struct Failure {
    pub error: FormatError,
    /// Destructive work had started: the old contents may be gone.
    pub erased: bool,
}

/// What a finished erase made.
#[derive(Debug)]
pub struct Outcome {
    pub drive: db::DriveRow,
    pub encrypted: bool,
}

/// What to erase, and what to make of it.
pub struct Request {
    /// The disk as previewed. The run refuses if the disk on the bench differs.
    pub identity: DiskIdentity,
    /// The drive's name in Luna. Its filesystem label is a cleaned copy.
    pub label: String,
    /// Present means LUKS2 + ext4; absent means exFAT.
    pub password: Option<Zeroizing<String>>,
    /// Reformatting a registered drive keeps its id, its name and whole-drive
    /// member access.
    pub drive_id: Option<String>,
    /// The preview said "empty" (no wait), so it must still be.
    pub require_empty: bool,
}

/// Ways the run looks at the world. Parameters so a test can fake them.
pub struct Hooks<'a> {
    /// The disk as it is now. `true` reads the partitions and what is on them;
    /// `false` reads only who the disk is. `None` when it can't be found.
    pub identity: &'a dyn Fn(bool) -> Option<DiskIdentity>,
    /// Is the disk still verifiably empty? (Re-inspection after unmounting.)
    pub still_empty: &'a dyn Fn() -> bool,
    /// Every mount point any partition of the disk has right now.
    pub mounts: &'a dyn Fn() -> Vec<PathBuf>,
}

pub struct Pacing {
    /// How long to wait between tries while an unmount reports "busy".
    pub busy_retry: Duration,
    /// How long each simulated step of a mock drive's run takes.
    pub mock_step: Duration,
}

impl Default for Pacing {
    fn default() -> Self {
        Pacing {
            busy_retry: Duration::from_millis(500),
            mock_step: Duration::from_millis(700),
        }
    }
}

pub struct Ctx<'a> {
    pub state: &'a AppState,
    pub tools: &'a dyn DiskTools,
    /// The one `cryptsetup` wrapper. Only this module may call `luks_format`.
    pub luks: &'a dyn Luks,
    pub hooks: Hooks<'a>,
    pub progress: &'a dyn Fn(Phase),
    pub sys_block: &'a Path,
    pub pacing: Pacing,
}

/// The programs a run needs, checked before anything is written.
pub fn required_tools(encrypted: bool) -> &'static [&'static str] {
    if encrypted {
        &["wipefs", "sfdisk", "blockdev", "cryptsetup", "mkfs.ext4"]
    } else {
        &["wipefs", "sfdisk", "blockdev", "mkfs.exfat"]
    }
}

/// Erase and set up the drive. Blocking and destructive: call it from a worker
/// thread, holding the disk lock, and only after the caller has decided the
/// erase is allowed.
pub fn run(ctx: &Ctx, req: &Request) -> Result<Outcome, Failure> {
    let encrypted = req.password.is_some();
    // Nothing below may start before these checks: they unmount and erase nothing.
    if req.identity.mock && encrypted {
        return Err(Failure {
            error: FormatError::MockEncryption,
            erased: false,
        });
    }
    (ctx.progress)(Phase::Preparing);
    if !req.identity.mock
        && let Some(tool) = ctx.tools.missing(required_tools(encrypted))
    {
        return Err(Failure {
            error: FormatError::MissingTool(tool.to_string()),
            erased: false,
        });
    }

    let id = req
        .drive_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let manager = &ctx.state.drive_manager;
    // From here, background scans leave the disk and the drive alone, and files
    // code refuses the drive instead of writing into its empty mount folder.
    let _disk = manager.begin_formatting_device(&req.identity.name);
    let _closing = req.drive_id.as_deref().map(|d| manager.begin_closing(d));
    let _gate = FormattingDriveGuard::new(&id);

    let mut stage = Stage::new(req.drive_id.as_deref());
    let mut erased = false;
    match run_inner(ctx, req, &id, &mut stage, &mut erased) {
        Ok(outcome) => Ok(outcome),
        Err(error) => {
            if !erased {
                // Nothing was written: put the drive back as it was.
                stage.restore(ctx.state);
            } else {
                stage.leave_closed();
            }
            Err(Failure { error, erased })
        }
    }
}

/// What the run has done to a registered drive, so a failure before the first
/// write can undo it.
struct Stage {
    id: Option<String>,
    previous: Option<db::DriveRow>,
    quiesced: Option<Quiesced>,
}

impl Stage {
    fn new(id: Option<&str>) -> Self {
        Stage {
            id: id.map(str::to_string),
            previous: None,
            quiesced: None,
        }
    }

    /// Before the first write: the drive is as it was, its marker intact. Give
    /// it back its state and let reconcile mount it again, and let the
    /// indexers watch it if it is still mounted.
    fn restore(&mut self, state: &AppState) {
        let (Some(id), Some(prev)) = (self.id.as_deref(), self.previous.as_ref()) else {
            return;
        };
        if let Ok(conn) = state.db.lock() {
            let _ = db::set_drive_state(&conn, id, &prev.state);
        }
        if !prev.mount_point.is_empty() && state.drive_manager.mount_is_live(&prev.mount_point) {
            let root = PathBuf::from(&prev.mount_point);
            state.search_index.watch_mount(id, root.clone());
            state.photos.watch_mount(id, root);
        }
        self.quiesced = None;
    }

    /// After a write: the old contents may be gone. The row stays `ejected`
    /// (no files code touches it) and the drive leads back into the flow.
    fn leave_closed(&mut self) {
        self.quiesced = None;
    }
}

fn run_inner(
    ctx: &Ctx,
    req: &Request,
    id: &str,
    stage: &mut Stage,
    erased: &mut bool,
) -> Result<Outcome, FormatError> {
    let state = ctx.state;
    let manager = &state.drive_manager;
    let disk = req.identity.name.as_str();
    let encrypted = req.password.is_some();

    // The disk on the bench must be the one that was previewed.
    let current = (ctx.hooks.identity)(true).ok_or(FormatError::DriveChanged)?;
    if !current.same_disk(&req.identity) {
        return Err(FormatError::DriveChanged);
    }
    if !req.identity.mock {
        // Defense in depth: never the live OS disk, even if detection missed it.
        if (ctx.hooks.mounts)()
            .iter()
            .any(|p| manager.is_system_mount(p))
        {
            return Err(FormatError::Other(
                "That's the system disk Luna runs from. Luna won't erase it.".into(),
            ));
        }
    }

    (ctx.progress)(Phase::Releasing);
    if let Some(drive_id) = req.drive_id.as_deref() {
        let (quiesced, drive) = quiesce(state, drive_id, &ctx.pacing, Purpose::Erase)?;
        stage.previous = Some(drive);
        stage.quiesced = Some(quiesced);
        // No files code touches the drive from here: its mount folder is about
        // to be an empty folder on the system disk.
        let conn = state
            .db
            .lock()
            .map_err(|_| FormatError::Other("Luna couldn't read its drive settings.".into()))?;
        db::set_drive_state(&conn, drive_id, "ejected")?;
    }
    if !req.identity.mock {
        unmount_disk(manager, &ctx.hooks, &ctx.pacing)?;
        // A mapping Luna left open would hold the partition and block the new table.
        if req.drive_id.is_some() {
            ctx.luks.close(id)?;
        }
        if ctx.luks.is_open(id) || has_holders(ctx.sys_block, disk) {
            return Err(FormatError::Busy);
        }
    }
    // Cached saves must never reach the new filesystem.
    state.ram_cache.drop_drive(id);

    // The last look before the first write.
    let current = (ctx.hooks.identity)(true).ok_or(FormatError::DriveChanged)?;
    if !current.same_disk(&req.identity) {
        return Err(FormatError::DriveChanged);
    }
    if req.require_empty && !(ctx.hooks.still_empty)() {
        return Err(FormatError::NoLongerEmpty);
    }

    if req.identity.mock {
        return run_mock(ctx, req, id, erased);
    }

    // ---- From here on, the old contents are going away. ----
    (ctx.progress)(Phase::Erasing);
    let attached = || -> Result<(), FormatError> {
        match (ctx.hooks.identity)(false) {
            Some(now) if now.same_attachment(&req.identity) => Ok(()),
            _ => Err(FormatError::DriveChanged),
        }
    };
    // Each partition's own signature first, then the disk's table: the
    // filesystems inside would otherwise outlive the table that pointed at them.
    for part in req.identity.layout.iter().rev() {
        ctx.tools.erase_signatures(&format!("/dev/{}", part.name))?;
        // The first successful wipe is the point of no return. A failure on
        // the first call has written nothing, so the drive can be put back.
        *erased = true;
    }
    ctx.tools.erase_signatures(&format!("/dev/{disk}"))?;
    *erased = true;
    attached()?;

    (ctx.progress)(Phase::Partitioning);
    let kind = if encrypted {
        PartitionKind::Luks
    } else {
        PartitionKind::Exfat
    };
    let partition = ctx.tools.write_partition_table(disk, kind)?;
    let part_dev = format!("/dev/{partition}");
    attached()?;
    // The new partition may start where an old filesystem's signature sits.
    ctx.tools.erase_signatures(&part_dev)?;

    let label = volume_label(
        &req.label,
        if encrypted {
            EXT4_LABEL_MAX
        } else {
            EXFAT_LABEL_MAX
        },
    );
    let (source, fs) = if let Some(password) = &req.password {
        (ctx.progress)(Phase::Encrypting);
        // Memory follows this box's RAM, and is recorded in the header.
        let kib = pbkdf_kib_from(crate::budget::meminfo().total_bytes);
        ctx.luks.luks_format(&part_dev, &label, password, kib)?;
        attached()?;
        // Open straight as the drive's own mapper: the result stays unlocked.
        ctx.luks.open(&part_dev, id, password)?;
        (mapper_path(id).to_string_lossy().into_owned(), "ext4")
    } else {
        (part_dev.clone(), "exfat")
    };

    let made = (|| -> Result<Outcome, FormatError> {
        (ctx.progress)(Phase::Formatting);
        if encrypted {
            ctx.tools.make_ext4(&source, &label)?;
        } else {
            ctx.tools.make_exfat(&source, &label)?;
        }
        attached()?;

        (ctx.progress)(Phase::Registering);
        let target = manager.adopted_mount_point(id);
        let registered = register_real(ctx, req, id, &source, fs, &target);
        if registered.is_err() {
            // Back out the mount (and the key in the kernel) so nothing is left open.
            let _ = manager.mounter().unmount(&target);
            let _ = std::fs::remove_dir(&target);
        }
        let drive = registered?;
        Ok(Outcome { drive, encrypted })
    })();
    if made.is_err() && encrypted {
        let _ = ctx.luks.close(id);
    }
    made
}

/// Mount the exact new partition (or mapper), then make the drive official.
fn register_real(
    ctx: &Ctx,
    req: &Request,
    id: &str,
    source: &str,
    fs: &str,
    target: &Path,
) -> Result<db::DriveRow, FormatError> {
    let manager = &ctx.state.drive_manager;
    manager.forget_marker_memo();
    if manager.mounter().is_mounted(target) {
        return Err(FormatError::Other(
            "This drive is still mounted. Luna couldn't finish setting it up.".into(),
        ));
    }
    std::fs::create_dir_all(target).map_err(anyhow::Error::from)?;
    manager
        .mounter()
        .mount_typed(source, target, false, Some(fs))
        .map_err(|e| {
            if crate::drives::mount::is_unresponsive(&e) {
                FormatError::Unresponsive
            } else {
                tracing::warn!(error = %e, "could not mount the newly made drive");
                FormatError::Other(
                    "Luna couldn't open the new drive. Unplug it, plug it back in, and try again."
                        .into(),
                )
            }
        })?;
    if !manager.mounter().is_mounted(target) {
        return Err(FormatError::Other(
            "Luna couldn't open the new drive. Unplug it, plug it back in, and try again.".into(),
        ));
    }
    commit(ctx, req, id, target, fs).map_err(FormatError::from)
}

/// Write the marker (the commit point), verify it, and register. `target` is
/// the mounted root of the new filesystem.
fn commit(
    ctx: &Ctx,
    req: &Request,
    id: &str,
    target: &Path,
    fs: &str,
) -> anyhow::Result<db::DriveRow> {
    let state = ctx.state;
    let prefix = marker::pick_prefix(target)?;
    let identity = Marker::new(id, req.label.as_str());
    drop(drive_db::create(target, &identity, &prefix)?);
    // From this line on the drive has a valid marker.
    let remove_marker = || {
        let _ = marker::remove_marker(target, id);
    };
    let finish = || -> anyhow::Result<db::DriveRow> {
        if !marker::read_markers(target)?
            .iter()
            .any(|(_, found)| *found == identity)
        {
            anyhow::bail!(
                "Luna couldn't verify this drive's name and identity after setting it up."
            );
        }
        crate::drives::sync_filesystem(target)
            .context("Luna couldn't finish writing to the new drive.")?;
        let conn = state
            .db
            .lock()
            .map_err(|_| anyhow::anyhow!("Luna couldn't read its drive settings."))?;
        let tx = conn.unchecked_transaction()?;
        if req.drive_id.is_some() {
            invalidate_formatted_contents(&tx, id)?;
        }
        db::upsert_drive(
            &tx,
            id,
            &req.label,
            "as_is",
            fs,
            &req.identity.name,
            &target.to_string_lossy(),
        )?;
        // Registered with its protection state, so no later reconcile can try
        // to mount a container, and a plain reformat clears an old flag. An
        // encrypted drive is left unlocked: the run just opened it.
        db::set_drive_encrypted(&tx, id, req.password.is_some())?;
        let row =
            db::get_drive(&tx, id)?.context("Luna couldn't read this drive's new settings.")?;
        tx.commit()?;
        Ok(row)
    };
    match finish() {
        Ok(row) => Ok(row),
        Err(e) => {
            // Never leave a drive with a valid marker and no registration.
            remove_marker();
            Err(e)
        }
    }
}

/// A dev mock drive: no disk tools, no mount. The "erase" empties the folder
/// (keeping its own config files) and the rest is the same commit.
fn run_mock(ctx: &Ctx, req: &Request, id: &str, erased: &mut bool) -> Result<Outcome, FormatError> {
    let step = ctx.pacing.mock_step;
    let pause = || {
        if !step.is_zero() {
            std::thread::sleep(step);
        }
    };
    let root = crate::dev_mock::scan_mock_drives()
        .into_iter()
        .find(|m| m.name == req.identity.name)
        .and_then(|m| m.mount_point)
        .ok_or_else(|| FormatError::Other("The mock drive is disconnected.".into()))?;
    let root = std::fs::canonicalize(root).map_err(anyhow::Error::from)?;
    let parent =
        std::fs::canonicalize(crate::dev_mock::mock_drives_path()).map_err(anyhow::Error::from)?;

    (ctx.progress)(Phase::Erasing);
    pause();
    *erased = true;
    empty_mock_folder(&root, &parent)?;
    (ctx.progress)(Phase::Partitioning);
    pause();
    (ctx.progress)(Phase::Formatting);
    pause();
    (ctx.progress)(Phase::Registering);
    pause();
    let drive = commit(ctx, req, id, &root, "exfat").map_err(FormatError::from)?;
    Ok(Outcome {
        drive,
        encrypted: false,
    })
}

/// The "erase" of a dev mock drive: empty its folder, keeping the folder's
/// own config files. Refuses anything that is not directly inside `parent`.
fn empty_mock_folder(root: &Path, parent: &Path) -> Result<(), FormatError> {
    if root.parent() != Some(parent) {
        return Err(FormatError::Other(
            "The mock drive is outside its storage folder.".into(),
        ));
    }
    for entry in std::fs::read_dir(root).map_err(anyhow::Error::from)? {
        let entry = entry.map_err(anyhow::Error::from)?;
        let name = entry.file_name();
        if [".drive.json", ".unplugged", ".readonly"]
            .iter()
            .any(|keep| name == *keep)
        {
            continue;
        }
        let path = entry.path();
        if entry.file_type().map_err(anyhow::Error::from)?.is_dir() {
            std::fs::remove_dir_all(&path).map_err(anyhow::Error::from)?;
        } else {
            std::fs::remove_file(&path).map_err(anyhow::Error::from)?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Quiesce, unmount

/// Holds backup exclusions and the RAM cache's closing state through the erase.
pub struct Quiesced {
    state: AppState,
    id: String,
    _backups: Vec<crate::backup::drive_backup::RunSlot>,
    _cloud: Vec<crate::backup::cloud::run::RunSlot>,
}

impl Drop for Quiesced {
    fn drop(&mut self) {
        self.state.ram_cache.end_close(&self.id);
    }
}

fn registered_mount_live(state: &AppState, drive: &db::DriveRow) -> bool {
    if drive.mount_point.is_empty() {
        return false;
    }
    state
        .drive_manager
        .mounter()
        .is_mounted(Path::new(&drive.mount_point))
        || crate::dev_mock::scan_mock_drives().iter().any(|mock| {
            mock.name == drive.device
                && mock.mount_point.as_deref() == Some(drive.mount_point.as_str())
        })
}

/// Why a drive is being taken out of use. Only changes the words of a refusal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Purpose {
    Erase,
    Lock,
}

impl Purpose {
    /// The end of "...then try ___ again."
    fn trying(self) -> &'static str {
        match self {
            Purpose::Erase => "erasing it",
            Purpose::Lock => "locking it",
        }
    }
}

/// Refuse active work, flush pending saves, stop indexing, then unmount the
/// registered drive. Returns the drive as it was, for undoing a failure that
/// happens before the first write. Used by the erase and by locking a drive.
pub fn quiesce(
    state: &AppState,
    id: &str,
    pacing: &Pacing,
    purpose: Purpose,
) -> Result<(Quiesced, db::DriveRow), FormatError> {
    let other = |msg: &str| FormatError::Other(msg.to_string());
    let trying = purpose.trying();
    if state.collab.drive_is_active(id) || state.office_docs.drive_is_active(id) {
        return Err(FormatError::Other(format!(
            "Close documents open from this drive, then try {trying} again."
        )));
    }
    let (drive, protections) = {
        let conn = state
            .db
            .lock()
            .map_err(|_| other("Luna couldn't read its drive settings."))?;
        let drive =
            db::get_drive(&conn, id)?.ok_or_else(|| other("Luna doesn't know this drive."))?;
        if !drive.mount_point.is_empty()
            && state
                .drive_manager
                .is_system_mount(Path::new(&drive.mount_point))
        {
            return Err(FormatError::Other(format!(
                "That's the system disk Luna runs from, so Luna can't {} it.",
                match purpose {
                    Purpose::Erase => "erase",
                    Purpose::Lock => "lock",
                }
            )));
        }
        let working: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM jobs WHERE state IN ('running', 'queued') \
                 AND (from_drive = ?1 OR to_drive = ?1)",
                [id],
                |row| row.get(0),
            )
            .map_err(anyhow::Error::from)?;
        if working != 0 {
            return Err(FormatError::Other(format!(
                "Wait for copies and moves using this drive to finish, then try {trying} again."
            )));
        }
        let protections = db::list_protections(&conn)?
            .into_iter()
            .filter(|row| row.source_drive == id || row.target_drive == id)
            .collect::<Vec<_>>();
        (drive, protections)
    };
    let mut backups = Vec::new();
    let mut cloud = Vec::new();
    for protection in protections {
        backups.push(
            crate::backup::drive_backup::try_hold(&state.db, &protection.id).ok_or_else(|| {
                FormatError::Other(format!(
                    "Wait for backups using this drive to finish, then try {trying} again."
                ))
            })?,
        );
        cloud.push(
            crate::backup::cloud::run::RunSlot::take(&state.db, &protection.id).ok_or_else(|| {
                FormatError::Other(format!(
                    "Wait for cloud backups using this drive to finish, then try {trying} again."
                ))
            })?,
        );
    }
    state.ram_cache.begin_close(id);
    let guard = Quiesced {
        state: state.clone(),
        id: id.to_string(),
        _backups: backups,
        _cloud: cloud,
    };
    if !state.ram_cache.dirty_rels_for_drive(id).is_empty() && !registered_mount_live(state, &drive)
    {
        return Err(FormatError::Other(match purpose {
            Purpose::Erase => "Luna still has unsaved files for this drive. Reconnect it and let those saves finish before erasing it.".to_string(),
            Purpose::Lock => "Luna still has unsaved files for this drive. Reconnect it and let those saves finish before locking it.".to_string(),
        }));
    }
    if !drive.mount_point.is_empty() {
        state
            .ram_cache
            .flush_drive_dirty(id, Path::new(&drive.mount_point))
            .map_err(|_| {
                other(
                    "Luna couldn't finish saving files on this drive. Wait a moment and try again.",
                )
            })?;
        crate::private::forget(Path::new(&drive.mount_point));
    }
    state.search_index.unwatch_mount(id);
    state.photos.unwatch_mount(id);
    if !drive.mount_point.is_empty() {
        let target = Path::new(&drive.mount_point);
        if state.drive_manager.mounter().is_mounted(target) {
            unmount_with_retry(&state.drive_manager, target, pacing).map_err(|e| {
                if crate::drives::mount::is_unresponsive(&e) {
                    FormatError::Unresponsive
                } else if crate::drives::mount::is_busy(&e) {
                    FormatError::Busy
                } else {
                    match purpose {
                        Purpose::Erase => {
                            other("Luna couldn't close this drive. Nothing has been erased.")
                        }
                        Purpose::Lock => other("Luna couldn't close this drive. Try again."),
                    }
                }
            })?;
        }
    }
    Ok((guard, drive))
}

/// Luna's own photo and search scans keep folders open while they run, which
/// makes an unmount fail as "busy" for a moment. Try again before blaming the
/// person.
pub(crate) fn unmount_with_retry(
    manager: &DriveManager,
    target: &Path,
    pacing: &Pacing,
) -> anyhow::Result<()> {
    let mut result = manager.mounter().unmount(target);
    for _ in 0..30 {
        match &result {
            Err(e) if crate::drives::mount::is_busy(e) => {
                if !pacing.busy_retry.is_zero() {
                    std::thread::sleep(pacing.busy_retry);
                }
                result = manager.mounter().unmount(target);
            }
            _ => break,
        }
    }
    result
}

/// Unmount everything on the disk, then refuse if anything is still mounted.
/// Repartitioning under a live mount can corrupt the running system, not just
/// the stick, so a busy disk stops the erase rather than being ignored.
fn unmount_disk(manager: &DriveManager, hooks: &Hooks, pacing: &Pacing) -> Result<(), FormatError> {
    let mut points = (hooks.mounts)();
    // Deepest first: a nested mount has to go before its parent.
    points.sort_by_key(|p| std::cmp::Reverse(p.as_os_str().len()));
    let mut first_failure: Option<anyhow::Error> = None;
    for point in &points {
        if manager.is_system_mount(point) {
            return Err(FormatError::Other(
                "That's the system disk Luna runs from. Luna won't erase it.".into(),
            ));
        }
        if let Err(e) = unmount_with_retry(manager, point, pacing)
            && first_failure.is_none()
        {
            first_failure = Some(e);
        }
    }
    if !(hooks.mounts)().is_empty() {
        // A stick that stopped answering is not the same problem as one with
        // files open, and the person can do nothing about the first.
        if first_failure
            .as_ref()
            .is_some_and(crate::drives::mount::is_unresponsive)
        {
            return Err(FormatError::Unresponsive);
        }
        return Err(FormatError::Busy);
    }
    Ok(())
}

/// Does anything (a LUKS mapping, RAID, LVM) still sit on a partition of `disk`?
fn has_holders(sys_block: &Path, disk: &str) -> bool {
    let Ok(entries) = std::fs::read_dir(sys_block.join(disk)) else {
        return false;
    };
    entries.flatten().any(|e| {
        let name = e.file_name().to_string_lossy().into_owned();
        crate::drives::detect::is_partition_of(disk, &name)
            && std::fs::read_dir(e.path().join("holders")).is_ok_and(|mut h| h.next().is_some())
    })
}

/// A format starts a new content generation. Keep explicit whole-drive member
/// access, revoke file/folder and album grants, revoke all public links, and
/// stop backup rules without deleting cloud snapshots or copies on other drives.
pub fn invalidate_formatted_contents(conn: &Connection, id: &str) -> anyhow::Result<()> {
    conn.execute(
        "DELETE FROM access_members WHERE drive_id = ?1 \
         AND NOT (subject_kind = 'path' AND path = '' AND album_id = '')",
        [id],
    )?;
    conn.execute("DELETE FROM access_links WHERE drive_id = ?1", [id])?;
    conn.execute(
        "UPDATE protections SET state = 'stopped', stop_reason = ?2, \
         last_error = ?2 WHERE source_drive = ?1 OR target_drive = ?1",
        params![
            id,
            "This drive was erased. Set up this backup again before copying new files."
        ],
    )?;
    conn.execute(
        "UPDATE protections SET last_ok_at = 0, first_done = 0 \
         WHERE kind = 'drive' AND target_drive = ?1",
        [id],
    )?;
    // Recents live in a table created on first use.
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'user_recents')",
        [],
        |row| row.get(0),
    )?;
    if exists {
        conn.execute("DELETE FROM user_recents WHERE drive_id = ?1", [id])?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::drives::crypt::luks::MockLuks;
    use crate::drives::format::inspect::PartitionLayout;
    use crate::drives::format::tools::MockTools;
    use std::sync::Mutex;

    fn part(name: &str) -> PartitionLayout {
        PartitionLayout {
            name: name.into(),
            start_sectors: 2048,
            size_bytes: 1 << 30,
            fs_type: "exfat".into(),
            label: String::new(),
        }
    }

    fn identity() -> DiskIdentity {
        DiskIdentity {
            name: "sdz".into(),
            model: "Stick".into(),
            size_bytes: 8 << 30,
            serial: Some("S1".into()),
            wwn: None,
            diskseq: Some(3),
            whole_fs_type: String::new(),
            layout: vec![part("sdz1"), part("sdz2")],
            mock: false,
        }
    }

    struct Fixture {
        dir: tempfile::TempDir,
        state: AppState,
        tools: MockTools,
        luks: MockLuks,
        mock: std::sync::Arc<crate::drives::mount::MockMounter>,
        phases: Mutex<Vec<Phase>>,
        sys: PathBuf,
        now: Mutex<Option<DiskIdentity>>,
        empty: Mutex<bool>,
        mounts: Mutex<Vec<PathBuf>>,
    }

    impl Fixture {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let conn = db::open(&dir.path().join("luna.db")).unwrap();
            let mock = crate::drives::mount::shared_mock();
            let manager = std::sync::Arc::new(DriveManager::new(mock.clone(), dir.path()));
            let state = AppState::new(conn, manager, dir.path());
            let sys = dir.path().join("sys");
            std::fs::create_dir_all(&sys).unwrap();
            Fixture {
                dir,
                state,
                tools: MockTools::default(),
                luks: MockLuks::default(),
                mock,
                phases: Mutex::new(Vec::new()),
                sys,
                now: Mutex::new(Some(identity())),
                empty: Mutex::new(true),
                mounts: Mutex::new(Vec::new()),
            }
        }

        fn run(&self, req: &Request) -> Result<Outcome, Failure> {
            let identity = |full: bool| -> Option<DiskIdentity> {
                let mut now = self.now.lock().unwrap().clone()?;
                if !full {
                    now.layout.clear();
                }
                Some(now)
            };
            let still_empty = || *self.empty.lock().unwrap();
            let mounts = || self.mounts.lock().unwrap().clone();
            let progress = |p: Phase| self.phases.lock().unwrap().push(p);
            let ctx = Ctx {
                state: &self.state,
                tools: &self.tools,
                luks: &self.luks,
                hooks: Hooks {
                    identity: &identity,
                    still_empty: &still_empty,
                    mounts: &mounts,
                },
                progress: &progress,
                sys_block: &self.sys,
                pacing: Pacing {
                    busy_retry: Duration::ZERO,
                    mock_step: Duration::ZERO,
                },
            };
            run(&ctx, req)
        }
    }

    fn request(password: Option<&str>) -> Request {
        Request {
            identity: identity(),
            label: "Family photos".into(),
            password: password.map(|p| Zeroizing::new(p.to_string())),
            drive_id: None,
            require_empty: false,
        }
    }

    /// Did any destructive tool run?
    fn wrote(fx: &Fixture) -> bool {
        fx.luks.count("luks_format") > 0
            || fx.tools.calls().iter().any(|c| {
                ["erase_", "write_", "make_"]
                    .iter()
                    .any(|m| c.starts_with(m))
            })
    }

    fn methods(tools: &MockTools) -> Vec<String> {
        tools
            .calls()
            .into_iter()
            .map(|c| c.split_whitespace().next().unwrap().to_string())
            .collect()
    }

    #[test]
    fn a_plain_erase_wipes_partitions_then_disk_then_makes_one_exfat_partition() {
        let fx = Fixture::new();
        let outcome = fx.run(&request(None)).unwrap();
        let calls = fx.tools.calls();
        // Partitions deepest first, then the disk, then the table, then the new partition.
        assert_eq!(
            calls,
            vec![
                "erase_signatures /dev/sdz2",
                "erase_signatures /dev/sdz1",
                "erase_signatures /dev/sdz",
                "write_partition_table /dev/sdz Exfat",
                "erase_signatures /dev/sdz1",
                "make_exfat /dev/sdz1 Family photos",
            ]
        );
        assert!(!outcome.encrypted);
        assert_eq!(outcome.drive.fs_type, "exfat");
        assert_eq!(outcome.drive.label, "Family photos");
        assert_eq!(outcome.drive.state, "as_is");
        // The marker is on the drive and matches the registered id.
        let root = PathBuf::from(&outcome.drive.mount_point);
        let found = marker::read_marker(&root).unwrap().unwrap();
        assert_eq!(found.id, outcome.drive.id);
        // It was mounted read-write at the exact new partition.
        let mounts = fx.mock.mounts.lock().unwrap().clone();
        assert_eq!(mounts.len(), 1);
        assert_eq!(mounts[0].0, "/dev/sdz1");
        assert!(!mounts[0].2, "the new drive is mounted read-write");
        assert!(fx.luks.open.lock().unwrap().is_empty());
        assert!(fx.luks.calls().is_empty());
        // Registered as a plain drive.
        let conn = fx.state.db.lock().unwrap();
        let row = db::get_drive(&conn, &outcome.drive.id).unwrap().unwrap();
        assert!(!row.encrypted && !row.locked);
    }

    #[test]
    fn the_phases_are_named_in_order() {
        let fx = Fixture::new();
        fx.run(&request(None)).unwrap();
        assert_eq!(
            fx.phases.lock().unwrap().clone(),
            vec![
                Phase::Preparing,
                Phase::Releasing,
                Phase::Erasing,
                Phase::Partitioning,
                Phase::Formatting,
                Phase::Registering,
            ]
        );
    }

    #[test]
    fn an_encrypted_erase_puts_ext4_inside_an_open_container_and_leaves_it_unlocked() {
        let fx = Fixture::new();
        let outcome = fx.run(&request(Some("hunter22hunter1"))).unwrap();
        let id = &outcome.drive.id;
        let calls = fx.tools.calls();
        let luks = fx.luks.calls();
        assert!(calls.contains(&"write_partition_table /dev/sdz Luks".to_string()));
        assert!(luks.contains(&"luks_format /dev/sdz1 Family photos".to_string()));
        assert!(luks.contains(&format!("open /dev/sdz1 {id}")));
        // ext4 goes on the mapper, not on the partition.
        let mapper = mapper_path(id).to_string_lossy().into_owned();
        assert!(
            calls.contains(&format!("make_ext4 {mapper} Family photos")),
            "{calls:?}"
        );
        assert!(!methods(&fx.tools).contains(&"make_exfat".to_string()));
        assert!(outcome.encrypted);
        assert_eq!(outcome.drive.fs_type, "ext4");
        // Left open: ready to use, nothing closed.
        assert!(fx.luks.is_open(id));
        // Registered as encrypted and unlocked, so reconcile never mounts it
        // and a reboot (not this run) is what locks it.
        {
            let conn = fx.state.db.lock().unwrap();
            let row = db::get_drive(&conn, id).unwrap().unwrap();
            assert!(row.encrypted && !row.locked);
        }
        // Argon2 memory is an eighth of RAM, clamped.
        let kib = fx.luks.pbkdf.lock().unwrap().unwrap();
        assert!((32 * 1024..=1024 * 1024).contains(&kib));
        // The mount is on the mapper.
        assert_eq!(fx.mock.mounts.lock().unwrap()[0].0, mapper);
    }

    #[test]
    fn a_missing_tool_stops_everything_before_any_write() {
        let fx = Fixture::new();
        fx.tools.absent.lock().unwrap().push("mkfs.exfat");
        let err = fx.run(&request(None)).unwrap_err();
        assert!(matches!(err.error, FormatError::MissingTool(ref t) if t == "mkfs.exfat"));
        assert!(!err.erased);
        // Not even a read happened, and there is no fallback filesystem.
        assert!(fx.tools.calls().is_empty());
        // The encrypted path has its own list.
        fx.tools.absent.lock().unwrap().clear();
        fx.tools.absent.lock().unwrap().push("cryptsetup");
        let err = fx.run(&request(Some("hunter22hunter1"))).unwrap_err();
        assert!(matches!(err.error, FormatError::MissingTool(ref t) if t == "cryptsetup"));
        assert!(fx.tools.calls().is_empty());
    }

    #[test]
    fn a_swapped_disk_is_refused_before_anything_is_written() {
        let fx = Fixture::new();
        fx.now.lock().unwrap().as_mut().unwrap().serial = Some("OTHER".into());
        let err = fx.run(&request(None)).unwrap_err();
        assert!(matches!(err.error, FormatError::DriveChanged));
        assert!(!err.erased);
        assert!(fx.tools.calls().is_empty());
        // And so is a disk whose partitions changed.
        let fx = Fixture::new();
        fx.now.lock().unwrap().as_mut().unwrap().layout.pop();
        assert!(matches!(
            fx.run(&request(None)).unwrap_err().error,
            FormatError::DriveChanged
        ));
    }

    #[test]
    fn a_no_wait_preview_must_still_be_empty() {
        let fx = Fixture::new();
        *fx.empty.lock().unwrap() = false;
        let mut req = request(None);
        req.require_empty = true;
        let err = fx.run(&req).unwrap_err();
        assert!(matches!(err.error, FormatError::NoLongerEmpty));
        assert!(!err.erased);
        assert!(!wrote(&fx));
        // A previewed-and-waited erase does not need the drive to be empty.
        req.require_empty = false;
        assert!(fx.run(&req).is_ok());
    }

    #[test]
    fn a_failure_midway_says_the_drive_may_be_erased_and_leaves_no_marker() {
        let fx = Fixture::new();
        *fx.tools.fail_at.lock().unwrap() = Some("make_exfat");
        let err = fx.run(&request(None)).unwrap_err();
        assert!(err.erased);
        assert!(fx.mock.mounts.lock().unwrap().is_empty());
        let rows = db::list_drives(&fx.state.db.lock().unwrap()).unwrap();
        assert!(rows.is_empty(), "nothing is registered");
    }

    #[test]
    fn a_failure_on_the_first_wipe_has_written_nothing_and_puts_the_drive_back() {
        let fx = Fixture::new();
        let mount = fx.state.drive_manager.adopted_mount_point("d-first-wipe");
        {
            let conn = fx.state.db.lock().unwrap();
            db::upsert_drive(
                &conn,
                "d-first-wipe",
                "Photos",
                "as_is",
                "ext4",
                "sdz",
                &mount.to_string_lossy(),
            )
            .unwrap();
        }
        *fx.tools.fail_at.lock().unwrap() = Some("erase_signatures");
        let mut req = request(None);
        req.drive_id = Some("d-first-wipe".into());
        let err = fx.run(&req).unwrap_err();
        assert!(!err.erased, "no wipe succeeded, so nothing was written");
        assert_eq!(
            fx.tools.calls(),
            vec!["erase_signatures /dev/sdz2"],
            "the run stops at the first failed call"
        );
        let conn = fx.state.db.lock().unwrap();
        assert_eq!(
            db::get_drive(&conn, "d-first-wipe").unwrap().unwrap().state,
            "as_is"
        );
    }

    #[test]
    fn an_encrypted_failure_closes_the_container() {
        let fx = Fixture::new();
        *fx.tools.fail_at.lock().unwrap() = Some("make_ext4");
        let err = fx.run(&request(Some("hunter22hunter1"))).unwrap_err();
        assert!(err.erased);
        assert!(
            fx.luks.open.lock().unwrap().is_empty(),
            "no key left in the kernel"
        );
    }

    #[test]
    fn a_failure_while_opening_the_new_drive_backs_out_the_mount() {
        let fx = Fixture::new();
        *fx.mock.fail_mount.lock().unwrap() = true;
        let err = fx.run(&request(None)).unwrap_err();
        assert!(err.erased);
        assert!(
            db::list_drives(&fx.state.db.lock().unwrap())
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn a_busy_disk_is_refused_before_it_is_written() {
        let fx = Fixture::new();
        // The disk keeps a mount no matter how often it is unmounted.
        let stuck = fx.dir.path().join("stuck");
        fx.mounts.lock().unwrap().push(stuck.clone());
        let err = fx.run(&request(None)).unwrap_err();
        assert!(matches!(err.error, FormatError::Busy));
        assert!(!err.erased);
        assert!(fx.tools.calls().is_empty());
    }

    #[test]
    fn a_partition_with_a_holder_is_refused() {
        let fx = Fixture::new();
        std::fs::create_dir_all(fx.sys.join("sdz/sdz1/holders/dm-0")).unwrap();
        let err = fx.run(&request(None)).unwrap_err();
        assert!(matches!(err.error, FormatError::Busy));
        assert!(!err.erased);
        assert!(fx.tools.calls().iter().all(|c| !c.starts_with("erase")));
    }

    #[test]
    fn reformatting_a_registered_drive_keeps_its_id_and_name_and_clears_fine_access() {
        let fx = Fixture::new();
        let mount = fx.state.drive_manager.adopted_mount_point("d-reformat");
        {
            let conn = fx.state.db.lock().unwrap();
            db::upsert_drive(
                &conn,
                "d-reformat",
                "Photos",
                "as_is",
                "ext4",
                "sdz",
                &mount.to_string_lossy(),
            )
            .unwrap();
            conn.execute(
                "INSERT INTO access_members (id, subject_kind, drive_id, path, album_id, user_id, caps, created_by, created_at) \
                 VALUES ('m1', 'path', 'd-reformat', '', '', 'u1', 1, '', 0), ('m2', 'path', 'd-reformat', 'Docs', '', 'u2', 1, '', 0)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO access_links (id, token_hash, token, subject_kind, drive_id, path, album_id, caps, created_by, created_at) \
                 VALUES ('l1', 'h', 't', 'path', 'd-reformat', '', '', 1, 'u', 0)",
                [],
            )
            .unwrap();
        }
        let mut req = request(None);
        req.drive_id = Some("d-reformat".into());
        let outcome = fx.run(&req).unwrap();
        assert_eq!(outcome.drive.id, "d-reformat");
        assert_eq!(outcome.drive.state, "as_is");
        let conn = fx.state.db.lock().unwrap();
        let members: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM access_members WHERE drive_id = 'd-reformat'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(members, 1, "whole-drive access stays; folder grants go");
        let links: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM access_links WHERE drive_id = 'd-reformat'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(links, 0);
    }

    #[test]
    fn a_registered_drive_is_put_back_when_the_run_fails_before_any_write() {
        let fx = Fixture::new();
        let mount = fx.state.drive_manager.adopted_mount_point("d-restore");
        {
            let conn = fx.state.db.lock().unwrap();
            db::upsert_drive(
                &conn,
                "d-restore",
                "Photos",
                "as_is",
                "ext4",
                "sdz",
                &mount.to_string_lossy(),
            )
            .unwrap();
        }
        // The disk is swapped after quiesce: refuse at the last look.
        let mut req = request(None);
        req.drive_id = Some("d-restore".into());
        req.require_empty = true;
        *fx.empty.lock().unwrap() = false;
        let err = fx.run(&req).unwrap_err();
        assert!(!err.erased);
        let conn = fx.state.db.lock().unwrap();
        assert_eq!(
            db::get_drive(&conn, "d-restore").unwrap().unwrap().state,
            "as_is"
        );
        assert!(!crate::drives::format::drive_is_formatting("d-restore"));
    }

    #[test]
    fn a_registered_drive_stays_closed_when_the_run_fails_after_a_write() {
        let fx = Fixture::new();
        {
            let conn = fx.state.db.lock().unwrap();
            db::upsert_drive(&conn, "d-closed", "Photos", "as_is", "ext4", "sdz", "").unwrap();
        }
        *fx.tools.fail_at.lock().unwrap() = Some("write_partition_table");
        let mut req = request(None);
        req.drive_id = Some("d-closed".into());
        let err = fx.run(&req).unwrap_err();
        assert!(err.erased);
        let conn = fx.state.db.lock().unwrap();
        assert_eq!(
            db::get_drive(&conn, "d-closed").unwrap().unwrap().state,
            "ejected"
        );
    }

    #[test]
    fn unexpected_errors_never_reach_the_person_raw() {
        let said =
            FormatError::from(anyhow::anyhow!("SQLITE_BUSY: database is locked")).to_string();
        assert!(!said.contains("SQLITE"), "{said}");
        assert!(said.contains("try again"));
    }

    #[test]
    fn a_mock_drive_refuses_encryption() {
        let fx = Fixture::new();
        let mut req = request(Some("hunter22hunter1"));
        req.identity.mock = true;
        let err = fx.run(&req).unwrap_err();
        assert!(matches!(err.error, FormatError::MockEncryption));
        assert!(fx.tools.calls().is_empty());
    }

    #[test]
    fn a_mock_drive_is_emptied_in_place_keeping_its_config_and_is_registered() {
        let fx = Fixture::new();
        let parent = fx.dir.path().join("mock-drives");
        let root = parent.join("usb-a");
        std::fs::create_dir_all(root.join("DCIM")).unwrap();
        std::fs::write(root.join("DCIM/a.jpg"), b"x").unwrap();
        std::fs::write(root.join("notes.txt"), b"x").unwrap();
        std::fs::write(root.join(".drive.json"), b"{}").unwrap();
        empty_mock_folder(&root, &parent).unwrap();
        let mut left: Vec<String> = std::fs::read_dir(&root)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(left, vec![".drive.json"]);

        // The same commit as a real drive, in place: marker, then registration.
        let mut req = request(None);
        req.identity.name = "sdmock_a".into();
        req.identity.mock = true;
        let ctx_state = &fx.state;
        let ctx = Ctx {
            state: ctx_state,
            tools: &fx.tools,
            luks: &fx.luks,
            hooks: Hooks {
                identity: &|_| None,
                still_empty: &|| true,
                mounts: &Vec::new,
            },
            progress: &|_| {},
            sys_block: &fx.sys,
            pacing: Pacing::default(),
        };
        let row = commit(&ctx, &req, "mock-id", &root, "exfat").unwrap();
        assert_eq!(row.id, "mock-id");
        assert_eq!(row.mount_point, root.to_string_lossy());
        assert_eq!(marker::read_marker(&root).unwrap().unwrap().id, "mock-id");
        // No disk tool was involved.
        assert!(fx.tools.calls().is_empty());
    }

    #[test]
    fn a_mock_folder_outside_the_mock_storage_is_never_emptied() {
        let dir = tempfile::tempdir().unwrap();
        let parent = dir.path().join("mock-drives");
        std::fs::create_dir_all(&parent).unwrap();
        let elsewhere = dir.path().join("precious");
        std::fs::create_dir_all(&elsewhere).unwrap();
        std::fs::write(elsewhere.join("keep.txt"), b"x").unwrap();
        assert!(empty_mock_folder(&elsewhere, &parent).is_err());
        assert!(elsewhere.join("keep.txt").exists());
        // Nor a folder deeper inside it.
        let deep = parent.join("a/b");
        std::fs::create_dir_all(&deep).unwrap();
        assert!(empty_mock_folder(&deep, &parent).is_err());
    }

    /// The destructive tools may be called from this module only.
    #[test]
    fn only_the_erase_calls_the_destructive_tools() {
        fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
            for entry in std::fs::read_dir(dir).unwrap().flatten() {
                let path = entry.path();
                if path.is_dir() {
                    walk(&path, out);
                } else if path.extension().is_some_and(|e| e == "rs") {
                    out.push(path);
                }
            }
        }
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut files = Vec::new();
        walk(&src, &mut files);
        let destructive = [
            ".erase_signatures(",
            ".write_partition_table(",
            ".make_exfat(",
            ".make_ext4(",
            ".luks_format(",
        ];
        for file in files {
            let rel = file
                .strip_prefix(&src)
                .unwrap()
                .to_string_lossy()
                .into_owned();
            // The erase itself, and the tools' own definitions and mocks
            // (`luks_format` is defined, and only defined, in `crypt/luks.rs`).
            if rel.ends_with("drives/format/run.rs")
                || rel.ends_with("drives/format/tools.rs")
                || rel.ends_with("drives/crypt/luks.rs")
            {
                continue;
            }
            let text = std::fs::read_to_string(&file).unwrap();
            for call in destructive {
                assert!(!text.contains(call), "{rel} calls {call}; only run.rs may");
            }
        }
    }
}

//! Erasing a drive and setting it up, the one way.
//!
//! There is exactly one operation that erases a drive ([`run::run`]); every
//! screen that needs one goes through the format API. See
//! `docs/drive-format/plan.md`.
//!
//! - [`inspect`]: read-only look at a physical disk and the **empty verdict**.
//! - [`tools`]: `wipefs`, `sfdisk`, `mkfs.*`, `cryptsetup` behind a trait.
//! - [`run`]: the erase itself. The only caller of the destructive tools.
//!
//! This file holds what the HTTP layer shares between requests, all **in
//! memory**: issued previews and the status of runs. A lunad restart drops
//! them; the person previews again. There are no plan or operation tables, and
//! a format interrupted at any step leaves no valid marker on the drive, so
//! nothing is ever resumed.

pub mod inspect;
pub mod run;
pub mod tools;

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use serde::Serialize;

use inspect::{DiskIdentity, Env, NoProbe, Preview};
use tools::{CommandTools, DiskTools};

use crate::AppState;
use crate::drives::DriveManager;
use crate::drives::detect::{self, DetectedDrive};

/// How long after a preview is issued the erase button stays locked, when the
/// drive is not verified empty. Counted on the server.
pub const WAIT_SECONDS: i64 = 30;
/// A preview stops being usable this long after it was issued.
pub const PREVIEW_TTL_SECONDS: i64 = 15 * 60;

const MAX_PREVIEWS: usize = 64;
/// Finished runs stay findable for this long (a refreshed browser asks again).
const FINISHED_RUN_KEEP_SECONDS: i64 = 60 * 60;
const MAX_FINISHED_RUNS: usize = 32;

/// The named steps of a run, in the order they happen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    /// Checking tools, the disk and who it is. Nothing is touched yet.
    Preparing,
    /// Letting go of the drive: pausing backups, saving, unmounting.
    Releasing,
    /// Wiping the old contents.
    Erasing,
    /// Writing the one new partition.
    Partitioning,
    /// Setting up the password (encrypted drives only).
    Encrypting,
    /// Writing the filesystem.
    Formatting,
    /// Mounting it, writing Luna's marker and adding it to Luna.
    Registering,
}

impl Phase {
    /// Every phase this run goes through, in order.
    pub fn sequence(encrypted: bool) -> Vec<Phase> {
        let mut all = vec![
            Phase::Preparing,
            Phase::Releasing,
            Phase::Erasing,
            Phase::Partitioning,
        ];
        if encrypted {
            all.push(Phase::Encrypting);
        }
        all.push(Phase::Formatting);
        all.push(Phase::Registering);
        all
    }
}

// ---------------------------------------------------------------------------
// Which drives are being erased right now

static FORMATTING_DRIVES: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Default::default);

/// Marks a drive id as being erased until dropped. File code refuses such a
/// drive: once it is unmounted its mount folder is an empty folder on the
/// system disk, and nothing may write there.
pub struct FormattingDriveGuard(String);

impl FormattingDriveGuard {
    pub fn new(id: &str) -> Self {
        FORMATTING_DRIVES
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id.to_string());
        FormattingDriveGuard(id.to_string())
    }
}

impl Drop for FormattingDriveGuard {
    fn drop(&mut self) {
        FORMATTING_DRIVES
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.0);
    }
}

pub fn drive_is_formatting(id: &str) -> bool {
    FORMATTING_DRIVES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .contains(id)
}

/// Is `name` a dev mock drive (a folder standing in for a disk)? Decided from
/// the same scan detection uses, so a mock that is named like a real disk
/// replaces it everywhere.
pub fn is_mock_device(name: &str) -> bool {
    crate::dev_mock::scan_mock_drives()
        .iter()
        .any(|mock| mock.name == name)
}

// ---------------------------------------------------------------------------
// Looking at the disk right now

const SYS_BLOCK: &str = "/sys/block";

/// The detected drive called `name` right now, if it is still plugged in.
pub fn detect_now(name: &str) -> Option<DetectedDrive> {
    let mounts = std::fs::read_to_string("/proc/mounts").unwrap_or_default();
    detect::scan_with_dev_mocks(std::path::Path::new(SYS_BLOCK), &mounts)
        .into_iter()
        .find(|d| d.name == name && d.is_storage_candidate())
}

/// Who the disk is right now. `full` also reads its partitions and what they
/// are (a `blkid` per partition); without it only the physical identity is read.
pub fn identity_now(manager: &DriveManager, name: &str, full: bool) -> Option<DiskIdentity> {
    let det = detect_now(name)?;
    let mock = is_mock_device(name);
    let probe: &dyn crate::drives::fsprobe::FsProbe = if full { manager.probe() } else { &NoProbe };
    Some(inspect::read_identity(
        std::path::Path::new(SYS_BLOCK),
        &det,
        probe,
        mock,
    ))
}

/// Look at the disk right now: identity, contents and the empty verdict.
pub fn preview_now(manager: &DriveManager, tools: &dyn DiskTools, name: &str) -> Option<Preview> {
    let det = detect_now(name)?;
    let mounts = std::fs::read_to_string("/proc/mounts").unwrap_or_default();
    let env = Env {
        manager,
        tools,
        sys_block: std::path::Path::new(SYS_BLOCK),
        proc_mounts: &mounts,
    };
    Some(inspect::inspect_disk(&env, &det, is_mock_device(name)))
}

/// Run the erase for real: the worker half of a start. Blocking; the caller
/// holds the disk lock (and the drive lock) for as long as this runs.
pub fn execute(state: &AppState, handle: &Run, req: &run::Request) {
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let manager = &state.drive_manager;
        let name = req.identity.name.clone();
        let identity = |full: bool| identity_now(manager, &name, full);
        let still_empty =
            || preview_now(manager, state.format.tools(), &name).is_some_and(|p| p.empty);
        let mounts = || crate::drives::mounted_points_for_disk(&name);
        let progress = |phase: Phase| handle.set_phase(phase);
        let ctx = run::Ctx {
            state,
            tools: state.format.tools(),
            hooks: run::Hooks {
                identity: &identity,
                still_empty: &still_empty,
                mounts: &mounts,
            },
            progress: &progress,
            sys_block: std::path::Path::new(SYS_BLOCK),
            pacing: run::Pacing {
                mock_step: state.format.mock_step,
                ..run::Pacing::default()
            },
        };
        run::run(&ctx, req)
    }));
    match outcome {
        Ok(Ok(done)) => {
            let drive = done.drive;
            if !drive.mount_point.is_empty() {
                let root = std::path::PathBuf::from(&drive.mount_point);
                state.search_index.watch_mount(&drive.id, root.clone());
                state.gallery.watch_mount(&drive.id, root);
            }
            handle.finish_ok(&drive.id);
        }
        Ok(Err(failure)) => {
            tracing::warn!(device = %req.identity.name, error = %failure.error, erased = failure.erased, "drive erase failed");
            handle.finish_err(&failure.error.to_string(), failure.erased);
        }
        Err(_) => {
            tracing::error!(device = %req.identity.name, "drive erase panicked");
            // Unknown how far it got: say the drive may be erased.
            handle.finish_err(
                "Luna ran into a problem while erasing this drive. The drive may have been erased.",
                true,
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Previews

/// A preview Luna issued: what the person was shown, bound to the physical
/// disk, held in memory only.
#[derive(Debug, Clone)]
pub struct StoredPreview {
    pub id: String,
    /// The Admin it was issued to. Only they can start from it.
    pub user_id: String,
    pub preview: Preview,
    /// The registered drive on this disk, if any: reformatting keeps its id.
    pub registered_drive: Option<String>,
    pub issued_at: i64,
    /// When the erase button works. `issued_at` when the drive is verified
    /// empty, `issued_at + 30 s` otherwise.
    pub ready_at: i64,
    pub expires_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreviewError {
    /// Never issued, already used, or lost in a restart.
    NotFound,
    Expired,
    /// The wait is not over. Carries `ready_at`.
    NotReady(i64),
}

// ---------------------------------------------------------------------------
// Runs

#[derive(Debug, Clone, Serialize)]
pub struct RunStatus {
    pub id: String,
    /// Kernel name of the disk.
    pub device: String,
    /// The registered drive being reformatted, or the new drive once done.
    pub drive_id: Option<String>,
    pub encrypted: bool,
    pub phase: Phase,
    /// Every phase this run goes through, so a screen can list them.
    pub phases: Vec<Phase>,
    /// Finished successfully.
    pub done: bool,
    pub failed: bool,
    pub error: Option<String>,
    /// Destructive work started: the old contents may be gone. Only meaningful
    /// once `failed`; on success the drive was erased, of course.
    pub erased: bool,
    pub started_at: i64,
    pub finished_at: Option<i64>,
}

/// A run in progress, shared between the worker and anyone asking about it.
pub struct Run {
    status: Mutex<RunStatus>,
    clock: Arc<dyn Fn() -> i64 + Send + Sync>,
}

impl Run {
    pub fn id(&self) -> String {
        self.status().id
    }

    pub fn status(&self) -> RunStatus {
        self.status
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    pub fn set_phase(&self, phase: Phase) {
        self.status.lock().unwrap_or_else(|e| e.into_inner()).phase = phase;
    }

    pub fn finish_ok(&self, drive_id: &str) {
        let mut s = self.status.lock().unwrap_or_else(|e| e.into_inner());
        s.done = true;
        s.drive_id = Some(drive_id.to_string());
        s.erased = true;
        s.finished_at = Some((self.clock)());
    }

    pub fn finish_err(&self, message: &str, erased: bool) {
        let mut s = self.status.lock().unwrap_or_else(|e| e.into_inner());
        s.failed = true;
        s.error = Some(message.to_string());
        s.erased = erased;
        s.finished_at = Some((self.clock)());
    }

    fn running(&self) -> bool {
        let s = self.status.lock().unwrap_or_else(|e| e.into_inner());
        !s.done && !s.failed
    }
}

/// Everything the format API shares between requests.
pub struct FormatService {
    tools: Arc<dyn DiskTools>,
    clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    /// How long each simulated step of a mock drive's run takes.
    pub mock_step: Duration,
    previews: Mutex<HashMap<String, StoredPreview>>,
    runs: Mutex<HashMap<String, Arc<Run>>>,
}

impl Default for FormatService {
    fn default() -> Self {
        Self::new(Arc::new(CommandTools))
    }
}

impl FormatService {
    pub fn new(tools: Arc<dyn DiskTools>) -> Self {
        Self::with_clock(tools, Arc::new(crate::db::now_unix))
    }

    /// With a clock of the caller's choosing, so a test never waits 30 seconds.
    pub fn with_clock(
        tools: Arc<dyn DiskTools>,
        clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    ) -> Self {
        FormatService {
            tools,
            clock,
            mock_step: Duration::from_millis(700),
            previews: Mutex::default(),
            runs: Mutex::default(),
        }
    }

    pub fn tools(&self) -> &dyn DiskTools {
        self.tools.as_ref()
    }

    pub fn now(&self) -> i64 {
        (self.clock)()
    }

    /// Remember what the person is about to be shown. The wait is counted from
    /// here, on the server.
    pub fn issue_preview(
        &self,
        user_id: &str,
        preview: Preview,
        registered_drive: Option<String>,
    ) -> StoredPreview {
        let now = self.now();
        let stored = StoredPreview {
            id: uuid::Uuid::new_v4().to_string(),
            user_id: user_id.to_string(),
            ready_at: if preview.empty {
                now
            } else {
                now + WAIT_SECONDS
            },
            expires_at: now + PREVIEW_TTL_SECONDS,
            issued_at: now,
            preview,
            registered_drive,
        };
        let mut previews = self.previews.lock().unwrap_or_else(|e| e.into_inner());
        previews.retain(|_, p| p.expires_at > now);
        while previews.len() >= MAX_PREVIEWS {
            let Some(oldest) = previews
                .values()
                .min_by_key(|p| p.issued_at)
                .map(|p| p.id.clone())
            else {
                break;
            };
            previews.remove(&oldest);
        }
        previews.insert(stored.id.clone(), stored.clone());
        stored
    }

    /// The preview, if it is still good for `user_id` and its wait is over.
    /// Does not use it up.
    pub fn check_preview(&self, id: &str, user_id: &str) -> Result<StoredPreview, PreviewError> {
        let now = self.now();
        let previews = self.previews.lock().unwrap_or_else(|e| e.into_inner());
        let stored = previews
            .get(id)
            .filter(|p| p.user_id == user_id)
            .ok_or(PreviewError::NotFound)?;
        if now >= stored.expires_at {
            return Err(PreviewError::Expired);
        }
        if now < stored.ready_at {
            return Err(PreviewError::NotReady(stored.ready_at));
        }
        Ok(stored.clone())
    }

    /// Use the preview up: a start consumes it exactly once.
    pub fn consume_preview(&self, id: &str) {
        self.previews
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id);
    }

    /// Start tracking a run.
    pub fn begin_run(
        &self,
        device: &str,
        registered_drive: Option<String>,
        encrypted: bool,
    ) -> Arc<Run> {
        let now = self.now();
        let phases = Phase::sequence(encrypted);
        let run = Arc::new(Run {
            status: Mutex::new(RunStatus {
                id: uuid::Uuid::new_v4().to_string(),
                device: device.to_string(),
                drive_id: registered_drive,
                encrypted,
                phase: phases[0],
                phases,
                done: false,
                failed: false,
                error: None,
                erased: false,
                started_at: now,
                finished_at: None,
            }),
            clock: self.clock.clone(),
        });
        let mut runs = self.runs.lock().unwrap_or_else(|e| e.into_inner());
        // Forget old finished runs: keep the recent ones and a bounded number.
        runs.retain(|_, r| {
            r.status()
                .finished_at
                .is_none_or(|at| now - at < FINISHED_RUN_KEEP_SECONDS)
        });
        let mut finished: Vec<(i64, String)> = runs
            .values()
            .filter(|r| !r.running())
            .map(|r| (r.status().finished_at.unwrap_or(0), r.id()))
            .collect();
        finished.sort();
        while finished.len() >= MAX_FINISHED_RUNS {
            let (_, oldest) = finished.remove(0);
            runs.remove(&oldest);
        }
        runs.insert(run.id(), run.clone());
        run
    }

    pub fn run_status(&self, id: &str) -> Option<RunStatus> {
        self.runs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .map(|r| r.status())
    }

    /// The run in progress on this disk (kernel name), if any.
    pub fn running_on_device(&self, device: &str) -> Option<RunStatus> {
        self.runs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .filter(|r| r.running())
            .map(|r| r.status())
            .find(|s| s.device == device)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use inspect::{DiskIdentity, Preview};
    use tools::MockTools;

    fn preview(empty: bool) -> Preview {
        Preview {
            identity: DiskIdentity {
                name: "sdz".into(),
                model: "Stick".into(),
                size_bytes: 1,
                serial: None,
                wwn: None,
                diskseq: None,
                whole_fs_type: String::new(),
                layout: vec![],
                mock: false,
            },
            partitions: vec![],
            blank: empty,
            signatures: vec![],
            empty,
        }
    }

    fn service(clock: Arc<std::sync::atomic::AtomicI64>) -> FormatService {
        let c = clock.clone();
        FormatService::with_clock(
            Arc::new(MockTools::default()),
            Arc::new(move || c.load(std::sync::atomic::Ordering::SeqCst)),
        )
    }

    #[test]
    fn an_empty_drive_has_no_wait_and_a_full_one_waits_thirty_seconds_from_issue() {
        let clock = Arc::new(std::sync::atomic::AtomicI64::new(1000));
        let svc = service(clock.clone());
        let empty = svc.issue_preview("u", preview(true), None);
        assert_eq!(empty.ready_at, 1000);
        let full = svc.issue_preview("u", preview(false), None);
        assert_eq!(full.ready_at, 1030);
        assert_eq!(full.expires_at, 1000 + 15 * 60);
        // The server counts: asking early is refused with the time to wait for.
        assert_eq!(
            svc.check_preview(&full.id, "u").unwrap_err(),
            PreviewError::NotReady(1030)
        );
        clock.store(1029, std::sync::atomic::Ordering::SeqCst);
        assert!(svc.check_preview(&full.id, "u").is_err());
        clock.store(1030, std::sync::atomic::Ordering::SeqCst);
        assert!(svc.check_preview(&full.id, "u").is_ok());
    }

    #[test]
    fn a_preview_expires_after_fifteen_minutes_and_belongs_to_one_admin() {
        let clock = Arc::new(std::sync::atomic::AtomicI64::new(0));
        let svc = service(clock.clone());
        let p = svc.issue_preview("u", preview(true), None);
        assert_eq!(
            svc.check_preview(&p.id, "someone-else").unwrap_err(),
            PreviewError::NotFound
        );
        clock.store(15 * 60, std::sync::atomic::Ordering::SeqCst);
        assert_eq!(
            svc.check_preview(&p.id, "u").unwrap_err(),
            PreviewError::Expired
        );
    }

    #[test]
    fn a_preview_is_used_up_by_one_start() {
        let clock = Arc::new(std::sync::atomic::AtomicI64::new(0));
        let svc = service(clock);
        let p = svc.issue_preview("u", preview(true), None);
        svc.consume_preview(&p.id);
        assert_eq!(
            svc.check_preview(&p.id, "u").unwrap_err(),
            PreviewError::NotFound
        );
    }

    #[test]
    fn a_run_is_findable_by_id_and_by_disk_until_it_finishes() {
        let clock = Arc::new(std::sync::atomic::AtomicI64::new(5));
        let svc = service(clock);
        let run = svc.begin_run("sdz", None, true);
        assert_eq!(svc.running_on_device("sdz").unwrap().id, run.id());
        assert!(svc.running_on_device("sdy").is_none());
        run.set_phase(Phase::Encrypting);
        let status = svc.run_status(&run.id()).unwrap();
        assert_eq!(status.phase, Phase::Encrypting);
        assert!(status.phases.contains(&Phase::Encrypting));
        run.finish_err("It broke.", true);
        assert!(svc.running_on_device("sdz").is_none());
        let status = svc.run_status(&run.id()).unwrap();
        assert!(status.failed && !status.done && status.erased);
        assert_eq!(status.error.as_deref(), Some("It broke."));
    }

    #[test]
    fn only_encrypted_runs_have_an_encrypting_phase() {
        assert!(!Phase::sequence(false).contains(&Phase::Encrypting));
        assert!(Phase::sequence(true).contains(&Phase::Encrypting));
    }

    #[test]
    fn the_drive_gate_follows_the_guard() {
        assert!(!drive_is_formatting("gate-test"));
        let guard = FormattingDriveGuard::new("gate-test");
        assert!(drive_is_formatting("gate-test"));
        drop(guard);
        assert!(!drive_is_formatting("gate-test"));
    }
}

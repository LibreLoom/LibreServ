//! Check an exFAT drive before it is mounted read-write after an unclean stop.
//!
//! exFAT has no journal. A power cut or an unplug in the middle of a write can
//! leave its bookkeeping half-updated, and a Luna that is always on, with
//! uploads landing at any time, meets that more than a laptop does. So every
//! read-write mount of an exFAT volume first asks the volume itself whether it
//! was shut down cleanly: the exFAT boot sector carries a "volume dirty" bit
//! (and a "media failure" bit) that the kernel driver sets while it has
//! changes in flight and clears when they are written out. A dirty volume goes
//! through `fsck.exfat` before anyone mounts it.
//!
//! The answer is read from the drive, not from a record Luna keeps, so it also
//! covers a stick pulled out and plugged into another computer. A clean volume
//! costs one 512-byte read.
//!
//! Outcomes:
//! - clean: nothing to do;
//! - repaired: mounted read-write, and a notice tells the person what happened;
//! - not repaired (or the check ran out of time): mounted **read-only** so the
//!   files can still be copied off, and the notice says so.

use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

/// A check of a big, damaged drive can take a while. Past this the drive is
/// treated as not repairable rather than holding every other drive up.
const FSCK_TIMEOUT: Duration = Duration::from_secs(20 * 60);
/// How long a "repaired" notice stays up.
const NOTICE_TTL: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// Bit 1 of the boot sector's `VolumeFlags` (offset 106): the volume has
/// changes the driver hasn't finished writing.
const VOLUME_DIRTY: u16 = 1 << 1;
/// Bit 2: a read or write failed on this media.
const MEDIA_FAILURE: u16 = 1 << 2;
const FLAGS_OFFSET: usize = 106;

/// `VolumeFlags` from the first sector of a device, or `None` when that sector
/// is not an exFAT boot sector.
pub fn parse_volume_flags(boot: &[u8]) -> Option<u16> {
    if boot.len() < FLAGS_OFFSET + 2 || &boot[3..11] != b"EXFAT   " {
        return None;
    }
    Some(u16::from_le_bytes([
        boot[FLAGS_OFFSET],
        boot[FLAGS_OFFSET + 1],
    ]))
}

/// Was this volume left in the middle of something?
pub fn is_unclean(flags: u16) -> bool {
    flags & (VOLUME_DIRTY | MEDIA_FAILURE) != 0
}

/// How a `fsck.exfat` run ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FsckExit {
    /// Nothing wrong (exit 0).
    Clean,
    /// Problems found and fixed (exit 1).
    Fixed,
    /// Safe repairs weren't enough (exit 4).
    ErrorsLeft,
    /// Anything else, or the tool couldn't run or ran out of time.
    Failed,
}

pub trait ExfatTools: Send + Sync {
    /// The first sector's `VolumeFlags`, `None` when `device` isn't exFAT
    /// or can't be read.
    fn volume_flags(&self, device: &str) -> Option<u16>;
    /// Run `fsck.exfat` on `device`: `safe_only` repairs only what is safe
    /// (`-p`), otherwise everything it can (`-y`).
    fn repair(&self, device: &str, safe_only: bool) -> FsckExit;
}

/// The real tools.
#[derive(Clone, Default)]
pub struct CommandExfatTools;

impl ExfatTools for CommandExfatTools {
    fn volume_flags(&self, device: &str) -> Option<u16> {
        let mut file = std::fs::File::open(device).ok()?;
        let mut boot = [0u8; 512];
        file.read_exact(&mut boot).ok()?;
        parse_volume_flags(&boot)
    }

    fn repair(&self, device: &str, safe_only: bool) -> FsckExit {
        let Some(bin) = crate::sandbox::which("fsck.exfat") else {
            tracing::warn!("fsck.exfat is not installed; an unclean exFAT drive can't be checked");
            return FsckExit::Failed;
        };
        let mut cmd = crate::sandbox::hardened(&bin);
        cmd.arg(if safe_only { "-p" } else { "-y" }).arg(device);
        // Empty stdin: a question can never hang the check until its deadline.
        match crate::sandbox::output_with_input(&mut cmd, b"", FSCK_TIMEOUT) {
            Ok(out) => {
                let code = out.status.code();
                tracing::info!(device, ?code, "fsck.exfat finished");
                match code {
                    Some(0) => FsckExit::Clean,
                    Some(1) => FsckExit::Fixed,
                    Some(4) => FsckExit::ErrorsLeft,
                    _ => FsckExit::Failed,
                }
            }
            Err(e) => {
                tracing::warn!(device, error = %e, "fsck.exfat could not finish");
                FsckExit::Failed
            }
        }
    }
}

/// What the check decided about a drive.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// Not exFAT, unreadable, or shut down cleanly.
    Clean,
    /// Was dirty; checked and fixed. Safe to mount read-write.
    Repaired,
    /// Was dirty and couldn't be fixed. Mount read-only.
    Unrepaired,
}

/// Look at `device` and repair it when it was not shut down cleanly.
/// Never run on a read-only mount: those promise to write nothing.
pub fn check(tools: &dyn ExfatTools, device: &str) -> Outcome {
    let Some(flags) = tools.volume_flags(device) else {
        return Outcome::Clean;
    };
    if !is_unclean(flags) {
        return Outcome::Clean;
    }
    tracing::info!(
        device,
        flags,
        "exFAT drive was not shut down cleanly; checking it"
    );
    match tools.repair(device, true) {
        FsckExit::Clean | FsckExit::Fixed => Outcome::Repaired,
        FsckExit::ErrorsLeft => match tools.repair(device, false) {
            FsckExit::Clean | FsckExit::Fixed => Outcome::Repaired,
            _ => Outcome::Unrepaired,
        },
        FsckExit::Failed => Outcome::Unrepaired,
    }
}

// ── One check per device at a time ───────────────────────────────────────────

struct Busy {
    devices: Mutex<HashSet<String>>,
    done: Condvar,
}

static BUSY: std::sync::LazyLock<Busy> = std::sync::LazyLock::new(|| Busy {
    devices: Mutex::new(HashSet::new()),
    done: Condvar::new(),
});

/// Held while a device is being checked.
pub struct CheckGuard(String);

impl Drop for CheckGuard {
    fn drop(&mut self) {
        BUSY.devices
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.0);
        BUSY.done.notify_all();
    }
}

/// Take the device's check slot, waiting for another check on it to finish.
pub fn begin(device: &str) -> CheckGuard {
    let mut g = BUSY.devices.lock().unwrap_or_else(|e| e.into_inner());
    while g.contains(device) {
        g = BUSY.done.wait(g).unwrap_or_else(|e| e.into_inner());
    }
    g.insert(device.to_string());
    CheckGuard(device.to_string())
}

/// Wait while `device` is being repaired, so a background look-inside mount
/// never reads a volume that is half fixed.
pub fn wait_idle(device: &str) {
    let mut g = BUSY.devices.lock().unwrap_or_else(|e| e.into_inner());
    while g.contains(device) {
        g = BUSY.done.wait(g).unwrap_or_else(|e| e.into_inner());
    }
}

// ── What the person is told ─────────────────────────────────────────────────

#[derive(Debug, Clone)]
struct Note {
    outcome: Outcome,
    at: Instant,
}

static NOTES: std::sync::LazyLock<Mutex<HashMap<PathBuf, Note>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

/// Remember what happened to the drive mounted at `target`.
pub fn record(target: &Path, outcome: Outcome) {
    let mut g = NOTES.lock().unwrap_or_else(|e| e.into_inner());
    match outcome {
        Outcome::Clean => {
            g.remove(target);
        }
        _ => {
            g.insert(
                target.to_path_buf(),
                Note {
                    outcome,
                    at: Instant::now(),
                },
            );
        }
    }
}

/// True when the drive at `target` could not be repaired and must stay read-only.
pub fn is_unrepaired(target: &Path) -> bool {
    NOTES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(target)
        .is_some_and(|n| n.outcome == Outcome::Unrepaired)
}

/// A notice for the drive mounted at `target`: a short line and one line more.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Notice {
    pub repaired: bool,
    pub message: String,
    pub more: String,
}

pub fn notice_for(target: &Path, label: &str) -> Option<Notice> {
    let g = NOTES.lock().unwrap_or_else(|e| e.into_inner());
    let note = g.get(target)?;
    match note.outcome {
        Outcome::Repaired if note.at.elapsed() < NOTICE_TTL => Some(Notice {
            repaired: true,
            message: format!("{label} wasn't shut down properly, so Luna checked it and fixed what it found."),
            more: "This happens after a power cut or when a drive is unplugged without ejecting it. Files saved just before that may be missing, so check your latest uploads.".into(),
        }),
        Outcome::Unrepaired => Some(Notice {
            repaired: false,
            message: format!("Luna found problems on {label} that it couldn't fix, so it opened the drive read-only."),
            more: "You can still copy your files off it. Check the drive on a Windows or Mac computer, or set it up again once your files are safe.".into(),
        }),
        _ => None,
    }
}

/// Everything the mounter does before a read-write mount of `device` at
/// `target`. Returns true when the drive must be mounted read-only instead.
pub fn before_rw_mount(tools: &dyn ExfatTools, device: &str, target: &Path) -> bool {
    let _slot = begin(device);
    let outcome = check(tools, device);
    record(target, outcome);
    outcome == Outcome::Unrepaired
}

#[cfg(test)]
pub struct MockExfatTools {
    pub flags: Option<u16>,
    pub exits: Mutex<Vec<FsckExit>>,
    pub calls: Mutex<Vec<bool>>,
}

#[cfg(test)]
impl ExfatTools for MockExfatTools {
    fn volume_flags(&self, _device: &str) -> Option<u16> {
        self.flags
    }
    fn repair(&self, _device: &str, safe_only: bool) -> FsckExit {
        self.calls.lock().unwrap().push(safe_only);
        let mut e = self.exits.lock().unwrap();
        if e.is_empty() {
            FsckExit::Failed
        } else {
            e.remove(0)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mock(flags: Option<u16>, exits: Vec<FsckExit>) -> MockExfatTools {
        MockExfatTools {
            flags,
            exits: Mutex::new(exits),
            calls: Mutex::new(Vec::new()),
        }
    }

    fn boot(flags: u16) -> Vec<u8> {
        let mut b = vec![0u8; 512];
        b[3..11].copy_from_slice(b"EXFAT   ");
        b[106..108].copy_from_slice(&flags.to_le_bytes());
        b
    }

    #[test]
    fn reads_the_dirty_bit_from_the_boot_sector() {
        assert_eq!(parse_volume_flags(&boot(0)), Some(0));
        assert!(!is_unclean(parse_volume_flags(&boot(1)).unwrap()));
        assert!(is_unclean(parse_volume_flags(&boot(2)).unwrap()));
        assert!(is_unclean(parse_volume_flags(&boot(4)).unwrap()));
        let mut ntfs = boot(2);
        ntfs[3..11].copy_from_slice(b"NTFS    ");
        assert_eq!(parse_volume_flags(&ntfs), None);
        assert_eq!(parse_volume_flags(&[0u8; 10]), None);
    }

    #[test]
    fn a_clean_volume_is_never_checked() {
        let t = mock(Some(0), vec![]);
        assert_eq!(check(&t, "/dev/sdb1"), Outcome::Clean);
        assert!(t.calls.lock().unwrap().is_empty());
        let t = mock(None, vec![]);
        assert_eq!(check(&t, "/dev/sdb1"), Outcome::Clean);
    }

    #[test]
    fn a_dirty_volume_gets_a_safe_repair_first() {
        let t = mock(Some(2), vec![FsckExit::Fixed]);
        assert_eq!(check(&t, "/dev/sdb1"), Outcome::Repaired);
        assert_eq!(*t.calls.lock().unwrap(), vec![true]);
    }

    #[test]
    fn errors_left_after_the_safe_pass_get_the_full_repair() {
        let t = mock(Some(2), vec![FsckExit::ErrorsLeft, FsckExit::Fixed]);
        assert_eq!(check(&t, "/dev/sdb1"), Outcome::Repaired);
        assert_eq!(*t.calls.lock().unwrap(), vec![true, false]);
        let t = mock(Some(2), vec![FsckExit::ErrorsLeft, FsckExit::ErrorsLeft]);
        assert_eq!(check(&t, "/dev/sdb1"), Outcome::Unrepaired);
    }

    #[test]
    fn a_failed_or_timed_out_check_means_read_only() {
        let t = mock(Some(2), vec![FsckExit::Failed]);
        assert!(before_rw_mount(&t, "/dev/sdz1", Path::new("/m/a")));
        assert!(is_unrepaired(Path::new("/m/a")));
    }

    #[test]
    fn notices_say_what_happened_in_plain_words() {
        let t = mock(Some(2), vec![FsckExit::Fixed]);
        assert!(!before_rw_mount(&t, "/dev/sdz2", Path::new("/m/b")));
        let n = notice_for(Path::new("/m/b"), "Photos").unwrap();
        assert!(n.repaired);
        assert!(n.message.contains("Photos"));
        assert!(!is_unrepaired(Path::new("/m/b")));
        // A later clean mount clears it.
        record(Path::new("/m/b"), Outcome::Clean);
        assert!(notice_for(Path::new("/m/b"), "Photos").is_none());
        let t = mock(Some(2), vec![FsckExit::Failed]);
        before_rw_mount(&t, "/dev/sdz3", Path::new("/m/c"));
        let n = notice_for(Path::new("/m/c"), "Photos").unwrap();
        assert!(!n.repaired);
        assert!(n.message.contains("read-only"));
    }
}

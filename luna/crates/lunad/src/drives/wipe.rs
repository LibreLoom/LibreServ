//! Deciding whether a wipe needs a waiting period, and what to show while it
//! runs.
//!
//! Two questions, both answered from the drive itself rather than from a
//! guess:
//!
//! - **Does it hold anything?** Measured in bytes used beyond what a fresh
//!   filesystem of that kind already occupies. A freshly formatted exFAT drive
//!   reports tens of kilobytes in use with nothing on it, so counting raw used
//!   bytes would call an empty drive full.
//! - **What is on it?** The top-level names, so the person can see what they
//!   are about to lose instead of reading a number.
//!
//! The rule that consumes this lives in the API: a drive with nothing
//! meaningful is one confirmation, anything else is a wait. Keeping the
//! measurement here means the threshold is one constant with one test.

use std::path::Path;

use luna_core::scan::{TopLevelEntry, TopLevelSummary, scan_top_level};

/// Used bytes a fresh filesystem already reports, by kind.
///
/// Measured, not guessed: a freshly made 2 TB exFAT reports 2.25 MiB used, a
/// 200 GB one 512 KiB, a 4 GB one 96 KiB, and a fresh ext4 reports 28 KiB at
/// any size. The number grows with the size of the drive because the FAT and
/// allocation tables do, so the allowance is generous rather than exact — it
/// only has to separate "empty" from "has files", and being a little high
/// costs nothing while being low would call an empty drive full.
const OVERHEAD_ALLOWANCE: u64 = 16 * 1024 * 1024;

/// Does a drive reporting `used_bytes` hold anything a person would miss?
///
/// The one rule, in one place: callers that only have a measurement — the
/// Add-drive inspector, which never builds a full [`Contents`] — must reach
/// the same answer as the ones that do.
pub fn holds_something(used_bytes: Option<u64>) -> bool {
    match used_bytes {
        Some(used) => used > OVERHEAD_ALLOWANCE,
        // Could not measure it. Assume the worst.
        None => true,
    }
}

/// Bytes in use on the filesystem at `mount_point`.
///
/// `used = total - free`, which is what `df` reports. Returns `None` when the
/// filesystem cannot be read, which the caller must treat as "assume it holds
/// something" — refusing to guess is the safe direction.
pub fn used_bytes(mount_point: &Path) -> Option<u64> {
    let total = total_bytes(mount_point)?;
    let free = crate::drives::ext4::free_bytes(mount_point)?;
    Some(total.saturating_sub(free))
}

fn total_bytes(mount_point: &Path) -> Option<u64> {
    let c = std::ffi::CString::new(mount_point.as_os_str().as_encoded_bytes()).ok()?;
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut stat) } != 0 {
        return None;
    }
    let frsize = if stat.f_frsize == 0 {
        stat.f_bsize as u64
    } else {
        stat.f_frsize as u64
    };
    Some((stat.f_blocks as u64).saturating_mul(frsize))
}

/// What a wipe would destroy, as the confirmation dialog needs it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Contents {
    /// Bytes in use, or `None` when they could not be read.
    pub used_bytes: Option<u64>,
    /// Top-level folders and files, for the list.
    pub summary: TopLevelSummary,
    /// Whether the drive has to be read before it can be listed. A locked
    /// encrypted drive cannot be inspected at all.
    pub readable: bool,
}

impl Contents {
    /// A drive Luna could not look inside. Treated as holding something: the
    /// alternative is telling someone a drive is empty when it is not.
    pub fn unknown() -> Contents {
        Contents {
            used_bytes: None,
            summary: TopLevelSummary::default(),
            readable: false,
        }
    }

    /// Does this drive hold anything a person would miss?
    ///
    /// True when bytes are in use beyond filesystem overhead, or when the
    /// filesystem could not be read at all. A drive that is merely *large*
    /// does not qualify: overhead is subtracted first.
    pub fn is_meaningful(&self) -> bool {
        holds_something(self.used_bytes)
    }

    /// The names to show in the confirmation, folders first.
    pub fn names(&self) -> Vec<&TopLevelEntry> {
        self.summary.entries.iter().collect()
    }

    /// How many things are on the drive, hidden names excluded.
    pub fn count(&self) -> u64 {
        self.summary.folders + self.summary.files
    }
}

/// Look at a mounted drive to decide what a wipe would cost.
///
/// `mounted` is the caller's answer to "is this drive actually mounted right
/// now", which it already knows from the same `Mounter` everything else uses.
/// It is required rather than derived here because measuring a directory that
/// is *not* a live mount reports the filesystem that contains it: a stale
/// mount point left on the system disk would make `statvfs` report the whole
/// system disk, and the drive would look full when it is not even present.
pub fn inspect(mount_point: &Path, mounted: bool) -> Contents {
    inspect_with(mount_point, mounted, used_bytes)
}

/// [`inspect`] with the measurement supplied, so a test can describe a drive
/// without needing a real filesystem of the right size.
pub fn inspect_with(
    mount_point: &Path,
    mounted: bool,
    measure: impl Fn(&Path) -> Option<u64>,
) -> Contents {
    if !mounted || !mount_point.is_dir() {
        return Contents::unknown();
    }
    Contents {
        used_bytes: measure(mount_point),
        summary: scan_top_level(mount_point),
        readable: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn contents(used: Option<u64>) -> Contents {
        Contents {
            used_bytes: used,
            summary: TopLevelSummary::default(),
            readable: true,
        }
    }

    #[test]
    fn a_fresh_drive_holds_nothing_meaningful() {
        // A fresh exFAT reports a few hundred KiB with nothing on it.
        assert!(!contents(Some(96 * 1024)).is_meaningful());
        assert!(!contents(Some(2_250_000)).is_meaningful());
        assert!(!contents(Some(0)).is_meaningful());
    }

    #[test]
    fn a_drive_with_files_on_it_is_meaningful() {
        assert!(contents(Some(OVERHEAD_ALLOWANCE + 1)).is_meaningful());
        assert!(contents(Some(1024 * 1024 * 1024)).is_meaningful());
    }

    #[test]
    fn an_unreadable_drive_is_treated_as_holding_something() {
        // Never tell someone a drive is empty when Luna could not look.
        assert!(contents(None).is_meaningful());
        assert!(Contents::unknown().is_meaningful());
        assert!(!Contents::unknown().readable);
    }

    #[test]
    fn the_allowance_covers_a_large_fresh_exfat() {
        // Measured on a fresh 2 TB exFAT: 2.25 MiB used, nothing on it.
        assert!(!contents(Some(2_359_296)).is_meaningful());
    }

    #[test]
    fn a_drive_that_is_not_mounted_cannot_be_inspected() {
        let looked = inspect(Path::new("/luna/no/such/mount"), false);
        assert!(!looked.readable);
        assert!(looked.is_meaningful());
    }

    #[test]
    fn an_unmounted_drive_is_not_measured_even_if_the_folder_exists() {
        // A stale mount point left on the system disk: measuring it would
        // report the system disk and demand a waiting period for a drive that
        // is not there.
        let dir = tempfile::tempdir().unwrap();
        let looked = inspect(dir.path(), false);
        assert!(!looked.readable);
        assert!(looked.is_meaningful());
    }

    #[test]
    fn a_mounted_drive_is_measured() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("holiday.jpg"), b"x").unwrap();
        let looked = inspect_with(dir.path(), true, |_| Some(96 * 1024));
        assert!(looked.readable);
        assert_eq!(looked.summary.files, 1);
        assert_eq!(looked.used_bytes, Some(96 * 1024));
    }

    #[test]
    fn a_mounted_drive_with_files_needs_the_wait() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("holiday.jpg"), b"x").unwrap();
        let looked = inspect_with(dir.path(), true, |_| Some(4 * 1024 * 1024 * 1024));
        assert!(looked.is_meaningful());
    }
}

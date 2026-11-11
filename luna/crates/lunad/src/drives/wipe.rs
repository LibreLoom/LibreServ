//! Read-only contents measurements for drive inspection and format review.
//! All formats require the same review; byte usage never decides whether
//! files matter or whether a person may skip the waiting period.

use std::path::Path;

use luna_core::scan::{TopLevelSummary, scan_top_level};

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
    /// Unknown contents must never be described as an empty drive.
    pub fn unknown() -> Contents {
        Contents {
            used_bytes: None,
            summary: TopLevelSummary::default(),
            readable: false,
        }
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

    #[test]
    fn an_unmounted_folder_is_never_measured_as_the_drive() {
        let dir = tempfile::tempdir().unwrap();
        let looked = inspect_with(dir.path(), false, |_| {
            panic!("must not measure a stale mount")
        });
        assert!(!looked.readable);
        assert_eq!(looked.used_bytes, None);
    }

    #[test]
    fn small_files_are_listed_without_an_emptiness_threshold() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("holiday.jpg"), b"x").unwrap();
        let looked = inspect_with(dir.path(), true, |_| Some(96 * 1024));
        assert!(looked.readable);
        assert_eq!(looked.summary.files, 1);
        assert_eq!(looked.summary.entries[0].name, "holiday.jpg");
        assert_eq!(looked.used_bytes, Some(96 * 1024));
    }

    #[test]
    fn missing_drive_has_unknown_contents() {
        let looked = inspect(Path::new("/luna/no/such/mount"), false);
        assert!(!looked.readable);
        assert_eq!(looked.used_bytes, None);
    }
}

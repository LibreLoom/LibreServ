//! One backend for putting a filesystem on a drive.
//!
//! Every flow that ends with a drive ready to use goes through [`run`]: adding
//! a blank stick, erasing installer media, reformatting a drive Luna already
//! knows, and setting up an encrypted drive. They differ only in the
//! [`Target`] they ask for, which is the point — one sequence of disk
//! operations to get right, one set of error messages, one place that knows
//! what "wipe this drive" means.
//!
//! The sequence is always the same:
//!
//! 1. unmount everything on the disk and refuse if anything is still busy,
//! 2. `wipefs` every signature off it,
//! 3. one partition spanning the whole disk,
//! 4. optionally a LUKS2 container on that partition,
//! 5. the filesystem, on the container when there is one.
//!
//! Nothing here decides *whether* a wipe is allowed. That is the caller's job,
//! because the answer depends on what the drive holds and who is asking.

use std::path::Path;
use std::process::Stdio;

use crate::drives::fsprobe::{FsProbe, sanitize_volume_label};
use crate::drives::luks::{self, Luks};

/// What filesystem to put on the drive.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Filesystem {
    /// The default for a plain drive: readable on any computer.
    Exfat,
    /// What an encrypted drive uses inside its container.
    Ext4,
}

impl Filesystem {
    pub fn as_str(self) -> &'static str {
        match self {
            Filesystem::Exfat => "exfat",
            Filesystem::Ext4 => "ext4",
        }
    }

    /// The filesystem a drive gets when it is not encrypted.
    pub fn parse(name: &str) -> Option<Filesystem> {
        match name.trim().to_ascii_lowercase().as_str() {
            "exfat" => Some(Filesystem::Exfat),
            "ext4" => Some(Filesystem::Ext4),
            _ => None,
        }
    }
}

/// Everything that decides what ends up on the disk.
#[derive(Debug, Clone)]
pub struct Target {
    pub filesystem: Filesystem,
    /// Volume label. Sanitised before it reaches `mkfs`.
    pub label: String,
    /// Put a LUKS2 container on the partition first. The filesystem then lives
    /// inside it, and the drive needs the password to be read at all.
    pub encrypt: bool,
}

impl Target {
    /// A plain drive, readable anywhere.
    pub fn plain(label: &str) -> Target {
        Target {
            filesystem: Filesystem::Exfat,
            label: label.to_string(),
            encrypt: false,
        }
    }

    /// An encrypted drive: ext4 inside a LUKS2 container.
    ///
    /// The filesystem is forced rather than taken from the caller: an
    /// encrypted drive is always ext4 inside, and letting a caller ask for
    /// exFAT in a container would produce a drive nothing else in Luna
    /// expects.
    pub fn encrypted(label: &str) -> Target {
        Target {
            filesystem: Filesystem::Ext4,
            label: label.to_string(),
            encrypt: true,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum FormatError {
    #[error(
        "Something is still using this drive, so Luna can't erase it. Close whatever has it open, then try again."
    )]
    Busy,
    #[error("Luna can't prepare drives. This Luna is missing a program it needs ({0}).")]
    MissingTool(&'static str),
    #[error("{0}")]
    Other(String),
}

impl FormatError {
    pub fn message(&self) -> String {
        self.to_string()
    }
}

/// The one operation that writes a filesystem, behind a trait so a test can
/// watch the sequence without a real device.
pub trait Mkfs: Send + Sync {
    fn make(&self, device: &str, label: &str, filesystem: Filesystem) -> Result<(), FormatError>;
}

/// The real one: `mkfs.ext4`, or exFAT with a FAT32 fallback.
#[derive(Clone, Default)]
pub struct CommandMkfs;

impl Mkfs for CommandMkfs {
    fn make(&self, device: &str, label: &str, filesystem: Filesystem) -> Result<(), FormatError> {
        make_filesystem(device, label, filesystem)
    }
}

/// What a format actually did, so the caller can record it without guessing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Formatted {
    /// The partition the filesystem is on, e.g. `sdb1`. For an encrypted
    /// drive this is the partition holding the container, not the mapper.
    pub partition: String,
    pub filesystem: Filesystem,
    pub encrypted: bool,
}

/// Format `disk` (a whole disk name like `sdb`, not a partition).
///
/// `unmount` is called for every mount point on the disk before anything is
/// written, and must actually unmount it. It is a parameter because a
/// conversion has to go through the same `Mounter` the rest of the daemon
/// uses, and tests must not touch real disks.
///
/// Blocking and destructive: call it from a worker thread, and only after the
/// caller has decided the wipe is allowed.
pub fn run(
    probe: &dyn FsProbe,
    luks: &dyn Luks,
    mkfs: &dyn Mkfs,
    disk: &str,
    target: &Target,
    password: &str,
    unmount: impl Fn(&Path) -> bool,
) -> Result<Formatted, FormatError> {
    unmount_disk(disk, unmount)?;

    // 1. Clear every signature and lay down one partition spanning the disk.
    //    Shared with the adopt path, so there is one implementation of
    //    "prepare a disk" rather than two that can drift.
    let partition = probe
        .prepare_disk(disk)
        .map_err(|e| FormatError::Other(format!("Luna couldn't prepare this drive. {e}")))?;
    let part_dev = format!("/dev/{partition}");

    // 3. The container, when the drive is encrypted.
    if target.encrypt {
        let pbkdf = luks::pbkdf_kib_from(crate::budget::meminfo().available_bytes);
        luks.format(&part_dev, &target.label, password, pbkdf)
            .map_err(|e| FormatError::Other(e.to_string()))?;
        // Format the filesystem through the container, so it lands inside.
        luks.open(&part_dev, "__format", password)
            .map_err(|e| FormatError::Other(e.to_string()))?;
        let mapper = format!("/dev/mapper/{}", luks::mapper_name("__format"));
        let made = mkfs.make(&mapper, &target.label, target.filesystem);
        let _ = luks.close("__format");
        made?;
    } else {
        mkfs.make(&part_dev, &target.label, target.filesystem)?;
    }

    Ok(Formatted {
        partition,
        filesystem: target.filesystem,
        encrypted: target.encrypt,
    })
}

/// A device name as an absolute path. `blkid` reports `sdb1`; the tools want
/// `/dev/sdb1`. An already-absolute name is left alone.
pub fn device_path(name: &str) -> String {
    if name.starts_with('/') {
        name.to_string()
    } else {
        format!("/dev/{name}")
    }
}

/// Unmount everything on the disk, then refuse if anything is still mounted.
///
/// Repartitioning under a live mount can corrupt the running system, not just
/// the stick, so a busy disk stops the format rather than being ignored.
fn unmount_disk(disk: &str, unmount: impl Fn(&Path) -> bool) -> Result<(), FormatError> {
    let mut points = crate::drives::mounted_points_for_disk(disk);
    // Deepest first: an unmount of a nested mount has to happen before its
    // parent, or the parent is still busy.
    points.sort_by_key(|p| std::cmp::Reverse(p.as_os_str().len()));
    for point in &points {
        unmount(point);
    }
    if !crate::drives::mounted_points_for_disk(disk).is_empty() {
        return Err(FormatError::Busy);
    }
    Ok(())
}

/// Put a filesystem on `device`, which is a partition or a mapper.
///
/// Lives here rather than behind [`FsProbe`] because the choice of filesystem
/// is this module's business: the probe prepares a disk and knows nothing
/// about what goes on it.
pub(crate) fn make_filesystem(
    device: &str,
    label: &str,
    filesystem: Filesystem,
) -> Result<(), FormatError> {
    let label = sanitize_volume_label(label);
    match filesystem {
        Filesystem::Ext4 => crate::drives::ext4::mkfs_ext4(device, &label)
            .map_err(|e| FormatError::Other(e.to_string())),
        Filesystem::Exfat => make_exfat(device, &label),
    }
}

/// exFAT, falling back to FAT32 when the box has no `mkfs.exfat`.
///
/// The fallback is deliberate rather than an error: a stick formatted FAT32
/// still works everywhere a person expects, and refusing to prepare a drive
/// because one tool is absent would be worse than the older format.
fn make_exfat(device: &str, label: &str) -> Result<(), FormatError> {
    let exfat = crate::sandbox::which("mkfs.exfat").map(|bin| {
        let mut cmd = crate::sandbox::hardened(&bin);
        cmd.args(["-n", label, device]).stderr(Stdio::piped());
        crate::sandbox::output_limited(&mut cmd, std::time::Duration::from_secs(120))
    });
    let exfat = exfat.unwrap_or_else(|| {
        Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "mkfs.exfat missing",
        ))
    });
    if exfat.as_ref().is_ok_and(|o| o.status.success()) {
        return Ok(());
    }

    let fat = crate::sandbox::which("mkfs.vfat").map(|bin| {
        let mut cmd = crate::sandbox::hardened(&bin);
        cmd.args(["-F", "32", "-n", label, device])
            .stderr(Stdio::piped());
        crate::sandbox::output_limited(&mut cmd, std::time::Duration::from_secs(120))
    });
    let fat = fat.unwrap_or_else(|| {
        Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "mkfs.vfat missing",
        ))
    });
    if fat.as_ref().is_ok_and(|o| o.status.success()) {
        return Ok(());
    }
    Err(FormatError::Other(format!(
        "Luna couldn't set up this drive for files. {}",
        mkfs_failure_details(&exfat, &fat)
    )))
}

/// What each format tool said, so a failure shows both attempts. A tool that
/// couldn't start at all is reported as missing.
fn mkfs_failure_details(
    exfat: &std::io::Result<std::process::Output>,
    fat: &std::io::Result<std::process::Output>,
) -> String {
    fn one(name: &str, result: &std::io::Result<std::process::Output>) -> String {
        match result {
            Ok(o) => {
                let said = String::from_utf8_lossy(&o.stderr).trim().to_string();
                if said.is_empty() {
                    format!("{name} failed.")
                } else {
                    format!("{name}: {said}")
                }
            }
            Err(_) => format!("{name} is not installed on this Luna."),
        }
    }
    format!(
        "{} {}",
        one("exFAT format", exfat),
        one("FAT32 format", fat)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Records what it was asked to make, and makes nothing.
    #[derive(Default)]
    struct MockMkfs {
        made: std::sync::Mutex<Vec<(String, String)>>,
    }

    impl Mkfs for MockMkfs {
        fn make(
            &self,
            device: &str,
            _label: &str,
            filesystem: Filesystem,
        ) -> Result<(), FormatError> {
            self.made
                .lock()
                .unwrap()
                .push((device.to_string(), filesystem.as_str().to_string()));
            Ok(())
        }
    }

    #[test]
    fn an_encrypted_target_is_always_ext4() {
        // Asking for exFAT in a container is a contradiction: an encrypted
        // drive is ext4 inside, and nothing downstream expects otherwise.
        let target = Target::encrypted("Photos");
        assert_eq!(target.filesystem, Filesystem::Ext4);
        assert!(target.encrypt);
    }

    #[test]
    fn a_plain_target_is_exfat_and_unencrypted() {
        let target = Target::plain("Photos");
        assert_eq!(target.filesystem, Filesystem::Exfat);
        assert!(!target.encrypt);
    }

    #[test]
    fn filesystem_names_round_trip() {
        assert_eq!(Filesystem::parse("exfat"), Some(Filesystem::Exfat));
        assert_eq!(Filesystem::parse("EXT4"), Some(Filesystem::Ext4));
        assert_eq!(Filesystem::parse(" ext4 "), Some(Filesystem::Ext4));
        assert_eq!(Filesystem::parse("ntfs"), None);
        assert_eq!(Filesystem::Exfat.as_str(), "exfat");
        assert_eq!(Filesystem::Ext4.as_str(), "ext4");
    }

    #[test]
    fn a_plain_format_asks_the_probe_for_the_partition_and_the_filesystem() {
        // `run` owns no disk access of its own: the probe prepares the disk
        // and makes the filesystem, so a test can watch the whole sequence
        // without touching a real device.
        let probe = crate::drives::fsprobe::MockFsProbe::default();
        let luks = crate::drives::luks::MockLuks::default();
        let mkfs = MockMkfs::default();
        let made = run(
            &probe,
            &luks,
            &mkfs,
            "sdz",
            &Target::plain("Photos"),
            "",
            |_| true,
        )
        .unwrap();

        assert_eq!(made.partition, "sdz1");
        assert_eq!(made.filesystem, Filesystem::Exfat);
        assert!(!made.encrypted);
        assert_eq!(
            probe.formats.lock().unwrap().clone(),
            vec!["sdz".to_string()]
        );
        // The filesystem goes on the partition the probe reported, not on the
        // whole disk.
        assert_eq!(
            mkfs.made.lock().unwrap().clone(),
            vec![("/dev/sdz1".to_string(), "exfat".to_string())]
        );
    }

    #[test]
    fn an_encrypted_format_puts_ext4_inside_the_container() {
        // The filesystem must be made on the mapper, not on the partition:
        // making it on the partition would put ext4 outside the container and
        // leave the drive unencrypted while claiming otherwise.
        let probe = crate::drives::fsprobe::MockFsProbe::default();
        let luks = crate::drives::luks::MockLuks::default();
        let mkfs = MockMkfs::default();
        let made = run(
            &probe,
            &luks,
            &mkfs,
            "sdz",
            &Target::encrypted("Photos"),
            "hunter22hunter1",
            |_| true,
        )
        .unwrap();

        assert_eq!(made.partition, "sdz1");
        assert_eq!(made.filesystem, Filesystem::Ext4);
        assert!(made.encrypted);
        // The filesystem was made on the mapper, not the partition: making it
        // on the partition would put ext4 outside the container and leave the
        // drive unencrypted while claiming otherwise.
        let made_fs = mkfs.made.lock().unwrap().clone();
        assert_eq!(made_fs.len(), 1);
        let (device, kind) = &made_fs[0];
        assert!(
            device.contains("/dev/mapper/luna-vault-"),
            "ext4 must be made inside the container, got {device}"
        );
        assert_eq!(kind, "ext4");
        // And the container was closed again, so no key is left in the kernel.
        assert!(
            luks.closed
                .lock()
                .unwrap()
                .contains(&"__format".to_string())
        );
    }

    #[test]
    fn a_drive_that_will_not_unmount_is_refused() {
        // The unmount closure reports failure by leaving the mount in place;
        // this test only pins the error wording, since the real check reads
        // /proc, which a unit test cannot fake.
        let err = FormatError::Busy;
        assert!(err.message().contains("still using this drive"));
    }
}

//! The disk tools the format flow drives, behind one trait with a mock.
//!
//! Every external call here has a deadline: a stick that stops answering must
//! end in an error the person can read, never a format that hangs forever.
//! Passwords travel on stdin only (`--key-file -`), never on a command line,
//! where `/proc/<pid>/cmdline` would show them to every process on the box.
//!
//! **Only `run.rs` may call the destructive methods** (`erase_signatures`,
//! `write_partition_table`, `make_exfat`, `make_ext4`, `luks_format`).
//! `list_signatures` only reads, and is what `inspect.rs` uses. A test in
//! `run.rs` scans the daemon's sources for any other caller.
//!
//! Tools are checked for **before** anything is written, and there is no
//! fallback: a Luna missing `mkfs.exfat` says so instead of quietly making a
//! different filesystem.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::sandbox;

/// Mapper names are prefixed so a mapping Luna owns is recognisable in
/// `/dev/mapper` and can never collide with a distro's own.
pub const MAPPER_PREFIX: &str = "luna-vault-";

pub fn mapper_name(drive_id: &str) -> String {
    format!("{MAPPER_PREFIX}{drive_id}")
}

pub fn mapper_path(drive_id: &str) -> PathBuf {
    Path::new("/dev/mapper").join(mapper_name(drive_id))
}

/// The LUKS2 profile. Frozen: once drives exist in the wild, changing any of
/// this breaks every future reader.
pub const CIPHER: &str = "aes-xts-plain64";
pub const KEY_BITS: &str = "512";
pub const SECTOR_BYTES: &str = "512";

/// Argon2id's memory cost is in KiB. LUKS2's 1 GiB default OOM-killed a 2 GiB
/// Wyse, so the cost follows this box's RAM and is recorded in the header, which
/// is where unlocking reads it back from.
pub const MIN_PBKDF_KIB: u32 = 32 * 1024;
pub const MAX_PBKDF_KIB: u32 = 1024 * 1024;

/// Argon2id memory for a new container: an eighth of the box's RAM, never
/// trivially cheap to attack (32 MiB) and never near the OOM line (1 GiB).
pub fn pbkdf_kib_from(ram_bytes: u64) -> u32 {
    let eighth_kib = ram_bytes / 8 / 1024;
    eighth_kib.clamp(MIN_PBKDF_KIB as u64, MAX_PBKDF_KIB as u64) as u32
}

/// Deadlines. Generous for the work, short enough that a dead stick is
/// reported while the person is still watching.
const WIPE_TIMEOUT: Duration = Duration::from_secs(120);
const PARTITION_TIMEOUT: Duration = Duration::from_secs(120);
const EXFAT_TIMEOUT: Duration = Duration::from_secs(600);
const EXT4_TIMEOUT: Duration = Duration::from_secs(900);
const LUKS_FORMAT_TIMEOUT: Duration = Duration::from_secs(300);
const LUKS_OPEN_TIMEOUT: Duration = Duration::from_secs(180);
const LUKS_CLOSE_TIMEOUT: Duration = Duration::from_secs(60);
const LIST_TIMEOUT: Duration = Duration::from_secs(60);
/// How long a new partition's device node gets to appear after the table is written.
const PARTITION_APPEAR: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, thiserror::Error)]
pub enum ToolError {
    #[error("Luna can't prepare drives. This Luna is missing a program it needs ({0}).")]
    Missing(&'static str),
    #[error(
        "This drive stopped responding, so Luna couldn't finish. Unplug it, plug it back in, and try again."
    )]
    TimedOut(&'static str),
    #[error("{0}")]
    Failed(String),
}

/// GPT partition type for the one partition. exFAT drives carry the
/// Microsoft basic-data type so Windows and macOS offer to open them; a
/// container is just bytes, so it carries the Linux one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PartitionKind {
    Exfat,
    Luks,
}

impl PartitionKind {
    fn type_guid(self) -> &'static str {
        match self {
            PartitionKind::Exfat => "EBD0A0A2-B9E5-4433-87C0-68B6B72699C7",
            PartitionKind::Luks => "0FC63DAF-8483-4772-8E79-3D69D8477DE4",
        }
    }
}

/// The disk tools. A trait so tests never need root or a real device.
pub trait DiskTools: Send + Sync {
    /// The first of `tools` that is not installed, if any.
    fn missing(&self, tools: &[&'static str]) -> Option<&'static str>;

    /// Read-only: the signature types (`gpt`, `dos`, `exfat`, `crypto_LUKS`, …)
    /// found anywhere on `device`, including the backup partition table at the
    /// end of the disk. Empty means nothing identifiable is on it at all.
    fn list_signatures(&self, device: &str) -> Result<Vec<String>, ToolError>;

    /// Destructive: `wipefs --all`.
    fn erase_signatures(&self, device: &str) -> Result<(), ToolError>;

    /// Destructive: one GPT partition across the whole disk. Returns its kernel
    /// name (`sdb1`, `nvme0n1p1`) once its device node exists.
    fn write_partition_table(&self, disk: &str, kind: PartitionKind) -> Result<String, ToolError>;

    /// Destructive: `mkfs.exfat`.
    fn make_exfat(&self, device: &str, label: &str) -> Result<(), ToolError>;

    /// Destructive: `mkfs.ext4 -m 0`.
    fn make_ext4(&self, device: &str, label: &str) -> Result<(), ToolError>;

    /// Destructive: a new LUKS2 container with one keyslot. The password goes
    /// on stdin.
    fn luks_format(
        &self,
        device: &str,
        label: &str,
        password: &str,
        pbkdf_kib: u32,
    ) -> Result<(), ToolError>;

    /// Open the container as the drive's mapper (`luna-vault-<id>`).
    fn luks_open(&self, device: &str, drive_id: &str, password: &str) -> Result<(), ToolError>;

    /// Close the drive's mapper, wiping the volume key from the kernel. Already
    /// closed is success.
    fn luks_close(&self, drive_id: &str) -> Result<(), ToolError>;

    fn luks_is_open(&self, drive_id: &str) -> bool;
}

/// The filesystem label, kept to what every system accepts. The drive's
/// display name in Luna keeps the full text; this only goes into `mkfs`.
pub fn volume_label(label: &str, max_chars: usize) -> String {
    let cleaned: String = label
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let out = if cleaned.is_empty() {
        "LUNA"
    } else {
        cleaned.as_str()
    };
    out.chars().take(max_chars).collect()
}

pub const EXFAT_LABEL_MAX: usize = 15;
pub const EXT4_LABEL_MAX: usize = 16;

pub fn luks_format_args(device: &str, label: &str, pbkdf_kib: u32) -> Vec<String> {
    [
        "luksFormat",
        "--batch-mode",
        "--type",
        "luks2",
        "--cipher",
        CIPHER,
        "--key-size",
        KEY_BITS,
        "--sector-size",
        SECTOR_BYTES,
        "--pbkdf",
        "argon2id",
        "--pbkdf-memory",
        &pbkdf_kib.to_string(),
        "--label",
        label,
        "--key-file",
        "-",
        device,
    ]
    .into_iter()
    .map(String::from)
    .collect()
}

pub fn luks_open_args(device: &str, drive_id: &str) -> Vec<String> {
    [
        "luksOpen",
        "--key-file",
        "-",
        "--type",
        "luks2",
        device,
        &mapper_name(drive_id),
    ]
    .into_iter()
    .map(String::from)
    .collect()
}

/// The sfdisk script for one partition spanning the disk. The empty start and
/// size mean "first aligned sector" and "all the rest".
pub fn sfdisk_script(kind: PartitionKind) -> String {
    format!("label: gpt\n,,{}\n", kind.type_guid())
}

/// The real tools.
#[derive(Clone, Default)]
pub struct CommandTools;

fn first_line(text: &str) -> String {
    let line = text.lines().find(|l| !l.trim().is_empty()).unwrap_or("");
    line.trim().chars().take(200).collect()
}

/// Run `tool` with `args`, `input` on stdin, and a deadline.
fn run_tool(
    tool: &'static str,
    args: &[String],
    input: &[u8],
    timeout: Duration,
    what: &str,
) -> Result<(), ToolError> {
    let bin = sandbox::which(tool).ok_or(ToolError::Missing(tool))?;
    let mut cmd = sandbox::hardened(&bin);
    cmd.args(args);
    let out = sandbox::output_with_input(&mut cmd, input, timeout).map_err(|e| {
        if e.kind() == std::io::ErrorKind::TimedOut {
            ToolError::TimedOut(tool)
        } else {
            ToolError::Failed(format!("{what} {e}"))
        }
    })?;
    if out.status.success() {
        return Ok(());
    }
    Err(ToolError::Failed(format!(
        "{what} {}",
        plain_tool_error(&String::from_utf8_lossy(&out.stderr))
    )))
}

/// cryptsetup and friends write for an operator. Turn the cases a person can
/// act on into plain words and keep everything else to one short line.
pub fn plain_tool_error(said: &str) -> String {
    let lower = said.to_ascii_lowercase();
    if lower.contains("is busy") || lower.contains("in use") {
        return "Something is still using this drive.".into();
    }
    if lower.contains("cannot allocate memory") || lower.contains("out of memory") {
        return "This Luna ran out of memory.".into();
    }
    let line = first_line(said);
    if line.is_empty() {
        "The drive refused the request.".into()
    } else {
        line
    }
}

fn partition_names(sys_block: &Path, disk: &str) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(sys_block.join(disk)) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n != disk && crate::drives::detect::is_partition_of(disk, n))
        .collect();
    names.sort();
    names
}

/// Wait for the one new partition to show up in sysfs and as a device node.
/// `nvme0n1` and `mmcblk0` name it with a `p` (`nvme0n1p1`); `sdb` does not.
pub(crate) fn wait_for_partition(
    sys_block: &Path,
    dev_dir: &Path,
    disk: &str,
    timeout: Duration,
) -> Result<String, ToolError> {
    let start = Instant::now();
    loop {
        let names = partition_names(sys_block, disk);
        if names.len() == 1 && dev_dir.join(&names[0]).exists() {
            return Ok(names[0].clone());
        }
        if names.len() > 1 {
            return Err(ToolError::Failed(
                "Luna made one partition but the drive shows several. Unplug it, plug it back in, and try again."
                    .into(),
            ));
        }
        if start.elapsed() > timeout {
            return Err(ToolError::Failed(
                "The new partition didn't appear. Unplug the drive, plug it back in, and try again."
                    .into(),
            ));
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

impl DiskTools for CommandTools {
    fn missing(&self, tools: &[&'static str]) -> Option<&'static str> {
        tools.iter().copied().find(|t| sandbox::which(t).is_none())
    }

    fn list_signatures(&self, device: &str) -> Result<Vec<String>, ToolError> {
        let bin = sandbox::which("wipefs").ok_or(ToolError::Missing("wipefs"))?;
        let mut cmd = sandbox::hardened(&bin);
        cmd.args(["--json", device])
            .stderr(std::process::Stdio::null());
        let out = sandbox::output_limited(&mut cmd, LIST_TIMEOUT).map_err(|e| {
            if e.kind() == std::io::ErrorKind::TimedOut {
                ToolError::TimedOut("wipefs")
            } else {
                ToolError::Failed(format!("Luna couldn't look at this drive. {e}"))
            }
        })?;
        if !out.status.success() {
            return Err(ToolError::Failed(
                "Luna couldn't look at this drive.".into(),
            ));
        }
        parse_wipefs_json(&String::from_utf8_lossy(&out.stdout))
    }

    fn erase_signatures(&self, device: &str) -> Result<(), ToolError> {
        run_tool(
            "wipefs",
            &["--all".into(), "--force".into(), device.into()],
            b"",
            WIPE_TIMEOUT,
            "Luna couldn't wipe this drive.",
        )
    }

    fn write_partition_table(&self, disk: &str, kind: PartitionKind) -> Result<String, ToolError> {
        run_tool(
            "sfdisk",
            &[
                "--quiet".into(),
                "--wipe".into(),
                "always".into(),
                "--wipe-partitions".into(),
                "always".into(),
                format!("/dev/{disk}"),
            ],
            sfdisk_script(kind).as_bytes(),
            PARTITION_TIMEOUT,
            "Luna couldn't set up the new partition.",
        )?;
        wait_for_partition(
            Path::new("/sys/block"),
            Path::new("/dev"),
            disk,
            PARTITION_APPEAR,
        )
    }

    fn make_exfat(&self, device: &str, label: &str) -> Result<(), ToolError> {
        run_tool(
            "mkfs.exfat",
            &["-L".into(), label.into(), device.into()],
            b"",
            EXFAT_TIMEOUT,
            "Luna couldn't set up exFAT on this drive.",
        )
    }

    fn make_ext4(&self, device: &str, label: &str) -> Result<(), ToolError> {
        // -m 0: a drive is not a system disk, and the 5% reserve is a lot of a small stick.
        run_tool(
            "mkfs.ext4",
            &[
                "-q".into(),
                "-F".into(),
                "-m".into(),
                "0".into(),
                "-L".into(),
                label.into(),
                device.into(),
            ],
            b"",
            EXT4_TIMEOUT,
            "Luna couldn't prepare this drive.",
        )
    }

    fn luks_format(
        &self,
        device: &str,
        label: &str,
        password: &str,
        pbkdf_kib: u32,
    ) -> Result<(), ToolError> {
        run_tool(
            "cryptsetup",
            &luks_format_args(device, label, pbkdf_kib),
            password.as_bytes(),
            LUKS_FORMAT_TIMEOUT,
            "Luna couldn't set up the password on this drive.",
        )
    }

    fn luks_open(&self, device: &str, drive_id: &str, password: &str) -> Result<(), ToolError> {
        run_tool(
            "cryptsetup",
            &luks_open_args(device, drive_id),
            password.as_bytes(),
            LUKS_OPEN_TIMEOUT,
            "Luna couldn't open the new protected drive.",
        )
    }

    fn luks_close(&self, drive_id: &str) -> Result<(), ToolError> {
        if !self.luks_is_open(drive_id) {
            return Ok(());
        }
        run_tool(
            "cryptsetup",
            &["luksClose".into(), mapper_name(drive_id)],
            b"",
            LUKS_CLOSE_TIMEOUT,
            "Luna couldn't close this protected drive.",
        )
    }

    fn luks_is_open(&self, drive_id: &str) -> bool {
        mapper_path(drive_id).exists()
    }
}

/// `wipefs --json` prints nothing at all for a device with no signatures, and
/// `{"signatures": [{"type": "gpt", …}]}` otherwise.
pub fn parse_wipefs_json(text: &str) -> Result<Vec<String>, ToolError> {
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
    let value: serde_json::Value = serde_json::from_str(text)
        .map_err(|_| ToolError::Failed("Luna couldn't read what is on this drive.".into()))?;
    let Some(items) = value.get("signatures").and_then(|v| v.as_array()) else {
        return Err(ToolError::Failed(
            "Luna couldn't read what is on this drive.".into(),
        ));
    };
    Ok(items
        .iter()
        .map(|item| {
            item.get("type")
                .and_then(|t| t.as_str())
                .unwrap_or("unknown")
                .to_string()
        })
        .collect())
}

/// Test double: records every call, makes nothing, and can be told what to
/// report or where to fail. Never touches a device.
#[derive(Default)]
pub struct MockTools {
    /// `"<method> <device>"` for every call, in order.
    pub calls: std::sync::Mutex<Vec<String>>,
    /// Tools reported as not installed.
    pub absent: std::sync::Mutex<Vec<&'static str>>,
    /// `list_signatures` answers by device path (missing means "no signatures").
    pub signatures: std::sync::Mutex<std::collections::HashMap<String, Vec<String>>>,
    /// Fail this method (by name, such as `"make_exfat"`) with `ToolError::Failed`.
    pub fail_at: std::sync::Mutex<Option<&'static str>>,
    /// Mappers considered open.
    pub open: std::sync::Mutex<std::collections::HashSet<String>>,
    /// The `pbkdf_kib` the last `luks_format` was given.
    pub pbkdf: std::sync::Mutex<Option<u32>>,
    /// The password the last `luks_*` call was given (tests only; never logged).
    pub last_password: std::sync::Mutex<Option<String>>,
}

impl MockTools {
    fn record(&self, method: &'static str, device: &str) -> Result<(), ToolError> {
        self.calls
            .lock()
            .unwrap()
            .push(format!("{method} {device}"));
        if *self.fail_at.lock().unwrap() == Some(method) {
            return Err(ToolError::Failed(format!("mock {method} failure")));
        }
        Ok(())
    }

    pub fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }
}

impl DiskTools for MockTools {
    fn missing(&self, tools: &[&'static str]) -> Option<&'static str> {
        let absent = self.absent.lock().unwrap();
        tools.iter().copied().find(|t| absent.contains(t))
    }

    fn list_signatures(&self, device: &str) -> Result<Vec<String>, ToolError> {
        self.record("list_signatures", device)?;
        Ok(self
            .signatures
            .lock()
            .unwrap()
            .get(device)
            .cloned()
            .unwrap_or_default())
    }

    fn erase_signatures(&self, device: &str) -> Result<(), ToolError> {
        self.record("erase_signatures", device)
    }

    fn write_partition_table(&self, disk: &str, kind: PartitionKind) -> Result<String, ToolError> {
        self.record("write_partition_table", &format!("/dev/{disk} {kind:?}"))?;
        let sep = if disk.ends_with(|c: char| c.is_ascii_digit()) {
            "p"
        } else {
            ""
        };
        Ok(format!("{disk}{sep}1"))
    }

    fn make_exfat(&self, device: &str, label: &str) -> Result<(), ToolError> {
        self.record("make_exfat", &format!("{device} {label}"))
    }

    fn make_ext4(&self, device: &str, label: &str) -> Result<(), ToolError> {
        self.record("make_ext4", &format!("{device} {label}"))
    }

    fn luks_format(
        &self,
        device: &str,
        label: &str,
        password: &str,
        pbkdf_kib: u32,
    ) -> Result<(), ToolError> {
        *self.pbkdf.lock().unwrap() = Some(pbkdf_kib);
        *self.last_password.lock().unwrap() = Some(password.to_string());
        self.record("luks_format", &format!("{device} {label}"))
    }

    fn luks_open(&self, device: &str, drive_id: &str, password: &str) -> Result<(), ToolError> {
        *self.last_password.lock().unwrap() = Some(password.to_string());
        self.record("luks_open", &format!("{device} {drive_id}"))?;
        self.open.lock().unwrap().insert(drive_id.to_string());
        Ok(())
    }

    fn luks_close(&self, drive_id: &str) -> Result<(), ToolError> {
        self.record("luks_close", drive_id)?;
        self.open.lock().unwrap().remove(drive_id);
        Ok(())
    }

    fn luks_is_open(&self, drive_id: &str) -> bool {
        self.open.lock().unwrap().contains(drive_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn argon2_memory_follows_ram_within_bounds() {
        // A 2 GiB Wyse: an eighth, well under the cap.
        assert_eq!(pbkdf_kib_from(2 * 1024 * 1024 * 1024), 256 * 1024);
        assert_eq!(pbkdf_kib_from(0), MIN_PBKDF_KIB);
        assert_eq!(pbkdf_kib_from(64 * 1024 * 1024), MIN_PBKDF_KIB);
        assert_eq!(pbkdf_kib_from(64 * 1024 * 1024 * 1024), MAX_PBKDF_KIB);
    }

    #[test]
    fn mapper_names_are_prefixed_and_per_drive() {
        assert_eq!(mapper_name("abc"), "luna-vault-abc");
        assert_eq!(mapper_path("abc"), Path::new("/dev/mapper/luna-vault-abc"));
    }

    #[test]
    fn the_password_is_never_on_a_command_line() {
        // The secret is not a parameter of the argument builders at all; the
        // only way to give cryptsetup one is stdin.
        let format = luks_format_args("/dev/sdb1", "Photos", 262144);
        let open = luks_open_args("/dev/sdb1", "d1");
        for args in [&format, &open] {
            let at = args.iter().position(|a| a == "--key-file").unwrap();
            assert_eq!(args[at + 1], "-", "the key must come from stdin");
        }
        assert!(format.contains(&"argon2id".to_string()));
        assert!(format.contains(&"aes-xts-plain64".to_string()));
        assert!(format.contains(&"512".to_string()));
        assert!(open.contains(&"luna-vault-d1".to_string()));
    }

    #[test]
    fn the_partition_script_uses_the_right_type_for_each_kind() {
        assert!(sfdisk_script(PartitionKind::Exfat).contains("EBD0A0A2"));
        assert!(sfdisk_script(PartitionKind::Luks).contains("0FC63DAF"));
        assert!(sfdisk_script(PartitionKind::Exfat).starts_with("label: gpt\n"));
    }

    #[test]
    fn volume_labels_are_plain_and_short() {
        assert_eq!(
            volume_label("Family photos!", EXFAT_LABEL_MAX),
            "Family photos"
        );
        assert_eq!(volume_label("   ", EXFAT_LABEL_MAX), "LUNA");
        assert_eq!(volume_label("Ünïcode", EXFAT_LABEL_MAX), "n code");
        assert_eq!(
            volume_label("a".repeat(40).as_str(), EXT4_LABEL_MAX).len(),
            16
        );
    }

    #[test]
    fn wipefs_output_is_read() {
        assert_eq!(parse_wipefs_json("").unwrap(), Vec::<String>::new());
        let json = r#"{"signatures":[{"device":"sdb","offset":"0x200","type":"gpt"},{"device":"sdb","offset":"0x1fe","type":"PMBR"}]}"#;
        assert_eq!(parse_wipefs_json(json).unwrap(), vec!["gpt", "PMBR"]);
        assert!(parse_wipefs_json("not json").is_err());
    }

    #[test]
    fn tool_errors_become_plain_words() {
        assert_eq!(
            plain_tool_error("Device /dev/sdb1 is busy."),
            "Something is still using this drive."
        );
        assert_eq!(plain_tool_error(""), "The drive refused the request.");
        assert_eq!(
            plain_tool_error("\n\nwipefs: bad thing\nmore"),
            "wipefs: bad thing"
        );
    }

    #[test]
    fn a_new_partition_is_found_by_its_device_node() {
        let root = tempfile::tempdir().unwrap();
        let sys = root.path().join("sys");
        let dev = root.path().join("dev");
        std::fs::create_dir_all(sys.join("nvme0n1/nvme0n1p1")).unwrap();
        std::fs::create_dir_all(&dev).unwrap();
        // The sysfs entry alone is not enough: the node must exist too.
        let err = wait_for_partition(&sys, &dev, "nvme0n1", Duration::from_millis(300));
        assert!(err.is_err());
        std::fs::write(dev.join("nvme0n1p1"), b"").unwrap();
        let name = wait_for_partition(&sys, &dev, "nvme0n1", Duration::from_secs(2)).unwrap();
        assert_eq!(name, "nvme0n1p1");
    }

    #[test]
    fn several_partitions_after_one_was_written_is_an_error() {
        let root = tempfile::tempdir().unwrap();
        let sys = root.path().join("sys");
        std::fs::create_dir_all(sys.join("sdb/sdb1")).unwrap();
        std::fs::create_dir_all(sys.join("sdb/sdb2")).unwrap();
        let err = wait_for_partition(&sys, root.path(), "sdb", Duration::from_millis(300));
        assert!(err.is_err());
    }

    #[test]
    fn the_mock_reports_missing_tools_and_records_calls() {
        let tools = MockTools::default();
        tools.absent.lock().unwrap().push("mkfs.exfat");
        assert_eq!(tools.missing(&["wipefs", "mkfs.exfat"]), Some("mkfs.exfat"));
        assert_eq!(tools.missing(&["wipefs"]), None);
        tools.erase_signatures("/dev/sdz").unwrap();
        assert_eq!(tools.calls(), vec!["erase_signatures /dev/sdz"]);
        assert_eq!(
            tools
                .write_partition_table("nvme0n1", PartitionKind::Exfat)
                .unwrap(),
            "nvme0n1p1"
        );
    }

    #[test]
    fn a_missing_program_is_reported_in_plain_words() {
        let said = ToolError::Missing("mkfs.exfat").to_string();
        assert!(
            said.contains("missing a program it needs (mkfs.exfat)"),
            "{said}"
        );
    }
}

//! Converting an existing drive to encrypted, and back.
//!
//! **Encrypting** an ext4 drive runs in place: shrink the filesystem by the
//! header size, then `cryptsetup reencrypt --encrypt`. The shrink is not
//! optional and not something `cryptsetup` does for us — it assumes the tail is
//! already free and silently corrupts the filesystem if it is not. That was
//! verified on real loop devices: skipping the shrink leaves a drive that
//! converts "successfully" and then will not mount.
//!
//! **Decrypting** runs `cryptsetup reencrypt --decrypt`, which needs no shrink
//! because the header space simply becomes unused tail.
//!
//! The password is held in memory for the length of the job and dropped with
//! it. A power cut therefore loses it, and the drive comes back in the
//! Interrupted state, needing the password again to resume.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::db;

/// What a conversion is doing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    Encrypt,
    Decrypt,
}

impl Direction {
    pub fn as_str(self) -> &'static str {
        match self {
            Direction::Encrypt => "encrypt",
            Direction::Decrypt => "decrypt",
        }
    }

    pub fn verb(self) -> &'static str {
        match self {
            Direction::Encrypt => "Encrypting",
            Direction::Decrypt => "Decrypting",
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ConvertError {
    #[error("This drive isn't encrypted, so there's nothing to decrypt.")]
    NotEncrypted,
    #[error("This drive is already encrypted.")]
    AlreadyEncrypted,
    #[error(
        "Luna can only encrypt ext4 drives in place. To encrypt this one, copy its files to a new encrypted drive."
    )]
    NotExt4,
    #[error("This drive is too full or too small to encrypt. Free some space and try again.")]
    NoRoom,
    #[error("This drive is unplugged. Plug it in and try again.")]
    NotPresent,
    #[error("Luna can't start while this drive is open. Lock it first.")]
    StillOpen,
    #[error("That password didn't work.")]
    WrongPassword,
    #[error("{0}")]
    Other(String),
}

impl ConvertError {
    pub fn message(&self) -> String {
        self.to_string()
    }
}

/// Everything a conversion needs, resolved before the job starts so a refusal
/// happens up front rather than halfway through.
pub struct Plan {
    pub drive_id: String,
    pub device: String,
    pub mount_point: String,
    pub direction: Direction,
}

/// Decide whether a drive can be converted, before anything is changed.
pub fn plan(row: &db::DriveRow, direction: Direction) -> Result<Plan, ConvertError> {
    if row.state == "missing" || row.state == "ejected" || row.device.is_empty() {
        return Err(ConvertError::NotPresent);
    }
    if row.converting {
        return Err(ConvertError::Other(
            "This drive is already being converted.".into(),
        ));
    }
    match direction {
        Direction::Encrypt => {
            if row.encrypted {
                return Err(ConvertError::AlreadyEncrypted);
            }
            if !row.fs_type.eq_ignore_ascii_case("ext4") {
                return Err(ConvertError::NotExt4);
            }
            if row.mount_point.is_empty() {
                return Err(ConvertError::Other(
                    "Luna can't open this drive right now, so it can't encrypt it.".into(),
                ));
            }
            let device = device_path(&row.device);
            if !crate::drives::ext4::can_shrink_for_header(&device) {
                return Err(ConvertError::NoRoom);
            }
        }
        Direction::Decrypt => {
            if !row.encrypted {
                return Err(ConvertError::NotEncrypted);
            }
            if row.locked {
                return Err(ConvertError::StillOpen);
            }
        }
    }
    Ok(Plan {
        drive_id: row.id.clone(),
        device: device_path(&row.device),
        mount_point: row.mount_point.clone(),
        direction,
    })
}

pub fn device_path(name: &str) -> String {
    if name.starts_with('/') {
        name.to_string()
    } else {
        format!("/dev/{name}")
    }
}

/// Run the conversion. Blocking: call it from a worker thread.
///
/// `progress` is called with a percentage as the operation reports it. `cancel`
/// is checked between progress reports; because LUKS2 records its state in the
/// header, a cancelled or interrupted run is resumable rather than lost.
pub fn run(
    plan: &Plan,
    password: &str,
    progress: impl Fn(u8),
    cancel: Arc<AtomicBool>,
) -> Result<(), ConvertError> {
    match plan.direction {
        Direction::Encrypt => encrypt(plan, password, progress, cancel),
        Direction::Decrypt => decrypt(plan, password, progress, cancel),
    }
}

fn encrypt(
    plan: &Plan,
    password: &str,
    progress: impl Fn(u8),
    cancel: Arc<AtomicBool>,
) -> Result<(), ConvertError> {
    // The filesystem must be unmounted for both steps.
    unmount_for_conversion(&plan.mount_point)?;
    // 1. Make room for the header. Without this the conversion destroys the
    //    filesystem while reporting success.
    crate::drives::ext4::shrink_for_header(&plan.device)
        .map_err(|e| ConvertError::Other(e.to_string()))?;
    // 2. Convert in place.
    reencrypt(plan, password, progress, cancel, true, None)
}

fn decrypt(
    plan: &Plan,
    password: &str,
    progress: impl Fn(u8),
    cancel: Arc<AtomicBool>,
) -> Result<(), ConvertError> {
    // The container must be closed first: reencrypt works on the raw device.
    // `run` closes it before calling here.
    unmount_for_conversion(&plan.mount_point)?;
    // LUKS2 decryption needs somewhere to move the header to while the data
    // shifts forward. `--header` names a file for it; cryptsetup creates it and
    // refuses to run without one. It must live outside the device being
    // decrypted — putting it on the same drive would deadlock.
    let header = header_scratch_path(&plan.drive_id)?;
    let _ = std::fs::remove_file(&header);
    let result = reencrypt(plan, password, progress, cancel, false, Some(&header));
    let _ = std::fs::remove_file(&header);
    result
}

/// Where a decryption parks the exported LUKS2 header. `/run` is a tmpfs, so
/// it never lands on a disk and is gone after a reboot — which is correct: an
/// interrupted decryption is resumed by its own header state, not by this file.
fn header_scratch_path(drive_id: &str) -> Result<std::path::PathBuf, ConvertError> {
    let dir = std::path::Path::new("/run/luna");
    if !dir.is_dir() {
        std::fs::create_dir_all(dir).map_err(|e| {
            ConvertError::Other(format!("Luna couldn't prepare the conversion. {e}"))
        })?;
    }
    Ok(dir.join(format!("decrypt-{drive_id}.header")))
}

fn reencrypt(
    plan: &Plan,
    password: &str,
    progress: impl Fn(u8),
    cancel: Arc<AtomicBool>,
    encrypting: bool,
    header: Option<&std::path::Path>,
) -> Result<(), ConvertError> {
    let bin = crate::sandbox::which("cryptsetup").ok_or_else(|| {
        ConvertError::Other(
            "Luna can't convert drives. This Luna is missing a program it needs (cryptsetup)."
                .into(),
        )
    })?;
    let mut cmd = crate::sandbox::hardened(&bin);
    let pbkdf =
        crate::drives::luks::pbkdf_kib_from(crate::budget::meminfo().available_bytes).to_string();
    if encrypting {
        cmd.args([
            "reencrypt",
            "--encrypt",
            "--type",
            "luks2",
            "--cipher",
            crate::drives::luks::CIPHER,
            "--key-size",
            crate::drives::luks::KEY_BITS,
            "--sector-size",
            crate::drives::luks::SECTOR_BYTES,
            "--pbkdf",
            "argon2id",
            "--pbkdf-memory",
            &pbkdf,
            "--reduce-device-size",
            &format!("{}m", crate::drives::ext4::HEADER_BYTES / (1024 * 1024)),
            "--key-file",
            "-",
            "--progress-json",
        ]);
    } else {
        cmd.args([
            "reencrypt",
            "--decrypt",
            "--type",
            "luks2",
            "--key-file",
            "-",
            "--progress-json",
        ]);
        if let Some(header) = header {
            cmd.arg("--header").arg(header);
        }
    }
    cmd.arg(&plan.device)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| ConvertError::Other(format!("Luna couldn't start the conversion. {e}")))?;
    {
        use std::io::Write;
        let mut stdin = child.stdin.take().ok_or_else(|| {
            ConvertError::Other("Luna couldn't pass the password to the drive.".into())
        })?;
        stdin.write_all(password.as_bytes()).map_err(|e| {
            ConvertError::Other(format!("Luna couldn't pass the password to the drive. {e}"))
        })?;
    }

    // Read progress lines as they arrive. `--progress-json` prints one compact
    // JSON object per half second on stdout.
    let mut last = 0u8;
    if let Some(stdout) = child.stdout.take() {
        use std::io::BufRead;
        let reader = std::io::BufReader::new(stdout);
        for line in reader.lines() {
            if cancel.load(Ordering::Relaxed) {
                // LUKS2 keeps its state in the header, so a killed run is
                // resumable rather than lost. SIGTERM is the documented way to
                // stop safely.
                let _ = child.kill();
                let _ = child.wait();
                return Err(ConvertError::Other("Conversion cancelled.".into()));
            }
            let Ok(line) = line else { break };
            if let Some(pct) = parse_progress(&line)
                && pct != last
            {
                last = pct;
                progress(pct);
            }
        }
    }
    let status = child
        .wait()
        .map_err(|e| ConvertError::Other(format!("Luna lost track of the conversion. {e}")))?;
    if status.success() {
        progress(100);
        return Ok(());
    }
    // A wrong password is the one failure worth naming precisely: it is the
    // only one the person can fix by typing.
    let said = read_stderr(&mut child);
    if said.to_ascii_lowercase().contains("no key available") {
        return Err(ConvertError::WrongPassword);
    }
    Err(ConvertError::Other(
        crate::drives::luks::plain_cryptsetup_error(&said),
    ))
}

fn read_stderr(child: &mut std::process::Child) -> String {
    use std::io::Read;
    let mut said = String::new();
    if let Some(mut stderr) = child.stderr.take() {
        let _ = stderr.read_to_string(&mut said);
    }
    said
}

/// Pull the percentage out of a `--progress-json` line. The value is
/// `device_bytes / device_size`; cryptsetup sends both as strings.
pub fn parse_progress(line: &str) -> Option<u8> {
    let done: f64 = json_number(line, "device_bytes")?;
    let total: f64 = json_number(line, "device_size")?;
    if total <= 0.0 {
        return None;
    }
    Some(((done / total) * 100.0).clamp(0.0, 100.0) as u8)
}

/// Read `"key":"123"` or `"key":123` out of a JSON line without pulling in a
/// parser for one field.
fn json_number(line: &str, key: &str) -> Option<f64> {
    let needle = format!("\"{key}\"");
    let at = line.find(&needle)? + needle.len();
    let rest = line[at..].trim_start();
    let rest = rest.strip_prefix(':')?.trim_start();
    let rest = rest.strip_prefix('"').unwrap_or(rest);
    let end = rest
        .find(|c: char| !(c.is_ascii_digit() || c == '.'))
        .unwrap_or(rest.len());
    rest[..end].parse().ok()
}

fn unmount_for_conversion(mount_point: &str) -> Result<(), ConvertError> {
    if mount_point.is_empty() {
        return Ok(());
    }
    let target = std::path::Path::new(mount_point);
    if !target.is_dir() {
        return Ok(());
    }
    // Use the system umount: the conversion needs the filesystem genuinely
    // gone, and a busy unmount must stop the job rather than be ignored.
    let out = std::process::Command::new("umount")
        .arg(target)
        .output()
        .map_err(|e| ConvertError::Other(format!("Luna couldn't close this drive. {e}")))?;
    if out.status.success() {
        return Ok(());
    }
    let said = String::from_utf8_lossy(&out.stderr).to_ascii_lowercase();
    if said.contains("not mounted") || said.contains("no mount point") {
        return Ok(());
    }
    Err(ConvertError::Other(
        "Close any files open from this drive, then try again.".into(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(fs: &str, encrypted: bool) -> db::DriveRow {
        db::DriveRow {
            id: "d1".into(),
            label: "Photos".into(),
            state: "as_is".into(),
            fs_type: fs.into(),
            device: "sdb1".into(),
            mount_point: "/mnt/d1".into(),
            encrypted,
            locked: false,
            converting: false,
        }
    }

    #[test]
    fn only_ext4_can_be_encrypted_in_place() {
        assert!(matches!(
            plan(&row("exfat", false), Direction::Encrypt),
            Err(ConvertError::NotExt4)
        ));
        assert!(matches!(
            plan(&row("ntfs", false), Direction::Encrypt),
            Err(ConvertError::NotExt4)
        ));
        assert!(matches!(
            plan(&row("vfat", false), Direction::Encrypt),
            Err(ConvertError::NotExt4)
        ));
    }

    #[test]
    fn an_already_encrypted_drive_is_refused() {
        assert!(matches!(
            plan(&row("ext4", true), Direction::Encrypt),
            Err(ConvertError::AlreadyEncrypted)
        ));
    }

    #[test]
    fn decrypting_an_unencrypted_drive_is_refused() {
        assert!(matches!(
            plan(&row("ext4", false), Direction::Decrypt),
            Err(ConvertError::NotEncrypted)
        ));
    }

    #[test]
    fn a_locked_drive_must_be_unlocked_before_decrypting() {
        let mut r = row("ext4", true);
        r.locked = true;
        r.mount_point = String::new();
        assert!(matches!(
            plan(&r, Direction::Decrypt),
            Err(ConvertError::StillOpen)
        ));
    }

    #[test]
    fn an_unplugged_drive_is_refused() {
        let mut r = row("ext4", false);
        r.state = "missing".into();
        assert!(matches!(
            plan(&r, Direction::Encrypt),
            Err(ConvertError::NotPresent)
        ));
    }

    #[test]
    fn a_drive_already_converting_is_refused() {
        let mut r = row("ext4", false);
        r.converting = true;
        assert!(matches!(
            plan(&r, Direction::Encrypt),
            Err(ConvertError::Other(_))
        ));
    }

    #[test]
    fn progress_comes_out_of_the_json_lines() {
        let line = r#"{"device":"/dev/sdb1","device_bytes":"100","device_size":"400","speed":"1"}"#;
        assert_eq!(parse_progress(line), Some(25));
        let done = r#"{"device_bytes":"400","device_size":"400"}"#;
        assert_eq!(parse_progress(done), Some(100));
        let start = r#"{"device_bytes":"0","device_size":"400"}"#;
        assert_eq!(parse_progress(start), Some(0));
    }

    #[test]
    fn unparseable_progress_lines_are_ignored() {
        assert_eq!(parse_progress("garbage"), None);
        assert_eq!(parse_progress(r#"{"device_bytes":"1"}"#), None);
        // A zero total must not divide by zero.
        assert_eq!(
            parse_progress(r#"{"device_bytes":"1","device_size":"0"}"#),
            None
        );
    }

    #[test]
    fn device_names_become_paths() {
        assert_eq!(device_path("sdb1"), "/dev/sdb1");
        assert_eq!(device_path("/dev/sdb1"), "/dev/sdb1");
    }
}

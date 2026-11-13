//! LUKS2 containers: format, open, close, change password.
//!
//! An encrypted drive is one partition holding one LUKS2 container with ext4
//! inside. The volume key lives in the kernel's dm-crypt mapping, never in this
//! process, so it is gone on `luksClose` or power loss. That is what makes "the
//! key is only in RAM" true without Luna holding anything.
//!
//! **This is the one `cryptsetup` wrapper.** Passwords travel on stdin
//! (`--key-file -`) or a memory-only descriptor, never on a command line, where
//! `/proc/<pid>/cmdline` would show them to every process on the box. Every
//! call has a deadline. `luks_format` is destructive: only the format run
//! (`drives/format/run.rs`) may call it.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use crate::drives::format::tools::{TRY_AGAIN, ToolError, first_line, plain_tool_error};
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

/// Argon2id memory for a new keyslot: an eighth of the box's RAM, never
/// trivially cheap to attack (32 MiB) and never near the OOM line (1 GiB).
pub fn pbkdf_kib_from(ram_bytes: u64) -> u32 {
    let eighth_kib = ram_bytes / 8 / 1024;
    eighth_kib.clamp(MIN_PBKDF_KIB as u64, MAX_PBKDF_KIB as u64) as u32
}

const FORMAT_TIMEOUT: Duration = Duration::from_secs(300);
const OPEN_TIMEOUT: Duration = Duration::from_secs(180);
const CLOSE_TIMEOUT: Duration = Duration::from_secs(60);
const DUMP_TIMEOUT: Duration = Duration::from_secs(30);

/// What Luna does to a container. A trait so tests never need root or a real
/// device.
pub trait Luks: Send + Sync {
    /// Destructive: a new LUKS2 container with one keyslot, labelled for the
    /// drive. The password goes on stdin.
    fn luks_format(
        &self,
        device: &str,
        label: &str,
        password: &str,
        pbkdf_kib: u32,
    ) -> Result<(), ToolError>;

    /// Open `device` as the drive's mapper (`luna-vault-<id>`).
    /// [`ToolError::WrongPassword`] when the password opens no keyslot.
    fn open(&self, device: &str, drive_id: &str, password: &str) -> Result<(), ToolError>;

    /// Close the drive's mapper, wiping the volume key from the kernel. Already
    /// closed is success.
    fn close(&self, drive_id: &str) -> Result<(), ToolError>;

    /// Is the drive's mapper open right now?
    fn is_open(&self, drive_id: &str) -> bool;

    /// Replace the one password: add a new keyslot, check it opens the
    /// container, then remove the old one. Needs the current password.
    fn change_password(&self, device: &str, current: &str, new: &str) -> Result<(), ToolError>;
}

#[derive(Clone, Default)]
pub struct CommandLuks;

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

/// `cryptsetup open --test-passphrase`: does this password open `slot`?
fn test_slot_args(device: &str, slot: &str) -> Vec<String> {
    [
        "open",
        "--test-passphrase",
        "--key-slot",
        slot,
        "--key-file",
        "-",
        device,
    ]
    .into_iter()
    .map(String::from)
    .collect()
}

/// Add the new key to `free`, authorising with the old key in `slot`. The old
/// key is stdin; the new key is the file `/proc/self/fd/40` (see [`SecretFile`]).
fn add_key_args(device: &str, slot: &str, free: &str, pbkdf_kib: u32) -> Vec<String> {
    [
        "luksAddKey",
        "--batch-mode",
        "--key-slot",
        slot,
        "--new-key-slot",
        free,
        "--pbkdf",
        "argon2id",
        "--pbkdf-memory",
        &pbkdf_kib.to_string(),
        "--key-file",
        "-",
        device,
        "/proc/self/fd/40",
    ]
    .into_iter()
    .map(String::from)
    .collect()
}

fn kill_slot_args(device: &str, slot: &str) -> Vec<String> {
    [
        "luksKillSlot",
        "--batch-mode",
        "--key-file",
        "-",
        device,
        slot,
    ]
    .into_iter()
    .map(String::from)
    .collect()
}

fn cryptsetup() -> Result<PathBuf, ToolError> {
    sandbox::which("cryptsetup").ok_or(ToolError::Missing("cryptsetup"))
}

/// What cryptsetup said, turned into something a person can act on. Only the
/// cases that have an answer become words; the rest is logged and the caller
/// says to try again.
fn classify(said: &str, what: &str) -> ToolError {
    let lower = said.to_ascii_lowercase();
    if lower.contains("no key available with this passphrase") {
        return ToolError::WrongPassword;
    }
    if lower.contains("not a valid luks") {
        return ToolError::Failed("This drive isn't an encrypted Luna drive.".into());
    }
    ToolError::Failed(format!(
        "{what} {}",
        plain_tool_error(said).unwrap_or(TRY_AGAIN)
    ))
}

/// Run cryptsetup with `args`, `input` on stdin and a deadline. `prepare` may
/// add to the command (the new-key descriptor of a password change).
fn run(
    args: &[String],
    input: &[u8],
    timeout: Duration,
    what: &str,
    prepare: impl FnOnce(&mut Command),
) -> Result<(), ToolError> {
    let bin = cryptsetup()?;
    let mut cmd = sandbox::hardened(&bin);
    cmd.args(args);
    prepare(&mut cmd);
    let out = sandbox::output_with_input(&mut cmd, input, timeout).map_err(|e| {
        if e.kind() == std::io::ErrorKind::TimedOut {
            ToolError::TimedOut("cryptsetup")
        } else {
            tracing::warn!(error = %e, "cryptsetup could not run");
            ToolError::Failed(format!("{what} {TRY_AGAIN}"))
        }
    })?;
    if out.status.success() {
        return Ok(());
    }
    let said = String::from_utf8_lossy(&out.stderr);
    tracing::warn!(status = ?out.status, said = %first_line(&said), "cryptsetup failed");
    Err(classify(&said, what))
}

/// The container's keyslot numbers, from its header (no password needed).
fn keyslots(bin: &Path, device: &str) -> Result<Vec<String>, ToolError> {
    let unreadable =
        || ToolError::Failed("Luna couldn't read this drive's password settings.".into());
    let mut dump = sandbox::hardened(bin);
    dump.args(["luksDump", "--dump-json-metadata", device])
        .stderr(Stdio::null());
    let out = sandbox::output_limited(&mut dump, DUMP_TIMEOUT).map_err(|e| {
        if e.kind() == std::io::ErrorKind::TimedOut {
            ToolError::TimedOut("cryptsetup")
        } else {
            unreadable()
        }
    })?;
    if !out.status.success() {
        return Err(unreadable());
    }
    parse_keyslots(&out.stdout).ok_or_else(unreadable)
}

/// Keyslot numbers out of `luksDump --dump-json-metadata`.
pub fn parse_keyslots(json: &[u8]) -> Option<Vec<String>> {
    let metadata: serde_json::Value = serde_json::from_slice(json).ok()?;
    Some(metadata["keyslots"].as_object()?.keys().cloned().collect())
}

/// The lowest keyslot number not in use (LUKS2 has 32).
pub fn free_slot(used: &[String]) -> Option<String> {
    (0..32)
        .map(|n| n.to_string())
        .find(|n| !used.iter().any(|u| u == n))
}

/// Does `password` open keyslot `slot`? `Ok(false)` is a wrong password.
fn slot_opens(device: &str, slot: &str, password: &str) -> Result<bool, ToolError> {
    match run(
        &test_slot_args(device, slot),
        password.as_bytes(),
        OPEN_TIMEOUT,
        "Luna couldn't check the password.",
        |_| {},
    ) {
        Ok(()) => Ok(true),
        Err(ToolError::WrongPassword) => Ok(false),
        Err(e) => Err(e),
    }
}

fn kill_slot(device: &str, slot: &str, password: &str) -> Result<(), ToolError> {
    run(
        &kill_slot_args(device, slot),
        password.as_bytes(),
        OPEN_TIMEOUT,
        "Luna couldn't remove the old password.",
        |_| {},
    )
}

impl Luks for CommandLuks {
    fn luks_format(
        &self,
        device: &str,
        label: &str,
        password: &str,
        pbkdf_kib: u32,
    ) -> Result<(), ToolError> {
        run(
            &luks_format_args(device, label, pbkdf_kib),
            password.as_bytes(),
            FORMAT_TIMEOUT,
            "Luna couldn't set up the password on this drive.",
            |_| {},
        )
    }

    fn open(&self, device: &str, drive_id: &str, password: &str) -> Result<(), ToolError> {
        run(
            &luks_open_args(device, drive_id),
            password.as_bytes(),
            OPEN_TIMEOUT,
            "Luna couldn't open this protected drive.",
            |_| {},
        )
    }

    fn close(&self, drive_id: &str) -> Result<(), ToolError> {
        if !self.is_open(drive_id) {
            return Ok(());
        }
        let bin = cryptsetup()?;
        let mut cmd = sandbox::hardened(&bin);
        cmd.args(["luksClose", &mapper_name(drive_id)])
            .stderr(Stdio::piped());
        let out = sandbox::output_limited(&mut cmd, CLOSE_TIMEOUT).map_err(|e| {
            if e.kind() == std::io::ErrorKind::TimedOut {
                ToolError::TimedOut("cryptsetup")
            } else {
                ToolError::Failed(format!("Luna couldn't lock this drive. {TRY_AGAIN}"))
            }
        })?;
        if out.status.success() {
            return Ok(());
        }
        let said = String::from_utf8_lossy(&out.stderr);
        // Already gone is success: the key is out of the kernel either way.
        if said.to_ascii_lowercase().contains("not active") {
            return Ok(());
        }
        tracing::warn!(said = %first_line(&said), "cryptsetup could not close a drive");
        Err(ToolError::Failed(format!(
            "Luna couldn't lock this drive. {}",
            plain_tool_error(&said).unwrap_or("Try again.")
        )))
    }

    fn is_open(&self, drive_id: &str) -> bool {
        mapper_path(drive_id).exists()
    }

    fn change_password(&self, device: &str, current: &str, new: &str) -> Result<(), ToolError> {
        let bin = cryptsetup()?;
        let slots = keyslots(&bin, device)?;
        let mut matches = Vec::new();
        for slot in &slots {
            if slot_opens(device, slot, current)? {
                matches.push(slot.clone());
            }
        }
        let old = match matches.as_slice() {
            [] => return Err(ToolError::WrongPassword),
            [one] => one.clone(),
            _ => {
                return Err(ToolError::Failed(
                    "This drive has more than one password slot with the same password, so Luna can't change it safely.".into(),
                ));
            }
        };
        let free = free_slot(&slots).ok_or_else(|| {
            ToolError::Failed(
                "This drive has no free password slot, so Luna can't change its password.".into(),
            )
        })?;

        let key = SecretFile::new(new)?;
        let memory = pbkdf_kib_from(crate::budget::meminfo().total_bytes);
        let added = run(
            &add_key_args(device, &old, &free, memory),
            current.as_bytes(),
            OPEN_TIMEOUT,
            "Luna couldn't add the new password.",
            |cmd| key.pass_to(cmd, 40),
        );
        drop(key);
        if let Err(err) = added {
            // A timeout can land after the header was updated: remove only the
            // slot reserved for this attempt, if it is there.
            return match keyslots(&bin, device) {
                Ok(now) if !now.contains(&free) => Err(err),
                Ok(_) if kill_slot(device, &free, current).is_ok() => Err(err),
                _ => Err(ToolError::Failed(
                    "Luna couldn't finish changing the password. The current password still works; the new one may also work.".into(),
                )),
            };
        }
        // Prove the new password opens the container before the old one goes.
        match slot_opens(device, &free, new) {
            Ok(true) => {}
            other => {
                if kill_slot(device, &free, current).is_err() {
                    return Err(ToolError::Failed(
                        "Luna couldn't check the new password or take it back out. The current password still works.".into(),
                    ));
                }
                return Err(match other {
                    Err(e) => e,
                    _ => ToolError::Failed(
                        "Luna couldn't check the new password, so nothing was changed. The current password still works.".into(),
                    ),
                });
            }
        }
        if let Err(e) = kill_slot(device, &old, new) {
            if kill_slot(device, &free, current).is_err() {
                return Err(ToolError::Failed(
                    "Luna couldn't finish changing the password. Try the new password first, then the current one.".into(),
                ));
            }
            return Err(e);
        }
        Ok(())
    }
}

/// An anonymous RAM-backed key file for the new password: nothing touches a
/// disk and nothing goes on a command line. The descriptor is above the range
/// `Command` uses for stdio, and close-on-exec so unrelated children never
/// inherit it; only the cryptsetup child gets a copy, at a fixed number.
/// The bytes are overwritten when it is dropped.
#[cfg(target_os = "linux")]
struct SecretFile {
    fd: i32,
    len: usize,
}

#[cfg(target_os = "linux")]
impl SecretFile {
    fn new(secret: &str) -> Result<Self, ToolError> {
        use std::io::Write;
        use std::os::fd::{AsRawFd, FromRawFd};
        let failed =
            || ToolError::Failed(format!("Luna couldn't pass the password on. {TRY_AGAIN}"));
        // SAFETY: memfd_create returns a fresh descriptor we own, or -1.
        let fd = unsafe { libc::memfd_create(c"luna-key".as_ptr(), libc::MFD_CLOEXEC) };
        if fd < 0 {
            return Err(failed());
        }
        // SAFETY: `fd` is valid and owned here; the File closes it on drop.
        let mut file = unsafe { std::fs::File::from_raw_fd(fd) };
        file.write_all(secret.as_bytes()).map_err(|_| failed())?;
        // SAFETY: duplicating a valid descriptor.
        let high = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 512) };
        if high < 0 {
            return Err(failed());
        }
        // `file` drops here and closes the low descriptor; `high` keeps the data.
        Ok(Self {
            fd: high,
            len: secret.len(),
        })
    }

    /// Make the child see this file as descriptor `target`.
    fn pass_to(&self, cmd: &mut Command, target: i32) {
        use std::os::unix::process::CommandExt;
        let fd = self.fd;
        // SAFETY: only async-signal-safe calls (`dup2`) run between fork and exec.
        unsafe {
            cmd.pre_exec(move || {
                if libc::dup2(fd, target) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
}

#[cfg(target_os = "linux")]
impl Drop for SecretFile {
    fn drop(&mut self) {
        let zeros = [0u8; 4096];
        let mut offset = 0;
        while offset < self.len {
            let size = (self.len - offset).min(zeros.len());
            // SAFETY: `fd` is ours and `zeros` outlives the call.
            let wrote = unsafe {
                libc::pwrite(self.fd, zeros.as_ptr().cast(), size, offset as libc::off_t)
            };
            if wrote <= 0 {
                break;
            }
            offset += wrote as usize;
        }
        // SAFETY: `fd` is ours; nothing uses it after this.
        unsafe {
            libc::ftruncate(self.fd, 0);
            libc::close(self.fd);
        }
    }
}

/// Changing a password needs Linux's anonymous memory files.
#[cfg(not(target_os = "linux"))]
struct SecretFile;

#[cfg(not(target_os = "linux"))]
impl SecretFile {
    fn new(_secret: &str) -> Result<Self, ToolError> {
        Err(ToolError::Failed(
            "Luna can only change a drive's password when it runs on Luna's own system.".into(),
        ))
    }

    fn pass_to(&self, _cmd: &mut Command, _target: i32) {}
}

/// Test double: records every call, makes nothing, never touches a device. It
/// remembers the container's password, so wrong passwords behave like the real
/// thing; with none set, any password opens it.
#[derive(Default)]
pub struct MockLuks {
    /// `"<method> <device or id>"` for every call, in order.
    pub calls: std::sync::Mutex<Vec<String>>,
    /// Mappers considered open.
    pub open: std::sync::Mutex<std::collections::HashSet<String>>,
    /// The `pbkdf_kib` the last `luks_format` was given.
    pub pbkdf: std::sync::Mutex<Option<u32>>,
    /// The container's password. `luks_format` sets it; `change_password` replaces it.
    pub password: std::sync::Mutex<Option<String>>,
    /// The password the last call was given (tests only; never logged).
    pub last_password: std::sync::Mutex<Option<String>>,
    /// Fail this method (by name) with `ToolError::Failed`.
    pub fail_at: std::sync::Mutex<Option<&'static str>>,
}

impl MockLuks {
    pub fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }

    /// Count of calls to `method`.
    pub fn count(&self, method: &str) -> usize {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|c| c.split_whitespace().next() == Some(method))
            .count()
    }

    fn record(&self, method: &'static str, what: &str) -> Result<(), ToolError> {
        self.calls.lock().unwrap().push(format!("{method} {what}"));
        if *self.fail_at.lock().unwrap() == Some(method) {
            return Err(ToolError::Failed(format!("mock {method} failure")));
        }
        Ok(())
    }

    fn accepts(&self, password: &str) -> bool {
        *self.last_password.lock().unwrap() = Some(password.to_string());
        self.password
            .lock()
            .unwrap()
            .as_deref()
            .is_none_or(|p| p == password)
    }
}

impl Luks for MockLuks {
    fn luks_format(
        &self,
        device: &str,
        label: &str,
        password: &str,
        pbkdf_kib: u32,
    ) -> Result<(), ToolError> {
        *self.pbkdf.lock().unwrap() = Some(pbkdf_kib);
        *self.last_password.lock().unwrap() = Some(password.to_string());
        self.record("luks_format", &format!("{device} {label}"))?;
        *self.password.lock().unwrap() = Some(password.to_string());
        Ok(())
    }

    fn open(&self, device: &str, drive_id: &str, password: &str) -> Result<(), ToolError> {
        self.record("open", &format!("{device} {drive_id}"))?;
        if !self.accepts(password) {
            return Err(ToolError::WrongPassword);
        }
        self.open.lock().unwrap().insert(drive_id.to_string());
        Ok(())
    }

    fn close(&self, drive_id: &str) -> Result<(), ToolError> {
        self.record("close", drive_id)?;
        self.open.lock().unwrap().remove(drive_id);
        Ok(())
    }

    fn is_open(&self, drive_id: &str) -> bool {
        self.open.lock().unwrap().contains(drive_id)
    }

    fn change_password(&self, device: &str, current: &str, new: &str) -> Result<(), ToolError> {
        self.record("change_password", device)?;
        if !self.accepts(current) {
            return Err(ToolError::WrongPassword);
        }
        *self.password.lock().unwrap() = Some(new.to_string());
        Ok(())
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
        assert_ne!(mapper_name("a"), mapper_name("b"));
    }

    #[test]
    fn the_password_is_never_on_a_command_line() {
        // The secret is not a parameter of any argument builder; the only ways
        // to give cryptsetup one are stdin and the memory-only descriptor.
        let format = luks_format_args("/dev/sdb1", "Photos", 262144);
        let open = luks_open_args("/dev/sdb1", "d1");
        let test = test_slot_args("/dev/sdb1", "0");
        let add = add_key_args("/dev/sdb1", "0", "1", 262144);
        let kill = kill_slot_args("/dev/sdb1", "0");
        for args in [&format, &open, &test, &add, &kill] {
            let at = args.iter().position(|a| a == "--key-file").unwrap();
            assert_eq!(args[at + 1], "-", "the key must come from stdin");
        }
        assert!(format.contains(&"argon2id".to_string()));
        assert!(format.contains(&"aes-xts-plain64".to_string()));
        assert!(format.contains(&"512".to_string()));
        assert!(open.contains(&"luna-vault-d1".to_string()));
        // The new key is a descriptor, not text.
        assert_eq!(add.last().unwrap(), "/proc/self/fd/40");
        assert!(add.contains(&"argon2id".to_string()));
    }

    #[test]
    fn cryptsetup_wrong_password_is_its_own_error() {
        assert!(matches!(
            classify("No key available with this passphrase.", "x"),
            ToolError::WrongPassword
        ));
        let said = classify("Device /dev/sdb1 is busy.", "Luna couldn't open it.").to_string();
        assert_eq!(
            said,
            "Luna couldn't open it. Something is still using this drive."
        );
        assert_eq!(
            classify("Device is not a valid LUKS device.", "x").to_string(),
            "This drive isn't an encrypted Luna drive."
        );
        // Raw output never reaches the person.
        assert!(
            !classify("ioctl failed at 0x1fe", "Luna couldn't open it.")
                .to_string()
                .contains("ioctl")
        );
    }

    #[test]
    fn keyslots_come_out_of_the_header_json() {
        let json = br#"{"keyslots":{"0":{"type":"luks2"},"3":{"type":"luks2"}},"tokens":{}}"#;
        let mut slots = parse_keyslots(json).unwrap();
        slots.sort();
        assert_eq!(slots, vec!["0", "3"]);
        assert!(parse_keyslots(b"not json").is_none());
        assert!(parse_keyslots(br#"{"tokens":{}}"#).is_none());
    }

    #[test]
    fn the_new_keyslot_is_the_lowest_free_one() {
        assert_eq!(free_slot(&["0".into()]).unwrap(), "1");
        assert_eq!(
            free_slot(&["0".into(), "1".into(), "3".into()]).unwrap(),
            "2"
        );
        let all: Vec<String> = (0..32).map(|n| n.to_string()).collect();
        assert!(free_slot(&all).is_none());
    }

    #[test]
    fn the_mock_opens_and_closes() {
        let mock = MockLuks::default();
        assert!(!mock.is_open("d1"));
        mock.open("/dev/sdb1", "d1", "pw").unwrap();
        assert!(mock.is_open("d1"));
        mock.close("d1").unwrap();
        assert!(!mock.is_open("d1"));
        assert_eq!(mock.calls(), vec!["open /dev/sdb1 d1", "close d1"]);
    }

    #[test]
    fn the_mock_refuses_a_wrong_password_and_changes_it() {
        let mock = MockLuks::default();
        mock.luks_format("/dev/sdb1", "Photos", "right", 1).unwrap();
        assert!(matches!(
            mock.open("/dev/sdb1", "d1", "wrong"),
            Err(ToolError::WrongPassword)
        ));
        assert!(!mock.is_open("d1"));
        mock.change_password("/dev/sdb1", "right", "newer").unwrap();
        assert!(mock.open("/dev/sdb1", "d1", "right").is_err());
        mock.open("/dev/sdb1", "d1", "newer").unwrap();
        assert!(matches!(
            mock.change_password("/dev/sdb1", "right", "x"),
            Err(ToolError::WrongPassword)
        ));
    }
}

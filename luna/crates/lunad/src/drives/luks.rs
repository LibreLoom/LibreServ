//! LUKS2 containers: detect, format, open, close.
//!
//! An encrypted drive is one partition holding one LUKS2 container with ext4
//! inside. The volume key lives in the kernel's dm-crypt mapping — never in
//! this process — so it is gone on `luksClose` or power loss, which is what
//! makes "the key is only in RAM" true without us holding anything.
//!
//! The passphrase only ever travels on stdin (`--key-file -`). Anything on a
//! command line is world-readable in `/proc/<pid>/cmdline`.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// blkid's type for a LUKS partition. It is deliberately not part of
/// [`crate::drives::fsprobe::is_writable_type`]: a locked container has no
/// filesystem to mount.
pub const LUKS_TYPE: &str = "crypto_luks";

/// Mapper names are prefixed so a mapping Luna owns is recognisable in
/// `/dev/mapper` and can never collide with a distro's own.
pub const MAPPER_PREFIX: &str = "luna-vault-";

/// Every LUKS1 and LUKS2 container starts with this magic.
const LUKS_MAGIC: &[u8] = b"LUKS\xba\xbe";

/// Argon2id's memory cost is in KiB. LUKS2's 1 GiB default OOM-kills a 2 GiB
/// Wyse, so the cost is chosen from free RAM at format time and recorded in
/// the header — unlocking reads it back from there.
pub const MIN_PBKDF_KIB: u32 = 32 * 1024;
pub const MAX_PBKDF_KIB: u32 = 1024 * 1024;

pub fn is_luks_type(fs: &str) -> bool {
    fs.eq_ignore_ascii_case(LUKS_TYPE)
}

pub fn mapper_name(drive_id: &str) -> String {
    format!("{MAPPER_PREFIX}{drive_id}")
}

pub fn mapper_path(drive_id: &str) -> PathBuf {
    Path::new("/dev/mapper").join(mapper_name(drive_id))
}

/// Argon2id memory for a format, from the box's free RAM. An eighth of
/// available memory, floored so it is never trivially cheap to attack and
/// capped so it never approaches the OOM line.
pub fn pbkdf_kib_from(available_bytes: u64) -> u32 {
    let eighth_kib = available_bytes / 8 / 1024;
    eighth_kib.clamp(MIN_PBKDF_KIB as u64, MAX_PBKDF_KIB as u64) as u32
}

/// The LUKS2 profile. Frozen: once drives exist in the wild, changing any of
/// this breaks every future reader.
pub const CIPHER: &str = "aes-xts-plain64";
pub const KEY_BITS: &str = "512";
pub const SECTOR_BYTES: &str = "512";

/// Everything Luna does to a container. A trait so tests never need root or
/// a real device.
pub trait Luks: Send + Sync {
    /// Does this device hold a LUKS container?
    fn is_luks(&self, device: &str) -> bool;
    /// Put a fresh LUKS2 container on `device`, labelled for the drive name.
    fn format(
        &self,
        device: &str,
        label: &str,
        password: &str,
        pbkdf_kib: u32,
    ) -> anyhow::Result<()>;
    /// Open `device` as the drive's mapper. The password goes on stdin.
    fn open(&self, device: &str, drive_id: &str, password: &str) -> anyhow::Result<()>;
    /// Close the drive's mapper, wiping the volume key from the kernel.
    fn close(&self, drive_id: &str) -> anyhow::Result<()>;
    /// Is the container currently open?
    fn is_open(&self, drive_id: &str) -> bool;
    /// Is a reencryption operation recorded in the header? Needs no password:
    /// it reads metadata only, which is how a boot can spot a half-converted
    /// drive and say so.
    fn reencrypt_state(&self, device: &str) -> ReencryptState;
}

/// What the LUKS2 header says about an interrupted in-place conversion.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReencryptState {
    /// No conversion recorded.
    None,
    /// A conversion was started and did not finish.
    Interrupted,
    /// Luna could not read the header at all.
    Unknown,
}

#[derive(Clone, Default)]
pub struct CommandLuks;

impl Luks for CommandLuks {
    fn is_luks(&self, device: &str) -> bool {
        has_luks_magic(Path::new(device))
    }

    fn format(
        &self,
        device: &str,
        label: &str,
        password: &str,
        pbkdf_kib: u32,
    ) -> anyhow::Result<()> {
        let bin = cryptsetup()?;
        let mut cmd = crate::sandbox::hardened(&bin);
        cmd.args([
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
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
        run_with_secret(&mut cmd, password, std::time::Duration::from_secs(300))
            .map_err(|e| anyhow::anyhow!("Luna couldn't set up encryption on this drive. {e}"))
    }

    fn open(&self, device: &str, drive_id: &str, password: &str) -> anyhow::Result<()> {
        let bin = cryptsetup()?;
        let mut cmd = crate::sandbox::hardened(&bin);
        cmd.args([
            "luksOpen",
            "--key-file",
            "-",
            "--type",
            "luks2",
            device,
            &mapper_name(drive_id),
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
        run_with_secret(&mut cmd, password, std::time::Duration::from_secs(120))
    }

    fn close(&self, drive_id: &str) -> anyhow::Result<()> {
        if !self.is_open(drive_id) {
            return Ok(());
        }
        let bin = cryptsetup()?;
        let mut cmd = crate::sandbox::hardened(&bin);
        cmd.args(["luksClose", &mapper_name(drive_id)])
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        let out = crate::sandbox::output_limited(&mut cmd, std::time::Duration::from_secs(60))?;
        if out.status.success() {
            return Ok(());
        }
        let said = String::from_utf8_lossy(&out.stderr).trim().to_string();
        // Already gone is success: the key is out of the kernel either way.
        if said.to_ascii_lowercase().contains("not active") {
            return Ok(());
        }
        Err(anyhow::anyhow!("Luna couldn't lock this drive. {said}"))
    }

    fn is_open(&self, drive_id: &str) -> bool {
        mapper_path(drive_id).exists()
    }

    fn reencrypt_state(&self, device: &str) -> ReencryptState {
        let Some(bin) = crate::sandbox::which("cryptsetup") else {
            return ReencryptState::Unknown;
        };
        let mut cmd = crate::sandbox::hardened(&bin);
        cmd.args(["luksDump", device])
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let Ok(out) = crate::sandbox::output_limited(&mut cmd, std::time::Duration::from_secs(30))
        else {
            return ReencryptState::Unknown;
        };
        if !out.status.success() {
            return ReencryptState::Unknown;
        }
        parse_reencrypt_state(&String::from_utf8_lossy(&out.stdout))
    }
}

/// `luksDump` prints an `Online reencryption` block only while a conversion is
/// recorded in the header. Its `Progress:` line is a percentage; `-` means the
/// operation is initialized but has not moved yet. Either way it is unfinished.
pub fn parse_reencrypt_state(dump: &str) -> ReencryptState {
    let mut in_block = false;
    for line in dump.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("Online reencryption") {
            in_block = true;
            continue;
        }
        if in_block {
            // The block ends at the first blank line or the next top-level key.
            if trimmed.is_empty() {
                return ReencryptState::Interrupted;
            }
            // Any progress line inside the block means the operation is still
            // recorded in the header, whether it has moved (`42%`) or not
            // (`-`). Either way it is unfinished: the block is only removed
            // once the conversion is finalized.
            if trimmed.starts_with("Progress:") {
                return ReencryptState::Interrupted;
            }
        }
    }
    if in_block {
        ReencryptState::Interrupted
    } else {
        ReencryptState::None
    }
}

fn cryptsetup() -> anyhow::Result<PathBuf> {
    crate::sandbox::which("cryptsetup").ok_or_else(|| {
        anyhow::anyhow!(
            "Luna can't encrypt drives. This Luna is missing a program it needs (cryptsetup)."
        )
    })
}

/// Run a command whose secret arrives on stdin. stdin is closed straight after
/// the write so the tool sees EOF, and stderr is captured for the message.
fn run_with_secret(
    cmd: &mut Command,
    secret: &str,
    timeout: std::time::Duration,
) -> anyhow::Result<()> {
    let mut child = cmd.spawn()?;
    {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow::anyhow!("Luna couldn't pass the password to the drive."))?;
        stdin.write_all(secret.as_bytes())?;
        // Dropping closes the pipe, which is the only "end of passphrase".
    }
    let out = crate::sandbox::collect_output(child, timeout)?;
    if out.status.success() {
        return Ok(());
    }
    let said = String::from_utf8_lossy(&out.stderr).trim().to_string();
    Err(anyhow::anyhow!("{}", plain_cryptsetup_error(&said)))
}

/// cryptsetup's stderr is for an operator. Turn the cases a person can act on
/// into plain words and keep everything else short.
pub fn plain_cryptsetup_error(said: &str) -> String {
    let lower = said.to_ascii_lowercase();
    if lower.contains("no key available with this passphrase")
        || lower.contains("no usable keyslot")
    {
        return "That password didn't work.".into();
    }
    if lower.contains("is busy") || lower.contains("in use") {
        return "This drive is in use. Close any files open from it and try again.".into();
    }
    if lower.contains("not a valid luks") {
        return "This drive isn't an encrypted Luna drive.".into();
    }
    if said.is_empty() {
        return "The drive refused the request.".into();
    }
    said.to_string()
}

fn has_luks_magic(device: &Path) -> bool {
    use std::io::Read;
    let Ok(mut file) = std::fs::File::open(device) else {
        return false;
    };
    let mut head = [0u8; 6];
    file.read_exact(&mut head).is_ok() && head == LUKS_MAGIC
}

/// Test double: records calls and answers from canned state.
#[derive(Default)]
pub struct MockLuks {
    pub devices: std::sync::Mutex<std::collections::HashSet<String>>,
    pub formatted: std::sync::Mutex<Vec<(String, String, u32)>>,
    pub opened: std::sync::Mutex<Vec<(String, String)>>,
    pub closed: std::sync::Mutex<Vec<String>>,
    /// Drives whose mapper counts as open.
    pub open: std::sync::Mutex<std::collections::HashSet<String>>,
    /// Make `open` fail with this message (a wrong password).
    pub open_error: std::sync::Mutex<Option<String>>,
    pub reencrypt: std::sync::Mutex<std::collections::HashMap<String, ReencryptState>>,
}

impl MockLuks {
    pub fn with_luks(device: &str) -> Self {
        let mock = Self::default();
        mock.devices.lock().unwrap().insert(device.to_string());
        mock
    }

    pub fn open_count(&self) -> usize {
        self.opened.lock().unwrap().len()
    }
}

impl Luks for MockLuks {
    fn is_luks(&self, device: &str) -> bool {
        self.devices.lock().unwrap().contains(device)
    }

    fn format(
        &self,
        device: &str,
        label: &str,
        _password: &str,
        pbkdf_kib: u32,
    ) -> anyhow::Result<()> {
        self.formatted
            .lock()
            .unwrap()
            .push((device.to_string(), label.to_string(), pbkdf_kib));
        self.devices.lock().unwrap().insert(device.to_string());
        Ok(())
    }

    fn open(&self, device: &str, drive_id: &str, _password: &str) -> anyhow::Result<()> {
        if let Some(err) = self.open_error.lock().unwrap().clone() {
            return Err(anyhow::anyhow!("{err}"));
        }
        if !self.devices.lock().unwrap().contains(device) {
            return Err(anyhow::anyhow!("This drive isn't an encrypted Luna drive."));
        }
        self.opened
            .lock()
            .unwrap()
            .push((device.to_string(), drive_id.to_string()));
        self.open.lock().unwrap().insert(drive_id.to_string());
        Ok(())
    }

    fn close(&self, drive_id: &str) -> anyhow::Result<()> {
        self.closed.lock().unwrap().push(drive_id.to_string());
        self.open.lock().unwrap().remove(drive_id);
        Ok(())
    }

    fn is_open(&self, drive_id: &str) -> bool {
        self.open.lock().unwrap().contains(drive_id)
    }

    fn reencrypt_state(&self, device: &str) -> ReencryptState {
        self.reencrypt
            .lock()
            .unwrap()
            .get(device)
            .copied()
            .unwrap_or(ReencryptState::None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn luks_type_is_matched_case_insensitively() {
        assert!(is_luks_type("crypto_LUKS"));
        assert!(is_luks_type("crypto_luks"));
        assert!(!is_luks_type("ext4"));
        assert!(!is_luks_type(""));
    }

    #[test]
    fn mapper_names_are_prefixed_and_per_drive() {
        assert_eq!(mapper_name("abc"), "luna-vault-abc");
        assert_eq!(mapper_path("abc"), Path::new("/dev/mapper/luna-vault-abc"));
        assert_ne!(mapper_name("a"), mapper_name("b"));
    }

    #[test]
    fn pbkdf_memory_follows_free_ram_within_bounds() {
        // A 2 GiB Wyse with most memory free: an eighth, well under the cap.
        assert_eq!(pbkdf_kib_from(2 * 1024 * 1024 * 1024), 256 * 1024);
        // Never below the floor.
        assert_eq!(pbkdf_kib_from(0), MIN_PBKDF_KIB);
        assert_eq!(pbkdf_kib_from(64 * 1024), MIN_PBKDF_KIB);
        // Never above the cap.
        assert_eq!(pbkdf_kib_from(64 * 1024 * 1024 * 1024), MAX_PBKDF_KIB);
    }

    #[test]
    fn a_plain_dump_has_no_conversion() {
        let dump = "LUKS header information\nVersion:\t2\nData segments:\n  0: crypt\n";
        assert_eq!(parse_reencrypt_state(dump), ReencryptState::None);
    }

    #[test]
    fn an_unfinished_conversion_is_reported() {
        let dump = "LUKS header information\nVersion:\t2\nOnline reencryption\n  \
                    Progress: 42%\n  Reencrypt: 42%\n";
        assert_eq!(parse_reencrypt_state(dump), ReencryptState::Interrupted);
    }

    #[test]
    fn an_initialized_but_unmoved_conversion_is_reported() {
        let dump = "LUKS header information\nOnline reencryption\n  Progress: -\n";
        assert_eq!(parse_reencrypt_state(dump), ReencryptState::Interrupted);
    }

    #[test]
    fn a_conversion_block_at_end_of_output_is_reported() {
        let dump = "LUKS header information\nOnline reencryption";
        assert_eq!(parse_reencrypt_state(dump), ReencryptState::Interrupted);
    }

    #[test]
    fn cryptsetup_errors_become_plain_words() {
        assert_eq!(
            plain_cryptsetup_error("No key available with this passphrase."),
            "That password didn't work."
        );
        assert_eq!(
            plain_cryptsetup_error("Device /dev/sdb1 is busy."),
            "This drive is in use. Close any files open from it and try again."
        );
        assert_eq!(
            plain_cryptsetup_error("Device is not a valid LUKS device."),
            "This drive isn't an encrypted Luna drive."
        );
    }

    #[test]
    fn a_non_luks_device_has_no_magic() {
        let dir = tempfile::tempdir().unwrap();
        let plain = dir.path().join("plain.img");
        std::fs::write(&plain, vec![0u8; 4096]).unwrap();
        assert!(!has_luks_magic(&plain));

        let luks = dir.path().join("luks.img");
        let mut bytes = LUKS_MAGIC.to_vec();
        bytes.extend_from_slice(&[0u8; 100]);
        std::fs::write(&luks, bytes).unwrap();
        assert!(has_luks_magic(&luks));

        // A file too short to hold the magic is not a container.
        let tiny = dir.path().join("tiny.img");
        std::fs::write(&tiny, b"LUK").unwrap();
        assert!(!has_luks_magic(&tiny));
    }

    #[test]
    fn the_mock_opens_and_closes() {
        let mock = MockLuks::with_luks("/dev/sdb1");
        assert!(!mock.is_open("d1"));
        mock.open("/dev/sdb1", "d1", "pw").unwrap();
        assert!(mock.is_open("d1"));
        assert_eq!(mock.open_count(), 1);
        mock.close("d1").unwrap();
        assert!(!mock.is_open("d1"));
    }

    #[test]
    fn the_mock_can_refuse_a_password() {
        let mock = MockLuks::with_luks("/dev/sdb1");
        *mock.open_error.lock().unwrap() = Some("That password didn't work.".into());
        let err = mock.open("/dev/sdb1", "d1", "wrong").unwrap_err();
        assert_eq!(err.to_string(), "That password didn't work.");
        assert!(!mock.is_open("d1"));
    }
}

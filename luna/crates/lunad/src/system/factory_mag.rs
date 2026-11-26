//! Read one Device ID and Verification code from the LUNAASSETS `TOKENS` magazine.
//!
//! Each data line has exactly two whitespace-separated fields: a 20-character
//! Crockford Device ID and a six-hex-character Verification code.

use std::path::{Path, PathBuf};
use std::thread;
use std::time::Duration;

use crate::drives::mount::{MOUNT_TIMEOUT, UNMOUNT_TIMEOUT, run_bounded};
use crate::net::connect::{
    is_device_uid_format, is_verification_code_format, normalize_device_uid,
    normalize_verification_code,
};
use crate::system::updates::lookup_device;

pub const MAG_RETRY_ATTEMPTS: u32 = 3;
pub const MAG_RETRY_DELAY: Duration = Duration::from_millis(500);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MagFetchOutcome {
    AlreadyValid,
    /// A UID is already saved but its code is not. Losing the code requires
    /// recovery; a different magazine line must not replace this Luna's UID.
    Incomplete,
    NoMagazine,
    Fetched {
        attempts: u32,
    },
    ExhaustedRetries {
        attempts: u32,
    },
}

#[derive(Debug, Clone)]
pub struct MagFetchOptions {
    /// When set (tests), read `{assets_root}/TOKENS` instead of mounting LUNAASSETS.
    pub assets_root: Option<PathBuf>,
    pub max_attempts: u32,
    pub retry_delay: Duration,
}

impl Default for MagFetchOptions {
    fn default() -> Self {
        Self {
            assets_root: None,
            max_attempts: MAG_RETRY_ATTEMPTS,
            retry_delay: MAG_RETRY_DELAY,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FactoryTokens {
    pub device_uid: String,
    pub verification_code: String,
}

/// Parse the factory contract exactly: two fields, a 20-character UID, and a
/// six-hex-character code. Grouping, comments, and extra fields are rejected.
pub fn parse_factory_tokens_line(line: &str) -> Option<FactoryTokens> {
    let mut fields = line.split_whitespace();
    let uid_field = fields.next()?;
    let code_field = fields.next()?;
    if fields.next().is_some() || uid_field.len() != 20 {
        return None;
    }
    let device_uid = normalize_device_uid(uid_field);
    let verification_code = normalize_verification_code(code_field);
    if !is_device_uid_format(&device_uid) || !is_verification_code_format(&verification_code) {
        return None;
    }
    Some(FactoryTokens {
        device_uid,
        verification_code,
    })
}

/// Populate the two separate local files from the factory magazine.
pub fn fetch_pairing_material_from_mag(
    device_uid_path: &Path,
    pairing_code_path: &Path,
    opts: &MagFetchOptions,
) -> MagFetchOutcome {
    if let Some(outcome) = preserve_existing_pairing(device_uid_path, pairing_code_path) {
        return outcome;
    }

    let mut attempts = 0u32;
    while attempts < opts.max_attempts {
        attempts += 1;
        let Some(line) = peel_one_line(opts) else {
            return if attempts == 1 {
                MagFetchOutcome::NoMagazine
            } else {
                MagFetchOutcome::ExhaustedRetries { attempts }
            };
        };
        let Some(tokens) = parse_factory_tokens_line(&line) else {
            if attempts < opts.max_attempts {
                thread::sleep(opts.retry_delay);
            }
            continue;
        };
        // The magazine read/peel can take a while. Recheck immediately before
        // committing so a pairing write that won the race is never overwritten
        // or combined with this line's code.
        if let Some(outcome) = preserve_existing_pairing(device_uid_path, pairing_code_path) {
            return outcome;
        }
        // Write the code first: a crash between the two writes leaves no UID.
        // The recheck above also makes that partial state fail closed rather
        // than mixing it with a later magazine identity.
        if write_private(pairing_code_path, &tokens.verification_code).is_err()
            || write_private(device_uid_path, &tokens.device_uid).is_err()
        {
            if attempts < opts.max_attempts {
                thread::sleep(opts.retry_delay);
            }
            continue;
        }
        return MagFetchOutcome::Fetched { attempts };
    }
    MagFetchOutcome::ExhaustedRetries { attempts }
}

/// `None` means neither file holds a usable identity and the magazine may
/// provision one. A valid half is never replaced or completed from another
/// line: that would mix two factory identities.
fn preserve_existing_pairing(
    device_uid_path: &Path,
    pairing_code_path: &Path,
) -> Option<MagFetchOutcome> {
    let existing_uid = read_trimmed(device_uid_path)
        .map(|raw| normalize_device_uid(&raw))
        .filter(|uid| is_device_uid_format(uid));
    let existing_code = read_trimmed(pairing_code_path)
        .map(|raw| normalize_verification_code(&raw))
        .filter(|code| is_verification_code_format(code));
    if existing_uid.is_some() && existing_code.is_some() {
        return Some(MagFetchOutcome::AlreadyValid);
    }
    if existing_uid.is_some() || existing_code.is_some() {
        if existing_uid.is_some() && pairing_code_path.is_file() {
            let _ = std::fs::remove_file(pairing_code_path);
        }
        return Some(MagFetchOutcome::Incomplete);
    }
    // Only malformed files reach here; they are not an immutable identity.
    if device_uid_path.is_file() {
        let _ = std::fs::remove_file(device_uid_path);
    }
    if pairing_code_path.is_file() {
        let _ = std::fs::remove_file(pairing_code_path);
    }
    None
}

fn read_trimmed(path: &Path) -> Option<String> {
    std::fs::read_to_string(path)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn write_private(path: &Path, value: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temp = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp)?;
        use std::io::Write;
        file.write_all(format!("{value}\n").as_bytes())?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temp, path)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
        }
        crate::datadir::sync_parent_directory(path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

fn peel_one_line(opts: &MagFetchOptions) -> Option<String> {
    if let Some(root) = &opts.assets_root {
        return peel_from_dir(root);
    }
    let guard = mount_lunaassets().ok()?;
    let line = peel_from_dir(&guard.path);
    drop(guard);
    line
}

fn peel_from_dir(assets_root: &Path) -> Option<String> {
    let tokens = assets_root.join("TOKENS");
    let first = tokens_first_line(&tokens)?;
    if tokens_drop_first(&tokens).is_err() {
        return None;
    }
    Some(first)
}

fn tokens_first_line(path: &Path) -> Option<String> {
    let text = read_tokens(path).ok()?;
    for line in text.lines() {
        let trimmed = line.trim().trim_start_matches('\r');
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        return Some(trimmed.to_string());
    }
    None
}

/// Read `TOKENS` as text. The stick decides what that name is, so the file is
/// opened without following a link and must be a regular file.
fn read_tokens(path: &Path) -> std::io::Result<String> {
    use std::io::Read;
    let mut opts = std::fs::OpenOptions::new();
    opts.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = opts.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(not_a_file());
    }
    let mut text = String::new();
    file.read_to_string(&mut text)?;
    Ok(text)
}

/// Rewrite `TOKENS` in place, never through a link.
fn write_tokens(path: &Path, text: &str) -> std::io::Result<()> {
    use std::io::Write;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = opts.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(not_a_file());
    }
    file.write_all(text.as_bytes())
}

fn not_a_file() -> std::io::Error {
    std::io::Error::new(
        std::io::ErrorKind::InvalidData,
        "TOKENS is not a regular file",
    )
}

fn tokens_drop_first(path: &Path) -> std::io::Result<()> {
    let text = read_tokens(path)?;
    let mut dropped = false;
    let mut kept = String::new();
    for line in text.lines() {
        if !dropped {
            let check = line.trim().trim_start_matches('\r');
            if check.is_empty() || check.starts_with('#') {
                kept.push_str(line);
                kept.push('\n');
                continue;
            }
            dropped = true;
            continue;
        }
        kept.push_str(line);
        kept.push('\n');
    }
    if !dropped {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "no token line to drop",
        ));
    }
    write_tokens(path, &kept)
}

struct AssetsMount {
    path: PathBuf,
    mounted: bool,
}

impl Drop for AssetsMount {
    fn drop(&mut self) {
        if self.mounted {
            let _ = run_bounded(
                crate::sandbox::hardened_tool("umount").arg(&self.path),
                UNMOUNT_TIMEOUT,
            );
            let _ = std::fs::remove_dir(&self.path);
        }
    }
}

fn mount_lunaassets() -> Result<AssetsMount, ()> {
    let dev = lookup_device("blkid", &["-L", "LUNAASSETS"])
        .or_else(|| lookup_device("findfs", &["LABEL=LUNAASSETS"]))
        .ok_or(())?;

    // LABEL= is forgeable — only trust the magazine on the removable
    // install media, never on the boot disk or a fixed drive.
    if !crate::system::updates::device_is_factory_media(dev.to_str().ok_or(())?) {
        return Err(());
    }

    let tmp = std::env::temp_dir().join(format!("luna-assets-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).map_err(|_| ())?;
    let mount = |args: &[&str]| {
        run_bounded(
            crate::sandbox::hardened_tool("mount")
                .args(args)
                .arg(&dev)
                .arg(&tmp),
            MOUNT_TIMEOUT,
        )
    };
    let ok = match mount(&[
        "-t",
        "vfat",
        "-o",
        "rw,utf8,fmask=0133,dmask=0022,noexec,nosuid,nodev",
    ]) {
        Ok(out) if out.status.success() => true,
        Err(err) if err.kind() == std::io::ErrorKind::TimedOut => false,
        _ => mount(&["-o", "rw,noexec,nosuid,nodev"]).is_ok_and(|out| out.status.success()),
    };
    if !ok {
        let _ = std::fs::remove_dir(&tmp);
        return Err(());
    }
    Ok(AssetsMount {
        path: tmp,
        mounted: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const UID: &str = "7K4M2Q9XR8N36T5W1PZH";
    const CODE: &str = "A3F91C";

    fn write_tokens(dir: &Path, body: &str) {
        std::fs::write(dir.join("TOKENS"), body).unwrap();
    }

    #[test]
    fn factory_line_requires_exactly_two_valid_fields() {
        let parsed = parse_factory_tokens_line(&format!("  {UID}\t{CODE}  ")).unwrap();
        assert_eq!(parsed.device_uid, UID);
        assert_eq!(parsed.verification_code, CODE);
        assert_eq!(
            parse_factory_tokens_line(&format!("{UID} {CODE} extra")),
            None
        );
        assert_eq!(parse_factory_tokens_line(&format!("{UID}-{CODE}")), None);
        assert_eq!(
            parse_factory_tokens_line(&format!("7K4M-2Q9X-R8N3-6T5W-1PZH {CODE}")),
            None
        );
        assert_eq!(parse_factory_tokens_line(&format!("{UID} A3F91")), None);
        assert_eq!(parse_factory_tokens_line(&format!("{UID} A3F91G")), None);
    }

    #[test]
    fn invalid_mag_line_is_retried_and_both_files_are_written() {
        let dir = tempfile::tempdir().unwrap();
        let assets = dir.path().join("assets");
        std::fs::create_dir_all(&assets).unwrap();
        write_tokens(&assets, &format!("not-a-code\n{UID} {CODE}\n"));
        let uid = dir.path().join("device-uid");
        let code = dir.path().join("pairing-code");
        let opts = MagFetchOptions {
            assets_root: Some(assets),
            max_attempts: 3,
            retry_delay: Duration::from_millis(1),
        };
        assert_eq!(
            fetch_pairing_material_from_mag(&uid, &code, &opts),
            MagFetchOutcome::Fetched { attempts: 2 }
        );
        assert_eq!(std::fs::read_to_string(&uid).unwrap().trim(), UID);
        assert_eq!(std::fs::read_to_string(&code).unwrap().trim(), CODE);
        assert_eq!(
            std::fs::read_to_string(dir.path().join("assets/TOKENS"))
                .unwrap()
                .trim(),
            ""
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&code).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn skips_when_both_files_are_already_valid() {
        let dir = tempfile::tempdir().unwrap();
        let uid = dir.path().join("device-uid");
        let code = dir.path().join("pairing-code");
        std::fs::write(&uid, format!("{UID}\n")).unwrap();
        std::fs::write(&code, format!("{CODE}\n")).unwrap();
        let assets = dir.path().join("assets");
        std::fs::create_dir_all(&assets).unwrap();
        write_tokens(&assets, &format!("ZZZZYYYYXXXXWWWWVVVV {CODE}\n"));
        assert_eq!(
            fetch_pairing_material_from_mag(
                &uid,
                &code,
                &MagFetchOptions {
                    assets_root: Some(assets.clone()),
                    ..Default::default()
                },
            ),
            MagFetchOutcome::AlreadyValid
        );
        assert_eq!(
            std::fs::read_to_string(assets.join("TOKENS")).unwrap(),
            format!("ZZZZYYYYXXXXWWWWVVVV {CODE}\n")
        );
    }

    #[test]
    fn a_uid_without_its_code_is_not_replaced_from_another_magazine() {
        let dir = tempfile::tempdir().unwrap();
        let uid = dir.path().join("device-uid");
        let code = dir.path().join("pairing-code");
        std::fs::write(&uid, format!("{UID}\n")).unwrap();
        let assets = dir.path().join("assets");
        std::fs::create_dir_all(&assets).unwrap();
        write_tokens(&assets, &format!("ZZZZYYYYXXXXWWWWVVVV {CODE}\n"));
        assert_eq!(
            fetch_pairing_material_from_mag(
                &uid,
                &code,
                &MagFetchOptions {
                    assets_root: Some(assets.clone()),
                    ..Default::default()
                },
            ),
            MagFetchOutcome::Incomplete
        );
        assert_eq!(std::fs::read_to_string(&uid).unwrap().trim(), UID);
        assert!(!code.exists());
        assert!(assets.join("TOKENS").exists());
    }

    #[test]
    fn a_code_without_a_uid_is_not_mixed_with_another_magazine_line() {
        let dir = tempfile::tempdir().unwrap();
        let uid = dir.path().join("device-uid");
        let code = dir.path().join("pairing-code");
        std::fs::write(&code, format!("{CODE}\n")).unwrap();
        let assets = dir.path().join("assets");
        std::fs::create_dir_all(&assets).unwrap();
        write_tokens(&assets, "ZZZZYYYYXXXXWWWWVVVV ABCDEF\n");

        assert_eq!(
            fetch_pairing_material_from_mag(
                &uid,
                &code,
                &MagFetchOptions {
                    assets_root: Some(assets.clone()),
                    max_attempts: 1,
                    retry_delay: Duration::from_millis(1),
                },
            ),
            MagFetchOutcome::Incomplete
        );
        assert!(!uid.exists());
        assert_eq!(std::fs::read_to_string(&code).unwrap().trim(), CODE);
        assert_eq!(
            std::fs::read_to_string(assets.join("TOKENS")).unwrap(),
            "ZZZZYYYYXXXXWWWWVVVV ABCDEF\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_linked_tokens_file_is_not_read_or_written_through() {
        let dir = tempfile::tempdir().unwrap();
        let assets = dir.path().join("assets");
        std::fs::create_dir_all(&assets).unwrap();
        let canary = dir.path().join("canary.txt");
        std::fs::write(&canary, format!("keep me\n{UID} {CODE}\n")).unwrap();
        std::os::unix::fs::symlink(&canary, assets.join("TOKENS")).unwrap();
        let uid = dir.path().join("device-uid");
        let code = dir.path().join("pairing-code");
        assert_eq!(
            fetch_pairing_material_from_mag(
                &uid,
                &code,
                &MagFetchOptions {
                    assets_root: Some(assets),
                    max_attempts: 1,
                    retry_delay: Duration::from_millis(1),
                },
            ),
            MagFetchOutcome::NoMagazine
        );
        assert_eq!(
            std::fs::read_to_string(&canary).unwrap(),
            format!("keep me\n{UID} {CODE}\n")
        );
        assert!(!uid.exists());
        assert!(!code.exists());
    }

    #[test]
    fn empty_magazine_returns_none() {
        let dir = tempfile::tempdir().unwrap();
        let assets = dir.path().join("assets");
        std::fs::create_dir_all(&assets).unwrap();
        write_tokens(&assets, "# comments only\n\n");
        assert_eq!(
            fetch_pairing_material_from_mag(
                &dir.path().join("device-uid"),
                &dir.path().join("pairing-code"),
                &MagFetchOptions {
                    assets_root: Some(assets),
                    max_attempts: 2,
                    retry_delay: Duration::from_millis(1),
                },
            ),
            MagFetchOutcome::NoMagazine
        );
    }
}

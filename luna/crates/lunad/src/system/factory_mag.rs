//! Read one device token from the LUNAASSETS `TOKENS` magazine.
//!
//! Each data line holds one device token. A line is normalized first (dashes,
//! spaces and underscores dropped, uppercased, I/L read as 1, O as 0) so a
//! hand-edited or grouped export still works, then it must be exactly 20
//! Crockford characters.

use std::path::{Path, PathBuf};
use std::thread;
use std::time::Duration;

use crate::drives::mount::{MOUNT_TIMEOUT, UNMOUNT_TIMEOUT, run_bounded};
use crate::net::connect::{is_device_token_format, normalize_device_token};
use crate::system::updates::lookup_device;

pub const MAG_RETRY_ATTEMPTS: u32 = 3;
pub const MAG_RETRY_DELAY: Duration = Duration::from_millis(500);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MagFetchOutcome {
    AlreadyValid,
    /// An owed unbind blocks pairing, so the magazine is not read.
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

/// Normalize a magazine line, then require exactly 20 Crockford characters.
/// A line that is still invalid after normalizing yields `None` and is dropped.
pub fn parse_factory_token_line(line: &str) -> Option<String> {
    let token = normalize_device_token(line);
    is_device_token_format(&token).then_some(token)
}

/// Populate the `device-token` file from the factory magazine.
pub fn fetch_device_token_from_mag(
    device_token_path: &Path,
    opts: &MagFetchOptions,
) -> MagFetchOutcome {
    if let Some(outcome) = preserve_existing_token(device_token_path) {
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
        let Some(token) = parse_factory_token_line(&line) else {
            if attempts < opts.max_attempts {
                thread::sleep(opts.retry_delay);
            }
            continue;
        };
        // The magazine read/peel can take a while. Recheck immediately before
        // committing so a token saved meanwhile is never overwritten.
        if let Some(outcome) = preserve_existing_token(device_token_path) {
            return outcome;
        }
        if write_private(device_token_path, &token).is_err() {
            if attempts < opts.max_attempts {
                thread::sleep(opts.retry_delay);
            }
            continue;
        }
        return MagFetchOutcome::Fetched { attempts };
    }
    MagFetchOutcome::ExhaustedRetries { attempts }
}

/// `None` means the file holds no usable token and the magazine may provision
/// one. A valid saved token is never replaced: Connect knows this Luna by it.
fn preserve_existing_token(device_token_path: &Path) -> Option<MagFetchOutcome> {
    let existing = read_trimmed(device_token_path)
        .map(|raw| normalize_device_token(&raw))
        .filter(|token| is_device_token_format(token));
    if existing.is_some() {
        return Some(MagFetchOutcome::AlreadyValid);
    }
    // Only a malformed file reaches here; it is not an identity.
    if device_token_path.is_file() {
        let _ = std::fs::remove_file(device_token_path);
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

    const TOKEN: &str = "7K4M2Q9XR8N36T5W1PZH";

    fn write_tokens(dir: &Path, body: &str) {
        std::fs::write(dir.join("TOKENS"), body).unwrap();
    }

    fn opts(assets: &Path, max_attempts: u32) -> MagFetchOptions {
        MagFetchOptions {
            assets_root: Some(assets.to_path_buf()),
            max_attempts,
            retry_delay: Duration::from_millis(1),
        }
    }

    #[test]
    fn factory_line_is_normalized_then_must_be_twenty_crockford_characters() {
        assert_eq!(
            parse_factory_token_line(&format!("  {TOKEN}  ")).as_deref(),
            Some(TOKEN)
        );
        assert_eq!(
            parse_factory_token_line("7k4m2q9xr8n36t5w1pzh").as_deref(),
            Some(TOKEN)
        );
        assert_eq!(
            parse_factory_token_line("7K4M-2Q9X-R8N3-6T5W-1PZH").as_deref(),
            Some(TOKEN)
        );
        assert_eq!(
            parse_factory_token_line("7k4m 2q9x r8n3 6t5w 1pzh").as_deref(),
            Some(TOKEN)
        );
        // Lookalikes: I and L read as 1, O as 0.
        assert_eq!(
            parse_factory_token_line("7K4M2Q9XR8N36T5WIPZH").as_deref(),
            Some("7K4M2Q9XR8N36T5W1PZH")
        );
        assert_eq!(parse_factory_token_line(&format!("{TOKEN} A3F91C")), None);
        assert_eq!(parse_factory_token_line(&TOKEN[..19]), None);
        assert_eq!(parse_factory_token_line(&format!("{TOKEN}2")), None);
        assert_eq!(parse_factory_token_line("7K4M2Q9XR8N36T5W1PZU"), None);
    }

    #[test]
    fn grouped_and_lowercase_magazine_lines_are_peeled() {
        let dir = tempfile::tempdir().unwrap();
        let assets = dir.path().join("assets");
        std::fs::create_dir_all(&assets).unwrap();
        write_tokens(&assets, "7k4m-2q9x-r8n3-6t5w-1pzh\nZZZZYYYYXXXXWWWWVVVV\n");
        let path = dir.path().join("device-token");
        assert_eq!(
            fetch_device_token_from_mag(&path, &opts(&assets, 3)),
            MagFetchOutcome::Fetched { attempts: 1 }
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap().trim(), TOKEN);
        assert_eq!(
            std::fs::read_to_string(assets.join("TOKENS")).unwrap(),
            "ZZZZYYYYXXXXWWWWVVVV\n"
        );
    }

    #[test]
    fn invalid_mag_line_is_retried_and_the_token_is_written() {
        let dir = tempfile::tempdir().unwrap();
        let assets = dir.path().join("assets");
        std::fs::create_dir_all(&assets).unwrap();
        write_tokens(&assets, &format!("not-a-token\n{TOKEN}\n"));
        let path = dir.path().join("device-token");
        assert_eq!(
            fetch_device_token_from_mag(&path, &opts(&assets, 3)),
            MagFetchOutcome::Fetched { attempts: 2 }
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap().trim(), TOKEN);
        assert_eq!(
            std::fs::read_to_string(assets.join("TOKENS"))
                .unwrap()
                .trim(),
            ""
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn skips_when_a_valid_token_is_already_saved() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("device-token");
        std::fs::write(&path, format!("{TOKEN}\n")).unwrap();
        let assets = dir.path().join("assets");
        std::fs::create_dir_all(&assets).unwrap();
        write_tokens(&assets, "ZZZZYYYYXXXXWWWWVVVV\n");
        assert_eq!(
            fetch_device_token_from_mag(&path, &opts(&assets, 3)),
            MagFetchOutcome::AlreadyValid
        );
        assert_eq!(
            std::fs::read_to_string(assets.join("TOKENS")).unwrap(),
            "ZZZZYYYYXXXXWWWWVVVV\n"
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap().trim(), TOKEN);
    }

    #[test]
    fn a_malformed_token_file_is_replaced_from_the_magazine() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("device-token");
        std::fs::write(&path, "short\n").unwrap();
        let assets = dir.path().join("assets");
        std::fs::create_dir_all(&assets).unwrap();
        write_tokens(&assets, &format!("{TOKEN}\n"));
        assert_eq!(
            fetch_device_token_from_mag(&path, &opts(&assets, 3)),
            MagFetchOutcome::Fetched { attempts: 1 }
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap().trim(), TOKEN);
    }

    #[test]
    fn no_magazine_and_exhausted_retries_are_reported() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("device-token");
        let missing = dir.path().join("none");
        assert_eq!(
            fetch_device_token_from_mag(&path, &opts(&missing, 3)),
            MagFetchOutcome::NoMagazine
        );
        let assets = dir.path().join("assets");
        std::fs::create_dir_all(&assets).unwrap();
        write_tokens(&assets, "garbage\nmore garbage\n");
        assert!(matches!(
            fetch_device_token_from_mag(&path, &opts(&assets, 2)),
            MagFetchOutcome::ExhaustedRetries { .. }
        ));
        assert!(!path.exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_linked_tokens_file_is_not_read_or_written_through() {
        let dir = tempfile::tempdir().unwrap();
        let assets = dir.path().join("assets");
        std::fs::create_dir_all(&assets).unwrap();
        // The stick's TOKENS is a link to a file the Luna owns.
        let canary = dir.path().join("canary.txt");
        std::fs::write(&canary, format!("keep me\n{TOKEN}\n")).unwrap();
        std::os::unix::fs::symlink(&canary, assets.join("TOKENS")).unwrap();
        let token = dir.path().join("device-token");
        let out = fetch_device_token_from_mag(&token, &opts(&assets, 1));
        assert_eq!(out, MagFetchOutcome::NoMagazine);
        assert_eq!(
            std::fs::read_to_string(&canary).unwrap(),
            format!("keep me\n{TOKEN}\n")
        );
        assert!(!token.exists());
    }

    #[test]
    fn empty_magazine_returns_none() {
        let dir = tempfile::tempdir().unwrap();
        let assets = dir.path().join("assets");
        std::fs::create_dir_all(&assets).unwrap();
        write_tokens(&assets, "# comments only\n\n");
        let out = fetch_device_token_from_mag(&dir.path().join("device-token"), &opts(&assets, 2));
        assert_eq!(out, MagFetchOutcome::NoMagazine);
    }
}

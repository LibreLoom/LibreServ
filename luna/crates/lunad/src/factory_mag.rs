//! Peel an official device token from the LUNAASSETS `TOKENS` magazine.
//!
//! Used during first-run setup when `{data_dir}/device-token` is missing or
//! malformed. Retries when a peeled line is not a valid device token.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::Duration;

use crate::connect::{group_device_token, is_device_token_format, normalize_setup_code};

pub const MAG_RETRY_ATTEMPTS: u32 = 3;
pub const MAG_RETRY_DELAY: Duration = Duration::from_millis(500);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MagFetchOutcome {
    AlreadyValid,
    NoMagazine,
    Fetched { attempts: u32 },
    ExhaustedRetries { attempts: u32 },
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

/// Try to populate `token_path` from the factory magazine when it is missing or invalid.
pub fn fetch_device_token_from_mag(token_path: &Path, opts: &MagFetchOptions) -> MagFetchOutcome {
    if token_path
        .is_file()
        .then(|| std::fs::read_to_string(token_path).ok())
        .flatten()
        .is_some_and(|raw| is_valid_device_token(&raw))
    {
        return MagFetchOutcome::AlreadyValid;
    }
    if token_path.is_file() {
        let _ = std::fs::remove_file(token_path);
    }

    let mut attempts = 0u32;
    while attempts < opts.max_attempts {
        attempts += 1;
        let Some(peeled) = peel_one_token(opts) else {
            return if attempts == 1 {
                MagFetchOutcome::NoMagazine
            } else {
                MagFetchOutcome::ExhaustedRetries { attempts }
            };
        };
        if !is_valid_device_token(&peeled) {
            if attempts < opts.max_attempts {
                thread::sleep(opts.retry_delay);
            }
            continue;
        }
        if write_device_token(token_path, &peeled).is_ok() {
            return MagFetchOutcome::Fetched { attempts };
        }
        if attempts < opts.max_attempts {
            thread::sleep(opts.retry_delay);
        }
    }
    MagFetchOutcome::ExhaustedRetries { attempts }
}

fn is_valid_device_token(raw: &str) -> bool {
    let norm = normalize_setup_code(raw.trim());
    is_device_token_format(&norm)
}

fn write_device_token(path: &Path, raw: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let norm = normalize_setup_code(raw.trim());
    let grouped = group_device_token(&norm);
    std::fs::write(path, format!("{grouped}\n"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn peel_one_token(opts: &MagFetchOptions) -> Option<String> {
    if let Some(root) = &opts.assets_root {
        return peel_from_dir(root);
    }
    let guard = mount_lunaassets().ok()?;
    let tok = peel_from_dir(&guard.path);
    drop(guard);
    tok
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
    let text = std::fs::read_to_string(path).ok()?;
    for line in text.lines() {
        let trimmed = line.trim().trim_start_matches('\r');
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        return Some(trimmed.to_string());
    }
    None
}

fn tokens_drop_first(path: &Path) -> std::io::Result<()> {
    let text = std::fs::read_to_string(path)?;
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
    std::fs::write(path, kept)
}

struct AssetsMount {
    path: PathBuf,
    mounted: bool,
}

impl Drop for AssetsMount {
    fn drop(&mut self) {
        if self.mounted {
            let _ = Command::new("umount").arg(&self.path).status();
            let _ = std::fs::remove_dir(&self.path);
        }
    }
}

fn mount_lunaassets() -> Result<AssetsMount, ()> {
    let dev = Command::new("blkid")
        .args(["-L", "LUNAASSETS"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            Command::new("findfs")
                .arg("LABEL=LUNAASSETS")
                .output()
                .ok()
                .filter(|o| o.status.success())
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                .filter(|s| !s.is_empty())
        })
        .ok_or(())?;

    let tmp = std::env::temp_dir().join(format!("luna-assets-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).map_err(|_| ())?;
    let ok = Command::new("mount")
        .args(["-t", "vfat", "-o", "rw,utf8,umask=000"])
        .arg(&dev)
        .arg(&tmp)
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
        || Command::new("mount")
            .args(["-o", "rw,umask=000"])
            .arg(&dev)
            .arg(&tmp)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
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

    fn write_tokens(dir: &Path, body: &str) {
        std::fs::write(dir.join("TOKENS"), body).unwrap();
    }

    #[test]
    fn invalid_mag_line_is_retried() {
        let dir = tempfile::tempdir().unwrap();
        let assets = dir.path().join("assets");
        std::fs::create_dir_all(&assets).unwrap();
        write_tokens(&assets, "not-a-code\nABCD-EFGH-JKMN-PQRS-TVWX\n");
        let token = dir.path().join("device-token");
        let opts = MagFetchOptions {
            assets_root: Some(assets),
            max_attempts: 3,
            retry_delay: Duration::from_millis(1),
        };
        let out = fetch_device_token_from_mag(&token, &opts);
        assert_eq!(out, MagFetchOutcome::Fetched { attempts: 2 });
        assert_eq!(
            std::fs::read_to_string(&token).unwrap().trim(),
            "ABCD-EFGH-JKMN-PQRS-TVWX"
        );
        let tokens_path = dir.path().join("assets/TOKENS");
        assert_eq!(std::fs::read_to_string(tokens_path).unwrap().trim(), "");
    }

    #[test]
    fn skips_when_token_already_valid() {
        let dir = tempfile::tempdir().unwrap();
        let token = dir.path().join("device-token");
        std::fs::write(&token, "ABCD-EFGH-JKMN-PQRS-TVWX\n").unwrap();
        let assets = dir.path().join("assets");
        std::fs::create_dir_all(&assets).unwrap();
        write_tokens(&assets, "ZZZZ-YYYY-XXXX-WWWW-VVVV\n");
        let out = fetch_device_token_from_mag(
            &token,
            &MagFetchOptions {
                assets_root: Some(assets.clone()),
                ..Default::default()
            },
        );
        assert_eq!(out, MagFetchOutcome::AlreadyValid);
        assert_eq!(
            std::fs::read_to_string(assets.join("TOKENS")).unwrap(),
            "ZZZZ-YYYY-XXXX-WWWW-VVVV\n"
        );
    }

    #[test]
    fn empty_magazine_returns_none() {
        let dir = tempfile::tempdir().unwrap();
        let assets = dir.path().join("assets");
        std::fs::create_dir_all(&assets).unwrap();
        write_tokens(&assets, "# comments only\n\n");
        let out = fetch_device_token_from_mag(
            &dir.path().join("device-token"),
            &MagFetchOptions {
                assets_root: Some(assets),
                max_attempts: 2,
                retry_delay: Duration::from_millis(1),
            },
        );
        assert_eq!(out, MagFetchOutcome::NoMagazine);
    }
}

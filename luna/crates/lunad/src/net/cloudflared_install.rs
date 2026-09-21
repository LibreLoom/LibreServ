//! On-demand cloudflared download: pinned release + SHA-256, HTTPS only, ELF check before chmod.

use sha2::{Digest, Sha256};
use std::path::Path;
use std::process::Command;

/// Minimum accepted download size (bytes).
pub const MIN_CLOUDFLARED_BYTES: u64 = 1024;

/// Pinned cloudflared release for on-demand install (not `/latest/`).
/// Bump deliberately when Cloudflare publishes a release Luna should take.
/// When bumping, also refresh [`CLOUDFLARED_SHA256_AMD64`] and [`CLOUDFLARED_SHA256_ARM64`]
/// from the GitHub release notes for that tag.
pub const CLOUDFLARED_RELEASE: &str = "2026.8.3";

/// Official SHA-256 for `cloudflared-linux-amd64` at [`CLOUDFLARED_RELEASE`].
pub const CLOUDFLARED_SHA256_AMD64: &str =
    "f29324fe934d1e100617484c78deef803c4dc2cd351d645bbde42e96b4fccc5e";

/// Official SHA-256 for `cloudflared-linux-arm64` at [`CLOUDFLARED_RELEASE`].
pub const CLOUDFLARED_SHA256_ARM64: &str =
    "4bcfd35521a7cbc545ebfd5d57334a71ee180e2a64874981f374c81472118391";

pub fn cloudflared_arch() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" | "arm64" => "arm64",
        _ => "amd64",
    }
}

/// Expected SHA-256 hex digest for the current host arch binary.
pub fn cloudflared_expected_sha256() -> &'static str {
    match cloudflared_arch() {
        "arm64" => CLOUDFLARED_SHA256_ARM64,
        _ => CLOUDFLARED_SHA256_AMD64,
    }
}

/// True when `path` starts with ELF magic (`\x7fELF`).
pub fn cloudflared_download_is_elf(path: &Path) -> bool {
    match std::fs::read(path) {
        Ok(bytes) if bytes.len() >= 4 => bytes[..4] == [0x7f, b'E', b'L', b'F'],
        _ => false,
    }
}

/// Hex SHA-256 of the file at `path`.
pub fn cloudflared_file_sha256(path: &Path) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let digest = Sha256::digest(&bytes);
    Ok(format!("{digest:x}"))
}

/// HTTPS download URL for the pinned arch binary.
pub fn cloudflared_install_url() -> String {
    format!(
        "https://github.com/cloudflare/cloudflared/releases/download/{release}/cloudflared-linux-{arch}",
        release = CLOUDFLARED_RELEASE,
        arch = cloudflared_arch(),
    )
}

/// Download pinned cloudflared into `dest`, verifying size, SHA-256, and ELF before chmod + rename.
pub fn install_cloudflared_to(dest: &Path) -> Result<(), String> {
    let Some(parent) = dest.parent() else {
        return Err("invalid cloudflared install path".into());
    };
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let url = cloudflared_install_url();
    tracing::info!(
        path = %dest.display(),
        arch = cloudflared_arch(),
        release = CLOUDFLARED_RELEASE,
        "downloading cloudflared for Connect tunnel (on-demand install)"
    );
    let tmp = parent.join("cloudflared.tmp");
    let _ = std::fs::remove_file(&tmp);

    // Bound downloads + HTTPS only: refuse cleartext and hang forever on a half-up network.
    let downloaded = if Command::new("curl")
        .args([
            "-fsSL",
            "--proto",
            "=https",
            "--tlsv1.2",
            "--connect-timeout",
            "10",
            "--max-time",
            "120",
            "-o",
        ])
        .arg(&tmp)
        .arg(&url)
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
    {
        true
    } else {
        Command::new("wget")
            .args(["-q", "--https-only", "--timeout=30", "--tries=2", "-O"])
            .arg(&tmp)
            .arg(&url)
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    };
    if !downloaded {
        let _ = std::fs::remove_file(&tmp);
        return Err("could not download cloudflared (curl/wget failed)".into());
    }

    let meta = match std::fs::metadata(&tmp) {
        Ok(m) => m,
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            return Err(e.to_string());
        }
    };
    if meta.len() < MIN_CLOUDFLARED_BYTES || !cloudflared_download_is_elf(&tmp) {
        let _ = std::fs::remove_file(&tmp);
        return Err("downloaded cloudflared failed size or ELF checks".into());
    }

    let actual = match cloudflared_file_sha256(&tmp) {
        Ok(h) => h,
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            return Err(e);
        }
    };
    let expected = cloudflared_expected_sha256();
    if !actual.eq_ignore_ascii_case(expected) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!(
            "downloaded cloudflared SHA-256 mismatch (got {actual}, want {expected})"
        ));
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = meta.permissions();
        perms.set_mode(0o755);
        if let Err(e) = std::fs::set_permissions(&tmp, perms) {
            let _ = std::fs::remove_file(&tmp);
            return Err(e.to_string());
        }
    }

    std::fs::rename(&tmp, dest).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn cloudflared_download_is_elf_rejects_scripts() {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("x");
        let mut f = std::fs::File::create(&script).unwrap();
        writeln!(f, "#!/bin/sh").unwrap();
        assert!(!cloudflared_download_is_elf(&script));

        let elfish = dir.path().join("y");
        let mut f = std::fs::File::create(&elfish).unwrap();
        f.write_all(&[0x7f, b'E', b'L', b'F', 0, 0, 0, 0]).unwrap();
        assert!(cloudflared_download_is_elf(&elfish));
    }

    #[test]
    fn cloudflared_install_url_is_pinned_release() {
        let url = cloudflared_install_url();
        assert!(url.starts_with("https://"));
        assert!(url.contains(CLOUDFLARED_RELEASE));
        assert!(!url.contains("/latest/"));
        assert!(url.contains("cloudflared-linux-"));
    }

    #[test]
    fn cloudflared_expected_sha256_is_64_hex_for_release() {
        let amd = CLOUDFLARED_SHA256_AMD64;
        let arm = CLOUDFLARED_SHA256_ARM64;
        assert_eq!(amd.len(), 64);
        assert_eq!(arm.len(), 64);
        assert!(amd.chars().all(|c| c.is_ascii_hexdigit()));
        assert!(arm.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(amd, arm);
        let expected = cloudflared_expected_sha256();
        assert!(expected == amd || expected == arm);
    }

    #[test]
    fn cloudflared_file_sha256_matches_known_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("blob");
        std::fs::write(&path, b"hello").unwrap();
        let got = cloudflared_file_sha256(&path).unwrap();
        assert_eq!(
            got,
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
    }
}

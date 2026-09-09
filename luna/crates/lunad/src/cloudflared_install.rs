//! On-demand cloudflared download: pinned release, HTTPS only, ELF check before chmod.

use std::path::Path;
use std::process::Command;

/// Minimum accepted download size (bytes).
pub const MIN_CLOUDFLARED_BYTES: u64 = 1024;

/// Pinned cloudflared release for on-demand install (not `/latest/`).
/// Bump deliberately when Cloudflare publishes a release Luna should take.
pub const CLOUDFLARED_RELEASE: &str = "2026.8.3";

pub fn cloudflared_arch() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" | "arm64" => "arm64",
        _ => "amd64",
    }
}

/// True when `path` starts with ELF magic (`\x7fELF`).
pub fn cloudflared_download_is_elf(path: &Path) -> bool {
    match std::fs::read(path) {
        Ok(bytes) if bytes.len() >= 4 => bytes[..4] == [0x7f, b'E', b'L', b'F'],
        _ => false,
    }
}

/// HTTPS download URL for the pinned arch binary.
pub fn cloudflared_install_url() -> String {
    format!(
        "https://github.com/cloudflare/cloudflared/releases/download/{release}/cloudflared-linux-{arch}",
        release = CLOUDFLARED_RELEASE,
        arch = cloudflared_arch(),
    )
}

/// Download pinned cloudflared into `dest`, verifying size + ELF before chmod + rename.
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
}

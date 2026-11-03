//! The ext4 filesystem Luna puts inside an encrypted drive.
//!
//! Encrypted drives are always ext4 inside their container. Turning encryption
//! on or off reformats the drive rather than converting it in place, so the
//! only tooling needed here is `mkfs.ext4` and a way to read free space.

use std::path::Path;
use std::process::Stdio;

/// A fresh ext4 inside a container. `-m 0` keeps no root-reserved blocks: a
/// drive is not a system disk, and the 5% default is a lot of a small stick.
pub fn mkfs_ext4(device: &str, label: &str) -> anyhow::Result<()> {
    let bin = crate::sandbox::which("mkfs.ext4").ok_or_else(|| {
        anyhow::anyhow!(
            "Luna can't prepare drives. This Luna is missing a program it needs (mkfs.ext4)."
        )
    })?;
    let mut cmd = crate::sandbox::hardened(&bin);
    cmd.args(["-q", "-F", "-m", "0", "-L", label, device])
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let out = crate::sandbox::output_limited(&mut cmd, std::time::Duration::from_secs(300))?;
    if out.status.success() {
        return Ok(());
    }
    Err(anyhow::anyhow!(
        "Luna couldn't prepare this drive. {}",
        String::from_utf8_lossy(&out.stderr).trim()
    ))
}

/// Free bytes on the filesystem at `mount_point`.
pub fn free_bytes(mount_point: &Path) -> Option<u64> {
    let c = std::ffi::CString::new(mount_point.as_os_str().as_encoded_bytes()).ok()?;
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut stat) } != 0 {
        return None;
    }
    let frsize = if stat.f_frsize == 0 {
        stat.f_bsize as u64
    } else {
        stat.f_frsize as u64
    };
    Some((stat.f_bavail as u64).saturating_mul(frsize))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn free_space_is_read_from_a_real_directory() {
        // /tmp is a mounted filesystem on any box that runs these tests.
        let free = free_bytes(Path::new("/tmp")).expect("statvfs on /tmp");
        assert!(free > 0);
    }

    #[test]
    fn a_missing_directory_has_no_free_space_to_report() {
        assert_eq!(free_bytes(Path::new("/luna/no/such/path")), None);
    }
}

//! The ext4 filesystem Luna puts inside an encrypted drive, and the shrink an
//! in-place conversion needs before it can start.
//!
//! Encrypted drives are always ext4 inside. That is the whole reason a
//! conversion is possible at all: ext4 can be shrunk, so the LUKS2 header has
//! somewhere to live. exFAT, FAT32 and NTFS cannot be shrunk by any tool Luna
//! ships, so those drives are converted by copying into a new container rather
//! than in place.

use std::path::Path;
use std::process::Stdio;

/// Room the LUKS2 header needs at the front of the partition. `cryptsetup`
/// documents "twice the default LUKS2 header size" for in-place encryption,
/// i.e. 32 MiB, and `--reduce-device-size 32m` is the value its own examples
/// use. Anything less and the conversion has nowhere to put the header.
pub const HEADER_BYTES: u64 = 32 * 1024 * 1024;

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

/// The filesystem's size in bytes, or `None` when it cannot be read.
pub fn fs_size_bytes(device: &str) -> Option<u64> {
    let bin = crate::sandbox::which("dumpe2fs")?;
    let mut cmd = crate::sandbox::hardened(&bin);
    cmd.args(["-h", device])
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let out = crate::sandbox::output_limited(&mut cmd, std::time::Duration::from_secs(60)).ok()?;
    if !out.status.success() {
        return None;
    }
    parse_ext4_size(&String::from_utf8_lossy(&out.stdout))
}

/// Read `Block count` × `Block size` out of a `dumpe2fs -h` dump.
pub fn parse_ext4_size(dump: &str) -> Option<u64> {
    let mut blocks = None;
    let mut size = None;
    for line in dump.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim();
        match key.trim() {
            "Block count" => blocks = value.parse::<u64>().ok(),
            "Block size" => size = value.parse::<u64>().ok(),
            _ => {}
        }
    }
    blocks?.checked_mul(size?)
}

/// The filesystem's block size in bytes, or `None` when it cannot be read.
pub fn fs_block_size(device: &str) -> Option<u64> {
    let bin = crate::sandbox::which("dumpe2fs")?;
    let mut cmd = crate::sandbox::hardened(&bin);
    cmd.args(["-h", device])
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let out = crate::sandbox::output_limited(&mut cmd, std::time::Duration::from_secs(60)).ok()?;
    if !out.status.success() {
        return None;
    }
    parse_ext4_block_size(&String::from_utf8_lossy(&out.stdout))
}

/// Read `Block size` out of a `dumpe2fs -h` dump.
pub fn parse_ext4_block_size(dump: &str) -> Option<u64> {
    for line in dump.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        if key.trim() == "Block size" {
            return value.trim().parse().ok();
        }
    }
    None
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

/// Does this filesystem have room for the header, so it can be converted in
/// place? The check is on the *filesystem*, not the partition: a full ext4 has
/// no tail to give up even if the partition is large.
pub fn can_shrink_for_header(device: &str) -> bool {
    let Some(size) = fs_size_bytes(device) else {
        return false;
    };
    // A filesystem smaller than the header plus a usable amount of data is not
    // worth converting; refuse rather than produce a container that cannot
    // hold anything.
    size > HEADER_BYTES + 64 * 1024 * 1024
}

/// Shrink the filesystem by [`HEADER_BYTES`] so the LUKS2 header has room.
/// Must run on an unmounted filesystem.
///
/// This is the step that makes in-place encryption safe. `cryptsetup
/// reencrypt --encrypt` does NOT shrink the filesystem for you — it assumes
/// the tail is already free and silently corrupts the filesystem if it is not.
pub fn shrink_for_header(device: &str) -> anyhow::Result<()> {
    let size = fs_size_bytes(device).ok_or_else(|| {
        anyhow::anyhow!(
            "Luna couldn't read this drive's filesystem, so it can't encrypt it safely."
        )
    })?;
    if size <= HEADER_BYTES + 64 * 1024 * 1024 {
        anyhow::bail!(
            "This drive is too small to encrypt. Luna needs about 100 MB of room to add encryption."
        );
    }
    // resize2fs refuses to shrink a filesystem it has not checked, and it is
    // right to: shrinking is the one step that can lose data if the filesystem
    // is inconsistent. Check first, and stop if the check finds anything it
    // cannot fix on its own.
    check_filesystem(device)?;
    // resize2fs takes a block count, not bytes. Asking for a byte count is
    // read as an enormous number of blocks and refused.
    let block_size = fs_block_size(device).ok_or_else(|| {
        anyhow::anyhow!(
            "Luna couldn't read this drive's filesystem, so it can't encrypt it safely."
        )
    })?;
    let target_blocks = (size - HEADER_BYTES) / block_size;
    let bin = crate::sandbox::which("resize2fs").ok_or_else(|| {
        anyhow::anyhow!(
            "Luna can't encrypt drives. This Luna is missing a program it needs (resize2fs)."
        )
    })?;
    let mut cmd = crate::sandbox::hardened(&bin);
    cmd.args([device, &format!("{target_blocks}")])
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let out = crate::sandbox::output_limited(&mut cmd, std::time::Duration::from_secs(600))?;
    if out.status.success() {
        return Ok(());
    }
    Err(anyhow::anyhow!(
        "Luna couldn't make room for encryption on this drive. {}",
        String::from_utf8_lossy(&out.stderr).trim()
    ))
}

/// Run `e2fsck -f -p` before a shrink. Exit code 0 is clean, 1 means it fixed
/// something (still fine), and anything above 1 means the filesystem has a
/// problem Luna will not paper over — shrinking it then would lose files.
fn check_filesystem(device: &str) -> anyhow::Result<()> {
    let bin = crate::sandbox::which("e2fsck").ok_or_else(|| {
        anyhow::anyhow!(
            "Luna can't encrypt drives. This Luna is missing a program it needs (e2fsck)."
        )
    })?;
    let mut cmd = crate::sandbox::hardened(&bin);
    cmd.args(["-f", "-p", device])
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let out = crate::sandbox::output_limited(&mut cmd, std::time::Duration::from_secs(600))?;
    match out.status.code() {
        Some(0) | Some(1) => Ok(()),
        _ => Err(anyhow::anyhow!(
            "Luna found a problem with this drive's files so it stopped before changing anything. {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )),
    }
}

/// Grow the filesystem to fill whatever container it is in. Used after a
/// conversion so the drive uses the space the header gave back.
pub fn grow_to_fill(device: &str) -> anyhow::Result<()> {
    let bin = crate::sandbox::which("resize2fs").ok_or_else(|| {
        anyhow::anyhow!(
            "Luna can't finish this drive. This Luna is missing a program it needs (resize2fs)."
        )
    })?;
    let mut cmd = crate::sandbox::hardened(&bin);
    cmd.arg(device).stdout(Stdio::null()).stderr(Stdio::piped());
    let out = crate::sandbox::output_limited(&mut cmd, std::time::Duration::from_secs(600))?;
    if out.status.success() {
        return Ok(());
    }
    Err(anyhow::anyhow!(
        "Luna couldn't finish this drive. {}",
        String::from_utf8_lossy(&out.stderr).trim()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ext4_size_is_blocks_times_block_size() {
        let dump = "Filesystem volume name:   <none>\n\
                    Block count:              57344\n\
                    Reserved block count:     2866\n\
                    Block size:               4096\n";
        assert_eq!(parse_ext4_size(dump), Some(57344 * 4096));
    }

    #[test]
    fn a_dump_without_both_values_has_no_size() {
        assert_eq!(parse_ext4_size("Block count: 100\n"), None);
        assert_eq!(parse_ext4_size("Block size: 4096\n"), None);
        assert_eq!(parse_ext4_size(""), None);
    }

    #[test]
    fn block_size_is_read_from_the_dump() {
        let dump = "Block count: 57344\nBlock size: 4096\n";
        assert_eq!(parse_ext4_block_size(dump), Some(4096));
        assert_eq!(parse_ext4_block_size("Block count: 1\n"), None);
    }

    #[test]
    fn the_shrink_target_is_a_block_count_not_a_byte_count() {
        // resize2fs reads its size argument as blocks. Passing bytes asks for
        // 234881024 blocks on a 65536-block filesystem, which it refuses.
        // This is the arithmetic the shrink uses.
        let size = 268_435_456u64; // 256 MiB
        let block = 4096u64;
        let target_blocks = (size - HEADER_BYTES) / block;
        assert_eq!(target_blocks, 57_344);
        // The byte count would be absurd by comparison.
        assert!(target_blocks < size);
    }

    #[test]
    fn the_header_allowance_matches_cryptsetup() {
        // cryptsetup's own examples use --reduce-device-size 32m, and the man
        // page calls 32 MiB the recommended minimum for encryption mode.
        assert_eq!(HEADER_BYTES, 32 * 1024 * 1024);
    }
}

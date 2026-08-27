//! Weekly idle-hours `fstrim` on TRIM-capable adopted data drives.
//!
//! Reuses the scrub quiet window (local 1–5 AM + idle) with a weekly gap so
//! flash GC happens without racing interactive I/O. Spinning disks and devices
//! without discard support are skipped.

use std::path::{Path, PathBuf};
use std::process::Command;

use rusqlite::Connection;

use crate::db;
use crate::scrub::{PERIODIC_IDLE_SECS, in_night_window};

/// At least six days between fstrim passes.
pub const FSTRIM_MIN_GAP_SECS: i64 = 6 * 24 * 60 * 60;

pub fn should_run_fstrim(
    running: bool,
    local_hour: u32,
    last_run_unix: Option<i64>,
    last_activity_unix: i64,
    now_unix: i64,
) -> bool {
    if running {
        return false;
    }
    if !in_night_window(local_hour) {
        return false;
    }
    if let Some(last) = last_run_unix
        && now_unix.saturating_sub(last) < FSTRIM_MIN_GAP_SECS
    {
        return false;
    }
    if last_activity_unix > 0 && now_unix.saturating_sub(last_activity_unix) < PERIODIC_IDLE_SECS {
        return false;
    }
    true
}

/// True when the block device behind `mount` advertises discard/TRIM.
pub fn mount_supports_discard(mount: &Path) -> bool {
    let Ok(source) = find_mount_source(mount) else {
        return false;
    };
    discard_max_bytes(&source).unwrap_or(0) > 0
}

fn find_mount_source(mount: &Path) -> anyhow::Result<PathBuf> {
    let mounts = std::fs::read_to_string("/proc/mounts")?;
    let want = mount.to_string_lossy();
    for line in mounts.lines() {
        let mut parts = line.split_whitespace();
        let Some(src) = parts.next() else {
            continue;
        };
        let Some(dst) = parts.next() else {
            continue;
        };
        if dst == want.as_ref() {
            return Ok(PathBuf::from(src));
        }
    }
    anyhow::bail!("mount not found")
}

fn discard_max_bytes(device: &Path) -> anyhow::Result<u64> {
    // /dev/sda1 → sda; /dev/nvme0n1p2 → nvme0n1; /dev/mapper/x → skip sysfs
    let name = device
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| anyhow::anyhow!("bad device"))?;
    let sys_name = resolve_sys_block_name(name);
    let path = PathBuf::from(format!(
        "/sys/block/{sys_name}/queue/discard_max_bytes"
    ));
    let raw = std::fs::read_to_string(path)?;
    Ok(raw.trim().parse().unwrap_or(0))
}

fn resolve_sys_block_name(partition: &str) -> String {
    if partition.starts_with("nvme") || partition.starts_with("mmcblk") {
        if let Some((disk, part)) = partition.rsplit_once('p')
            && !part.is_empty()
            && part.chars().all(|c| c.is_ascii_digit())
        {
            return disk.to_string();
        }
        return partition.to_string();
    }
    let trimmed = partition.trim_end_matches(|c: char| c.is_ascii_digit());
    if trimmed.is_empty() {
        partition.to_string()
    } else {
        trimmed.to_string()
    }
}

pub fn fstrim_mount(mount: &Path) -> anyhow::Result<()> {
    let status = Command::new("fstrim").arg(mount).status()?;
    if !status.success() {
        anyhow::bail!("fstrim exited {}", status.code().unwrap_or(-1));
    }
    Ok(())
}

/// Trim every adopted as_is mount that supports discard. Returns how many ran.
pub fn fstrim_all_drives(conn: &Connection) -> anyhow::Result<u64> {
    let drives = db::list_drives(conn).unwrap_or_default();
    let mut n = 0u64;
    for drive in drives {
        if drive.state != "as_is" || drive.mount_point.is_empty() {
            continue;
        }
        let root = PathBuf::from(&drive.mount_point);
        if !mount_supports_discard(&root) {
            continue;
        }
        match fstrim_mount(&root) {
            Ok(()) => n += 1,
            Err(err) => tracing::warn!(drive = %drive.id, error = %err, "fstrim skipped"),
        }
    }
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn weekly_idle_gates() {
        assert!(!should_run_fstrim(true, 2, None, 0, 1_000));
        assert!(!should_run_fstrim(false, 14, None, 0, 1_000));
        assert!(should_run_fstrim(false, 2, None, 0, 1_000));
        assert!(!should_run_fstrim(false, 2, None, 990, 1_000));
        let week = FSTRIM_MIN_GAP_SECS;
        assert!(!should_run_fstrim(
            false,
            2,
            Some(1_000 - week + 10),
            0,
            1_000
        ));
        assert!(should_run_fstrim(
            false,
            2,
            Some(1_000 - week - 10),
            0,
            1_000
        ));
    }

    #[test]
    fn sys_block_name_strips_partition() {
        assert_eq!(resolve_sys_block_name("sda1"), "sda");
        assert_eq!(resolve_sys_block_name("nvme0n1p2"), "nvme0n1");
        assert_eq!(resolve_sys_block_name("mmcblk0p1"), "mmcblk0");
        assert_eq!(resolve_sys_block_name("sda"), "sda");
    }
}

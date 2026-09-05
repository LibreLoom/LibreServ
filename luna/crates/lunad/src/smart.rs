//! SMART drive health via `smartctl` — only for traditional spinning hard drives.
//!
//! USB sticks, SSDs, and NVMe drives are ignored: wear reporting isn't useful
//! for Luna's users on those media, so we don't run checks or show messages.

use serde::Serialize;
use std::process::Command;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DriveHealth {
    pub available: bool,
    pub overall: String,
    pub model: Option<String>,
    pub serial: Option<String>,
    pub temperature_c: Option<i64>,
    pub reallocated_sectors: Option<u64>,
}

/// True when this block device is a rotational hard drive worth a SMART read.
pub fn applicable(device: &str) -> bool {
    let disk = disk_name(device);
    if disk.is_empty() {
        return false;
    }
    if disk.starts_with("nvme") || disk.starts_with("mmcblk") || disk.starts_with("loop") {
        return false;
    }
    rotational(&disk)
}

fn disk_name(device: &str) -> String {
    let name = device.trim().strip_prefix("/dev/").unwrap_or(device.trim());
    parent_disk(name).unwrap_or_else(|| name.to_string())
}

/// Strip partition suffixes: `sda1` → `sda`, `nvme0n1p2` → `nvme0n1`.
fn parent_disk(name: &str) -> Option<String> {
    let mut end = name.len();
    while end > 0 && name.as_bytes()[end - 1].is_ascii_digit() {
        end -= 1;
    }
    if end == name.len() {
        return None;
    }
    let mut core = &name[..end];
    if let Some(stripped) = core.strip_suffix('p') {
        core = stripped;
    }
    if core.is_empty() {
        None
    } else {
        Some(core.to_string())
    }
}

fn rotational(disk: &str) -> bool {
    std::fs::read_to_string(format!("/sys/block/{disk}/queue/rotational"))
        .map(|s| s.trim() == "1")
        .unwrap_or(false)
}

pub fn read(device: &str) -> DriveHealth {
    if !applicable(device) {
        return DriveHealth {
            available: false,
            overall: "unknown".into(),
            model: None,
            serial: None,
            temperature_c: None,
            reallocated_sectors: None,
        };
    }
    let mut health = DriveHealth {
        available: false,
        overall: "unknown".into(),
        model: None,
        serial: None,
        temperature_c: None,
        reallocated_sectors: None,
    };
    let Ok(output) = Command::new("smartctl")
        .args(["-H", "-A", "-i", &format!("/dev/{device}")])
        .output()
    else {
        return health;
    };
    if !output.status.success() {
        return health;
    }
    health.available = true;
    parse(&String::from_utf8_lossy(&output.stdout), &mut health);
    health
}

fn parse(output: &str, health: &mut DriveHealth) {
    for line in output.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("SMART overall-health self-assessment test result:") {
            health.overall = if rest.trim().contains("PASSED") {
                "passed".into()
            } else {
                rest.trim().into()
            };
        }
        if let Some(rest) = line.strip_prefix("Model Family:") {
            health.model = Some(rest.trim().into());
        } else if let Some(rest) = line.strip_prefix("Device Model:") {
            health.model = Some(rest.trim().into());
        }
        if let Some(rest) = line.strip_prefix("Serial Number:") {
            health.serial = Some(rest.trim().into());
        }
        // SMART attribute tables: "194 Temperature_Celsius 0x0022 ... 045 ... 35"
        if line.contains("Temperature_Celsius")
            && let Some(value) = smart_raw(line)
        {
            health.temperature_c = Some(value);
        }
        if line.contains("Reallocated_Sector_Ct")
            && let Some(value) = smart_raw(line)
        {
            health.reallocated_sectors = Some(value as u64);
        }
    }
}

fn smart_raw(line: &str) -> Option<i64> {
    let cols: Vec<&str> = line.split_whitespace().collect();
    if cols.len() < 10 {
        return None;
    }
    // smartctl -A: id, name, flags, value, worst, thresh, type, updated, when_failed, raw
    cols.get(9).and_then(|v| v.parse().ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disk_name_strips_partitions() {
        assert_eq!(disk_name("sda1"), "sda");
        assert_eq!(disk_name("/dev/sdb2"), "sdb");
        assert_eq!(disk_name("nvme0n1p2"), "nvme0n1");
    }

    #[test]
    fn applicable_ignores_empty_nvme_and_mmc() {
        assert!(!applicable(""));
        assert!(!applicable("nvme0n1"));
        assert!(!applicable("nvme0n1p2"));
        assert!(!applicable("mmcblk0"));
        assert!(!applicable("mmcblk0p1"));
        assert!(!applicable("loop0"));
    }

    #[test]
    fn parses_smartctl_output() {
        let output = "\
smartctl 7.4 2023-08-01
Model Family:     Seagate Backup Plus
Device Model:     ST2000LM007
Serial Number:    ABC123
SMART overall-health self-assessment test result: PASSED
ID# ATTRIBUTE_NAME          FLAG     VALUE WORST THRESH TYPE      UPDATED  WHEN_FAILED RAW_VALUE
194 Temperature_Celsius     0x0022   100   100   000    Old_age   Always   -       31
  5 Reallocated_Sector_Ct   0x0033   100   100   010    Pre-fail  Always   -       0
";
        let mut h = DriveHealth {
            available: true,
            overall: "unknown".into(),
            model: None,
            serial: None,
            temperature_c: None,
            reallocated_sectors: None,
        };
        parse(output, &mut h);
        assert_eq!(h.overall, "passed");
        assert_eq!(h.model.as_deref(), Some("ST2000LM007"));
        assert_eq!(h.serial.as_deref(), Some("ABC123"));
        assert_eq!(h.temperature_c, Some(31));
        assert_eq!(h.reallocated_sectors, Some(0));
    }
}

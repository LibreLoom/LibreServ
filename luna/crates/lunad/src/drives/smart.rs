//! SMART drive health via `smartctl` — only for traditional spinning hard drives.
//!
//! USB sticks, SSDs, and NVMe drives are ignored: wear reporting isn't useful
//! for Luna's users on those media, so we don't run checks or show messages.
//!
//! The JSON this module serves (`GET /api/v1/drives/:id/health`) is a contract
//! shared with the web UI. Both read `verdict` and `signals`; neither compares
//! raw numbers to thresholds.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;

/// Replaced spots at or above this count are failing. 100 is Luna's own line,
/// not a SMART standard.
const REALLOCATED_FAILING: u64 = 100;
/// The limit used when a drive doesn't report its own. Common hard-drive
/// datasheets put the operating maximum at 55-70°C, so "typical" is a guess.
const TYPICAL_MAX_TEMP_C: i64 = 60;
/// Within this many degrees below the limit, a temperature is a note.
const WARM_MARGIN_C: i64 = 10;
/// How long a SMART report is reused before smartctl runs again.
const CACHE_TTL: Duration = Duration::from_secs(10 * 60);
/// smartctl runs for at most this long.
const SMARTCTL_TIMEOUT: Duration = Duration::from_secs(45);

/// smartctl exit bits (smartctl(8)). Bits 0-1 are command failures and make
/// the output unusable. Bit 2 means one SMART command failed, which is not a
/// verdict on the drive.
const EXIT_SELF_CHECK_FAILING: i32 = 0b1000;
const EXIT_PREFAIL_PAST_THRESHOLD: i32 = 0b1_0000;
const EXIT_WORN_IN_PAST: i32 = 0b10_0000;
const EXIT_ERROR_LOG: i32 = 0b100_0000;
const EXIT_SELF_TEST_LOG: i32 = 0b1000_0000;

/// The overall answer. `Unknown` means there is not enough to judge.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Verdict {
    Ok,
    Watch,
    Failing,
    Unknown,
}

/// How serious one signal is. `Note` does not change the verdict.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Level {
    Note,
    Watch,
    Failing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SignalKind {
    SelfCheckFailed,
    WornPastLimit,
    PendingSectors,
    UncorrectableSectors,
    ReallocatedSectors,
    WornInPast,
    ErrorLog,
    SelfTestErrors,
    Temperature,
}

/// One thing the judge found. `value` is the reading, `limit` the line it
/// was compared with.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Signal {
    pub kind: SignalKind,
    pub level: Level,
    pub value: Option<i64>,
    pub limit: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DriveHealth {
    pub available: bool,
    /// Why there is no report: `not_a_hard_drive` or `no_report`. `None` when
    /// `available` is true.
    pub reason: Option<&'static str>,
    pub verdict: Verdict,
    /// `passed`, `failed` or `unknown`.
    pub overall: String,
    pub model: Option<String>,
    pub serial: Option<String>,
    pub temperature_c: Option<i64>,
    pub temperature_max_c: i64,
    /// `drive` when the drive reports its own limit, otherwise `typical`.
    pub temperature_max_source: &'static str,
    pub reallocated_sectors: Option<u64>,
    pub pending_sectors: Option<u64>,
    pub uncorrectable_sectors: Option<u64>,
    /// smartctl exit bits 2-7 — the drive findings (failing, past-fail,
    /// error-log entries). Zero on a clean read; kept for diagnosis.
    pub status_bits: u8,
    /// Failing first, then watch, then note. Table order inside each level.
    pub signals: Vec<Signal>,
    /// The drive's own recommended maximum temperature, when it reports one
    /// between 40 and 90°C. Internal: `judge` turns it into the limit above.
    #[serde(skip)]
    pub sct_max_c: Option<i64>,
}

/// A report with no readings. `reason` says why there is none.
pub fn empty(reason: Option<&'static str>) -> DriveHealth {
    DriveHealth {
        available: false,
        reason,
        verdict: Verdict::Unknown,
        overall: "unknown".into(),
        model: None,
        serial: None,
        temperature_c: None,
        temperature_max_c: TYPICAL_MAX_TEMP_C,
        temperature_max_source: "typical",
        reallocated_sectors: None,
        pending_sectors: None,
        uncorrectable_sectors: None,
        status_bits: 0,
        signals: Vec::new(),
        sct_max_c: None,
    }
}

/// Fills in the temperature limit, the signals (sorted) and the verdict from
/// the readings. Pure: it doesn't touch the drive, so it can be tested alone.
pub fn judge(h: &mut DriveHealth) {
    let (max, source) = match h.sct_max_c {
        Some(max) => (max, "drive"),
        None => (TYPICAL_MAX_TEMP_C, "typical"),
    };
    h.temperature_max_c = max;
    h.temperature_max_source = source;

    let mut signals = Vec::new();
    let bits = i32::from(h.status_bits);
    if h.overall == "failed" {
        signals.push(signal(
            SignalKind::SelfCheckFailed,
            Level::Failing,
            None,
            None,
        ));
    }
    if bits & EXIT_PREFAIL_PAST_THRESHOLD != 0 {
        signals.push(signal(
            SignalKind::WornPastLimit,
            Level::Failing,
            None,
            None,
        ));
    }
    // Spots the drive could not read: the files there may already be damaged.
    if let Some(n) = h.pending_sectors.filter(|&n| n > 0) {
        signals.push(signal(
            SignalKind::PendingSectors,
            Level::Failing,
            Some(n as i64),
            None,
        ));
    }
    if let Some(n) = h.uncorrectable_sectors.filter(|&n| n > 0) {
        signals.push(signal(
            SignalKind::UncorrectableSectors,
            Level::Failing,
            Some(n as i64),
            None,
        ));
    }
    if let Some(n) = h.reallocated_sectors.filter(|&n| n > 0) {
        let level = if n >= REALLOCATED_FAILING {
            Level::Failing
        } else {
            Level::Watch
        };
        signals.push(signal(
            SignalKind::ReallocatedSectors,
            level,
            Some(n as i64),
            Some(REALLOCATED_FAILING as i64),
        ));
    }
    if bits & EXIT_WORN_IN_PAST != 0 {
        signals.push(signal(SignalKind::WornInPast, Level::Watch, None, None));
    }
    if bits & EXIT_ERROR_LOG != 0 {
        signals.push(signal(SignalKind::ErrorLog, Level::Watch, None, None));
    }
    if bits & EXIT_SELF_TEST_LOG != 0 {
        signals.push(signal(SignalKind::SelfTestErrors, Level::Watch, None, None));
    }
    if let Some(t) = h.temperature_c {
        if t >= max {
            signals.push(signal(
                SignalKind::Temperature,
                Level::Watch,
                Some(t),
                Some(max),
            ));
        } else if t >= max - WARM_MARGIN_C {
            signals.push(signal(
                SignalKind::Temperature,
                Level::Note,
                Some(t),
                Some(max),
            ));
        }
    }
    signals.sort_by_key(|s| match s.level {
        Level::Failing => 0,
        Level::Watch => 1,
        Level::Note => 2,
    });

    h.verdict = if !h.available {
        Verdict::Unknown
    } else if signals.iter().any(|s| s.level == Level::Failing) {
        Verdict::Failing
    } else if signals.iter().any(|s| s.level == Level::Watch) {
        Verdict::Watch
    } else if h.overall == "passed" {
        Verdict::Ok
    } else {
        Verdict::Unknown
    };
    h.signals = signals;
}

fn signal(kind: SignalKind, level: Level, value: Option<i64>, limit: Option<i64>) -> Signal {
    Signal {
        kind,
        level,
        value,
        limit,
    }
}

/// True when this block device is a rotational hard drive worth a SMART read.
pub fn applicable(device: &str) -> bool {
    if !is_plain_device_name(device) {
        return false;
    }
    let disk = disk_name(device);
    if disk.is_empty() {
        return false;
    }
    if disk.starts_with("nvme") || disk.starts_with("mmcblk") || disk.starts_with("loop") {
        return false;
    }
    rotational(&disk)
}

/// A kernel block-device name (`sda1`, `nvme0n1p2`, `dm-0`), optionally with
/// `/dev/`. Anything else — path separators, dots, flags — never reaches
/// `/sys` or `smartctl`.
fn is_plain_device_name(device: &str) -> bool {
    let name = device.trim().strip_prefix("/dev/").unwrap_or(device.trim());
    !name.is_empty()
        && name.len() <= 32
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        && !name.starts_with('-')
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

type ReportCache = Mutex<HashMap<String, (Instant, DriveHealth)>>;

/// Last usable SMART report per device, kept for `CACHE_TTL`. Read by
/// `read`; a sleeping or unusable drive falls back to its entry at any age.
fn cache() -> &'static ReportCache {
    static CACHE: OnceLock<ReportCache> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cached(key: &str) -> Option<(Instant, DriveHealth)> {
    cache().lock().ok()?.get(key).cloned()
}

/// The judged SMART health of `device`.
pub fn read(device: &str) -> DriveHealth {
    let mut health = read_or_cached(device);
    judge(&mut health);
    health
}

fn read_or_cached(device: &str) -> DriveHealth {
    if !applicable(device) {
        return empty(Some("not_a_hard_drive"));
    }
    let key = device.trim().trim_start_matches("/dev/").to_string();
    let last = cached(&key);
    if let Some((read_at, health)) = &last
        && read_at.elapsed() < CACHE_TTL
    {
        return health.clone();
    }
    match run_smartctl(device) {
        Some(fresh) => {
            if let Ok(mut map) = cache().lock() {
                map.insert(key, (Instant::now(), fresh.clone()));
            }
            fresh
        }
        // A sleeping disk or a failed run keeps the last known report.
        None => match last {
            Some((_, health)) => health,
            None => empty(Some("no_report")),
        },
    }
}

/// Runs smartctl once. `None` when no usable report came back: smartctl is
/// missing, timed out, failed, or the drive was asleep and `-n standby`
/// skipped it.
fn run_smartctl(device: &str) -> Option<DriveHealth> {
    let smartctl = crate::sandbox::which("smartctl")?;
    // smartctl reports on drive-supplied data, but it must stay root: the
    // SG_IO ioctls it issues need a device fd opened read-write (which would
    // be root-equivalent if handed to `nobody`), and seccomp can't filter
    // inside a SCSI command block. Scrubbed env + no_new_privs + a timeout
    // is the hardening that fits.
    let mut cmd = crate::sandbox::hardened(&smartctl);
    cmd.args([
        // `-n standby`: don't wake a sleeping disk. smartctl skips it instead.
        "-n",
        "standby",
        "-H",
        "-A",
        "-i",
        "-l",
        "scttemp",
        &format!("/dev/{}", device.trim().trim_start_matches("/dev/")),
    ])
    .stderr(std::process::Stdio::null());
    let output = crate::sandbox::output_limited(&mut cmd, SMARTCTL_TIMEOUT).ok()?;
    // smartctl exits with a bitmask: bits 0-1 mean the command itself failed
    // (bad args, device unreadable) — stdout is unusable. Bits 2-7 are drive
    // findings (failing, past-fail, error logs) that still come with full
    // output, so parse it and report the failing state instead of going
    // silent.
    let code = output.status.code().unwrap_or(-1);
    if !smartctl_output_usable(code) {
        return None;
    }
    let mut health = empty(None);
    health.available = true;
    health.status_bits = (code & 0b1111_1100) as u8;
    parse(&String::from_utf8_lossy(&output.stdout), &mut health);
    // Bit 3 is the drive's own "DISK FAILING" verdict. Bit 2 alone is not.
    if code & EXIT_SELF_CHECK_FAILING != 0 {
        health.overall = "failed".into();
    }
    Some(health)
}

/// Exit-status bitmask per smartctl(8): only bits 0-1 (bad command line,
/// device open/parse failure) mean the output can't be trusted.
fn smartctl_output_usable(code: i32) -> bool {
    code >= 0 && code & 0b11 == 0
}

fn parse(output: &str, health: &mut DriveHealth) {
    // Attribute 194 is the usual temperature. 190 (Airflow_Temperature_Cel)
    // is the fallback for drives that report only that one.
    let mut saw_194 = false;
    let mut airflow: Option<i64> = None;
    for line in output.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("SMART overall-health self-assessment test result:") {
            health.overall = if rest.trim().contains("PASSED") {
                "passed".into()
            } else {
                "failed".into()
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
        // `-l scttemp`: "Min/Max recommended Temperature:  0/60 Celsius".
        // "-/-" and "0/0" mean the drive reports no limit.
        if let Some(rest) = line.strip_prefix("Min/Max recommended Temperature:") {
            let max = rest
                .split_whitespace()
                .next()
                .and_then(|pair| pair.split_once('/'))
                .and_then(|(_, max)| max.parse::<i64>().ok());
            if let Some(max) = max.filter(|max| (40..=90).contains(max)) {
                health.sct_max_c = Some(max);
            }
        }
        // SMART attribute tables: "194 Temperature_Celsius 0x0022 ... 045 ... 35"
        if line.contains("Temperature_Celsius")
            && let Some(value) = smart_raw(line)
        {
            health.temperature_c = Some(value);
            saw_194 = true;
        }
        if line.contains("Airflow_Temperature_Cel")
            && let Some(value) = smart_raw(line)
        {
            airflow = Some(value);
        }
        if line.contains("Reallocated_Sector_Ct")
            && let Some(value) = smart_raw(line)
        {
            health.reallocated_sectors = Some(value as u64);
        }
        if line.contains("Current_Pending_Sector")
            && let Some(value) = smart_raw(line)
        {
            health.pending_sectors = Some(value.max(0) as u64);
        }
        if line.contains("Offline_Uncorrectable")
            && let Some(value) = smart_raw(line)
        {
            health.uncorrectable_sectors = Some(value.max(0) as u64);
        }
    }
    if !saw_194 && let Some(value) = airflow {
        health.temperature_c = Some(value);
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

    /// A drive that reported a passing self-check, for the judge tests.
    fn passing() -> DriveHealth {
        let mut h = empty(None);
        h.available = true;
        h.overall = "passed".into();
        h
    }

    fn kinds(h: &DriveHealth) -> Vec<SignalKind> {
        h.signals.iter().map(|s| s.kind).collect()
    }

    #[test]
    fn disk_name_strips_partitions() {
        assert_eq!(disk_name("sda1"), "sda");
        assert_eq!(disk_name("/dev/sdb2"), "sdb");
        assert_eq!(disk_name("nvme0n1p2"), "nvme0n1");
    }

    #[test]
    fn device_names_are_whitelisted() {
        assert!(is_plain_device_name("sda1"));
        assert!(is_plain_device_name("/dev/nvme0n1p2"));
        assert!(is_plain_device_name("dm-0"));
        for bad in [
            "",
            "../sda",
            "sda/../../etc",
            "sda;rm",
            "-H",
            "sda 1",
            "sd.a",
            "/dev/",
        ] {
            assert!(!is_plain_device_name(bad), "{bad:?}");
            assert!(!applicable(bad), "{bad:?}");
        }
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
        let mut h = empty(None);
        h.available = true;
        parse(output, &mut h);
        assert_eq!(h.overall, "passed");
        assert_eq!(h.model.as_deref(), Some("ST2000LM007"));
        assert_eq!(h.serial.as_deref(), Some("ABC123"));
        assert_eq!(h.temperature_c, Some(31));
        assert_eq!(h.reallocated_sectors, Some(0));
    }

    #[test]
    fn parse_reads_pending_uncorrectable_and_airflow() {
        let output = "\
197 Current_Pending_Sector  0x0012   100   100   000    Old_age   Always       -       3
198 Offline_Uncorrectable   0x0010   100   100   000    Old_age   Offline      -       2
190 Airflow_Temperature_Cel 0x0022   064   050   040    Old_age   Always       -       36 (Min/Max 18/30)
";
        let mut h = empty(None);
        h.available = true;
        parse(output, &mut h);
        assert_eq!(h.pending_sectors, Some(3));
        assert_eq!(h.uncorrectable_sectors, Some(2));
        assert_eq!(h.temperature_c, Some(36), "190 is the fallback temperature");
    }

    #[test]
    fn parse_lets_194_win_over_190_in_either_order() {
        let temp_194 =
            "194 Temperature_Celsius     0x0022   100   100   000    Old_age   Always   -       31";
        let airflow =
            "190 Airflow_Temperature_Cel 0x0022   064   050   040    Old_age   Always   -       36";
        for output in [
            format!("{temp_194}\n{airflow}\n"),
            format!("{airflow}\n{temp_194}\n"),
        ] {
            let mut h = empty(None);
            h.available = true;
            parse(&output, &mut h);
            assert_eq!(h.temperature_c, Some(31));
        }
    }

    #[test]
    fn parse_reads_sct_recommended_max() {
        let read_max = |line: &str| {
            let mut h = empty(None);
            parse(line, &mut h);
            h.sct_max_c
        };
        assert_eq!(
            read_max("Min/Max recommended Temperature:      0/60 Celsius"),
            Some(60)
        );
        assert_eq!(
            read_max("Min/Max recommended Temperature:      0/0 Celsius"),
            None
        );
        assert_eq!(
            read_max("Min/Max recommended Temperature:      -/- Celsius"),
            None
        );
        assert_eq!(
            read_max("Min/Max recommended Temperature:      0/120 Celsius"),
            None,
            "outside 40..=90 is ignored"
        );
    }

    #[test]
    fn parse_normalizes_failed_text() {
        let mut h = empty(None);
        parse(
            "SMART overall-health self-assessment test result: FAILED!\n",
            &mut h,
        );
        assert_eq!(h.overall, "failed");
        let mut h = empty(None);
        parse(
            "SMART overall-health self-assessment test result: PASSED\n",
            &mut h,
        );
        assert_eq!(h.overall, "passed");
    }

    #[test]
    fn judge_ok_clean() {
        let mut h = passing();
        h.temperature_c = Some(34);
        judge(&mut h);
        assert_eq!(h.verdict, Verdict::Ok);
        assert!(h.signals.is_empty());
        assert_eq!(h.temperature_max_c, TYPICAL_MAX_TEMP_C);
        assert_eq!(h.temperature_max_source, "typical");
    }

    #[test]
    fn judge_watch_few_reallocated() {
        let mut h = passing();
        h.reallocated_sectors = Some(4);
        judge(&mut h);
        assert_eq!(h.verdict, Verdict::Watch);
        let top = &h.signals[0];
        assert_eq!(top.kind, SignalKind::ReallocatedSectors);
        assert_eq!(top.level, Level::Watch);
        assert_eq!(top.value, Some(4));
        assert_eq!(top.limit, Some(100));
    }

    #[test]
    fn judge_failing_many_reallocated() {
        let mut h = passing();
        h.reallocated_sectors = Some(120);
        judge(&mut h);
        assert_eq!(h.verdict, Verdict::Failing);
        assert_eq!(h.signals[0].level, Level::Failing);
        assert_eq!(h.signals[0].value, Some(120));
        assert_eq!(h.signals[0].limit, Some(100));
    }

    #[test]
    fn judge_failing_self_check() {
        let mut h = passing();
        h.overall = "failed".into();
        judge(&mut h);
        assert_eq!(h.verdict, Verdict::Failing);
        assert_eq!(kinds(&h), vec![SignalKind::SelfCheckFailed]);
    }

    #[test]
    fn judge_failing_pending() {
        let mut h = passing();
        h.pending_sectors = Some(2);
        judge(&mut h);
        assert_eq!(h.verdict, Verdict::Failing);
        assert_eq!(h.signals[0].kind, SignalKind::PendingSectors);
        assert_eq!(h.signals[0].value, Some(2));
    }

    #[test]
    fn judge_temperature_levels() {
        let temp_at = |t: i64, sct: Option<i64>| {
            let mut h = passing();
            h.temperature_c = Some(t);
            h.sct_max_c = sct;
            judge(&mut h);
            h
        };
        let normal = temp_at(48, None);
        assert!(normal.signals.is_empty(), "48C is normal");
        assert_eq!(normal.verdict, Verdict::Ok);

        let warm = temp_at(55, None);
        assert_eq!(kinds(&warm), vec![SignalKind::Temperature]);
        assert_eq!(warm.signals[0].level, Level::Note);
        assert_eq!(
            warm.verdict,
            Verdict::Ok,
            "a note does not change the verdict"
        );

        let hot = temp_at(61, None);
        assert_eq!(hot.signals[0].level, Level::Watch);
        assert_eq!(hot.verdict, Verdict::Watch);
        assert_eq!(hot.signals[0].limit, Some(60));

        let drive_limit = temp_at(61, Some(70));
        assert_eq!(drive_limit.signals[0].level, Level::Note);
        assert_eq!(drive_limit.temperature_max_source, "drive");
        assert_eq!(drive_limit.temperature_max_c, 70);
    }

    #[test]
    fn judge_bit2_alone_is_ok() {
        let mut h = passing();
        h.status_bits = 0b100;
        judge(&mut h);
        assert_eq!(h.verdict, Verdict::Ok);
        assert!(h.signals.is_empty());
    }

    #[test]
    fn judge_bits_3_4_fail_and_5_6_7_watch() {
        let mut h = passing();
        h.overall = "failed".into();
        judge(&mut h);
        assert_eq!(h.verdict, Verdict::Failing, "bit 3 fails");

        let mut h = passing();
        h.status_bits = 0b1_0000;
        judge(&mut h);
        assert_eq!(h.verdict, Verdict::Failing, "bit 4 fails");
        assert_eq!(kinds(&h), vec![SignalKind::WornPastLimit]);

        let mut h = passing();
        h.status_bits = 0b1110_0000;
        judge(&mut h);
        assert_eq!(h.verdict, Verdict::Watch, "bits 5-7 watch");
        assert_eq!(
            kinds(&h),
            vec![
                SignalKind::WornInPast,
                SignalKind::ErrorLog,
                SignalKind::SelfTestErrors
            ]
        );
    }

    #[test]
    fn judge_unknown_without_report() {
        let mut h = empty(Some("no_report"));
        judge(&mut h);
        assert_eq!(h.verdict, Verdict::Unknown);
        assert_eq!(h.reason, Some("no_report"));
        assert_eq!(h.temperature_max_source, "typical");
    }

    #[test]
    fn read_of_non_hard_drive_says_so() {
        let h = read("");
        assert!(!h.available);
        assert_eq!(h.reason, Some("not_a_hard_drive"));
        assert_eq!(h.verdict, Verdict::Unknown);
    }

    #[test]
    fn judge_unknown_when_overall_unknown_and_no_signals() {
        let mut h = passing();
        h.overall = "unknown".into();
        judge(&mut h);
        assert_eq!(h.verdict, Verdict::Unknown);
    }

    #[test]
    fn signals_sorted_failing_first() {
        let mut h = passing();
        h.temperature_c = Some(55);
        h.status_bits = EXIT_ERROR_LOG as u8;
        h.pending_sectors = Some(1);
        judge(&mut h);
        let levels: Vec<Level> = h.signals.iter().map(|s| s.level).collect();
        assert_eq!(levels, vec![Level::Failing, Level::Watch, Level::Note]);
    }

    #[test]
    fn health_json_has_contract_keys() {
        let mut h = passing();
        h.model = Some("ST2000LM007".into());
        h.serial = Some("ABC123".into());
        h.temperature_c = Some(55);
        h.reallocated_sectors = Some(120);
        h.status_bits = 0b1000;
        h.overall = "failed".into();
        h.sct_max_c = Some(70);
        judge(&mut h);
        let json = serde_json::to_value(&h).unwrap();
        let obj = json.as_object().unwrap();
        for key in [
            "available",
            "reason",
            "verdict",
            "overall",
            "model",
            "serial",
            "temperature_c",
            "temperature_max_c",
            "temperature_max_source",
            "reallocated_sectors",
            "pending_sectors",
            "uncorrectable_sectors",
            "status_bits",
            "signals",
        ] {
            assert!(obj.contains_key(key), "missing {key}");
        }
        assert!(!obj.contains_key("sct_max_c"), "internal field stays out");
        assert_eq!(json["verdict"], "failing");
        assert_eq!(json["overall"], "failed");
        assert_eq!(json["reason"], serde_json::Value::Null);
        assert_eq!(json["temperature_max_source"], "drive");
        assert_eq!(json["signals"][0]["kind"], "self_check_failed");
        assert_eq!(json["signals"][0]["level"], "failing");
        assert_eq!(json["signals"][0]["value"], serde_json::Value::Null);
        assert_eq!(json["signals"][1]["kind"], "reallocated_sectors");
        assert_eq!(json["signals"][1]["limit"], 100);
    }

    #[test]
    fn cache_keeps_the_last_report_by_device() {
        let key = format!("cache-test-{}", std::process::id());
        let mut h = passing();
        h.model = Some("CACHED".into());
        cache()
            .lock()
            .unwrap()
            .insert(key.clone(), (Instant::now(), h.clone()));
        let (_, back) = cached(&key).expect("entry is stored");
        assert_eq!(back, h);
    }

    #[test]
    fn smartctl_drive_findings_keep_their_output() {
        // Bits 0-1 = command failures → unusable. Bits 2-7 = drive findings
        // (failing, past-fail, error logs) → stdout is still complete.
        assert!(smartctl_output_usable(0));
        for code in [0b100, 0b1000, 0b1_0000, 0b10_0000, 0b100_0000, 0b1111_1100] {
            assert!(smartctl_output_usable(code), "{code:#09b}");
        }
        for code in [1, 2, 3, -1] {
            assert!(!smartctl_output_usable(code), "{code}");
        }
    }
}

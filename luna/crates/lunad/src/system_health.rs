//! Comprehensive Luna system health checks — filesystem, database, disk space,
//! and per-drive read/write probes with optional SMART reports.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rusqlite::Connection;
use serde::Serialize;
use serde_json::{Value, json};

use crate::drives::DriveManager;
use crate::smart;
use crate::summary;

const MIN_FREE_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
pub struct HealthCheckResult {
    pub status: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
    pub category: String,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct HealthCheckSummary {
    pub total_checks: usize,
    pub passed: usize,
    pub failed: usize,
    pub skipped: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct ComprehensiveHealthResponse {
    pub status: String,
    pub timestamp: i64,
    pub overall_pass: bool,
    pub checks: HashMap<String, HealthCheckResult>,
    pub summary: HealthCheckSummary,
}

#[derive(Debug, Clone, Serialize)]
pub struct PreflightCheckResult {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub category: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disk_space_bytes_free: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PreflightResponse {
    pub checks: HashMap<String, PreflightCheckResult>,
    pub healthy: bool,
    pub timestamp: i64,
}

#[derive(Clone)]
pub struct HealthCache {
    inner: Arc<Mutex<HealthCacheInner>>,
}

struct HealthCacheInner {
    cached: Option<(Instant, ComprehensiveHealthResponse)>,
    refreshing: bool,
}

impl Default for HealthCache {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(HealthCacheInner {
                cached: None,
                refreshing: false,
            })),
        }
    }
}

impl HealthCache {
    const TTL: Duration = Duration::from_secs(60);

    pub fn should_refresh(&self) -> bool {
        let guard = self.inner.lock().unwrap();
        match guard.cached.as_ref() {
            None => true,
            Some((at, _)) => at.elapsed() >= Self::TTL,
        }
    }

    pub fn get(&self) -> Option<ComprehensiveHealthResponse> {
        let guard = self.inner.lock().unwrap();
        guard.cached.as_ref().map(|(_, v)| v.clone())
    }

    pub fn set(&self, value: ComprehensiveHealthResponse) {
        let mut guard = self.inner.lock().unwrap();
        guard.cached = Some((Instant::now(), value));
        guard.refreshing = false;
    }

    pub fn mark_refreshing(&self) {
        self.inner.lock().unwrap().refreshing = true;
    }
}

pub fn run_preflight(data_dir: &Path, conn: &Connection) -> PreflightResponse {
    let mut checks = HashMap::new();
    let mut healthy = true;

    let mut add =
        |name: &str, category: &str, ok: bool, error: Option<String>, free: Option<u64>| {
            if !ok {
                healthy = false;
            }
            checks.insert(
                name.to_string(),
                PreflightCheckResult {
                    status: if ok { "ok".into() } else { "failed".into() },
                    error,
                    category: category.into(),
                    disk_space_bytes_free: free,
                },
            );
        };

    let db_ok = conn.query_row("SELECT 1", [], |_| Ok(())).is_ok();
    add(
        "database",
        "system",
        db_ok,
        (!db_ok).then(|| "Luna couldn't open its database.".into()),
        None,
    );

    let db_dir = data_dir.join("luna.db").parent().map(Path::to_path_buf);
    if let Some(dir) = db_dir {
        let (ok, msg) = path_writable_message(&dir, "database folder");
        add(
            "database_writable",
            "storage",
            ok,
            (!ok).then_some(msg),
            None,
        );
    }

    let (data_ok, data_msg) = path_writable_message(data_dir, "Luna data folder");
    add(
        "data_path_writable",
        "storage",
        data_ok,
        (!data_ok).then_some(data_msg),
        None,
    );

    let logs_dir = data_dir.join("logs");
    let (logs_ok, logs_msg) = path_writable_message(&logs_dir, "logs folder");
    add(
        "logs_path_writable",
        "storage",
        logs_ok,
        (!logs_ok).then_some(logs_msg),
        None,
    );

    let mut disk_free = None;
    let disk_ok = match summary::disk_space(data_dir) {
        Some(space) => {
            disk_free = Some(space.free_bytes);
            space.free_bytes >= MIN_FREE_BYTES
        }
        None => false,
    };
    add(
        "disk_space",
        "system",
        disk_ok,
        (!disk_ok).then(|| {
            if disk_free.is_some() {
                "Luna needs at least 512 MB of free space on its system disk.".into()
            } else {
                "Luna couldn't read free space on its system disk.".into()
            }
        }),
        disk_free,
    );

    add("api_server", "system", true, None, None);

    PreflightResponse {
        checks,
        healthy,
        timestamp: crate::db::now_unix(),
    }
}

pub fn run_comprehensive(
    data_dir: &Path,
    conn: &Connection,
    _drive_manager: &DriveManager,
) -> ComprehensiveHealthResponse {
    let preflight = run_preflight(data_dir, conn);
    let drives = crate::db::list_drives(conn).unwrap_or_default();
    finish_comprehensive(data_dir, preflight, drives)
}

/// Drive probes and SMART reads — callers must not hold the DB lock.
pub fn finish_comprehensive(
    _data_dir: &Path,
    preflight: PreflightResponse,
    drives: Vec<crate::db::DriveRow>,
) -> ComprehensiveHealthResponse {
    let mut checks = HashMap::new();
    let mut summary = HealthCheckSummary::default();

    for (name, check) in preflight.checks {
        let passed = check.status == "ok";
        let status = if passed { "passed" } else { "failed" };
        summary.total_checks += 1;
        if passed {
            summary.passed += 1;
        } else {
            summary.failed += 1;
        }
        let message = if passed {
            match name.as_str() {
                "disk_space" => {
                    if let Some(free) = check.disk_space_bytes_free {
                        format!("{} free on Luna's system disk.", human_bytes(free))
                    } else {
                        "Enough free space.".into()
                    }
                }
                "database" => "Database is working.".into(),
                "api_server" => "Luna is running.".into(),
                _ => "OK.".into(),
            }
        } else {
            check
                .error
                .clone()
                .unwrap_or_else(|| "This check failed.".into())
        };
        checks.insert(
            name,
            HealthCheckResult {
                status: status.into(),
                message,
                details: check
                    .disk_space_bytes_free
                    .map(|free| json!({ "free_bytes": free, "free_human": human_bytes(free) })),
                category: check.category,
            },
        );
    }

    for drive in drives {
            if drive.state == "missing" || drive.state == "ejected" {
                continue;
            }
            let label = if drive.label.trim().is_empty() {
                "Drive".into()
            } else {
                drive.label.clone()
            };
            let rw_name = format!("drive_{}_read_write", drive.id);
            let smart_name = format!("drive_{}_smart", drive.id);

            if drive.state == "readonly" || drive.mount_point.is_empty() {
                summary.total_checks += 1;
                summary.failed += 1;
                checks.insert(
                    rw_name,
                    HealthCheckResult {
                        status: "failed".into(),
                        message: format!(
                            "{label} is read-only or not mounted — Luna can't save new files there."
                        ),
                        details: Some(json!({ "drive_id": drive.id, "drive_label": label })),
                        category: "drives".into(),
                    },
                );
            } else {
                let mount = PathBuf::from(&drive.mount_point);
                let writable = crate::drives::probe_writable(&mount).is_ok();
                summary.total_checks += 1;
                if writable {
                    summary.passed += 1;
                    checks.insert(
                        rw_name,
                        HealthCheckResult {
                            status: "passed".into(),
                            message: format!("{label} passed a read-and-write test."),
                            details: Some(json!({ "drive_id": drive.id, "drive_label": label })),
                            category: "drives".into(),
                        },
                    );
                } else {
                    summary.failed += 1;
                    checks.insert(
                        rw_name,
                        HealthCheckResult {
                            status: "failed".into(),
                            message: format!(
                                "{label} didn't pass a write test. Open Drives to see what Luna found."
                            ),
                            details: Some(json!({ "drive_id": drive.id, "drive_label": label })),
                            category: "drives".into(),
                        },
                    );
                }
            }

            summary.total_checks += 1;
            if drive.device.is_empty() {
                summary.skipped += 1;
                checks.insert(
                    smart_name,
                    HealthCheckResult {
                        status: "skipped".into(),
                        message: format!(
                            "No hardware health report for {label} — Luna doesn't have drive details yet."
                        ),
                        details: Some(json!({ "drive_id": drive.id, "drive_label": label })),
                        category: "drives".into(),
                    },
                );
            } else {
                let health = smart::read(&drive.device);
                if !health.available {
                    summary.skipped += 1;
                    checks.insert(
                        smart_name,
                        HealthCheckResult {
                            status: "skipped".into(),
                            message: format!(
                                "This {label} drive doesn't report hardware health, or Luna can't read it. Your files may still be fine."
                            ),
                            details: Some(json!({ "drive_id": drive.id, "drive_label": label })),
                            category: "drives".into(),
                        },
                    );
                } else if health.overall == "passed" {
                    summary.passed += 1;
                    let worn = health.reallocated_sectors.unwrap_or(0) > 0;
                    let mut msg = if worn {
                        format!(
                            "{label} is still working, but it has repaired some worn spots. Copy important files off it soon."
                        )
                    } else {
                        format!("{label} reported no hardware problems.")
                    };
                    if let Some(temp) = health.temperature_c {
                        msg.push_str(&format!(" It's about {temp}°C."));
                    }
                    checks.insert(
                        smart_name,
                        HealthCheckResult {
                            status: "passed".into(),
                            message: msg,
                            details: Some(json!({
                                "drive_id": drive.id,
                                "drive_label": label,
                                "temperature_c": health.temperature_c,
                                "reallocated_sectors": health.reallocated_sectors,
                            })),
                            category: "drives".into(),
                        },
                    );
                } else {
                    summary.failed += 1;
                    checks.insert(
                        smart_name,
                        HealthCheckResult {
                            status: "failed".into(),
                            message: format!(
                                "{label} reported a hardware problem. Copy your files somewhere else soon."
                            ),
                            details: Some(json!({
                                "drive_id": drive.id,
                                "drive_label": label,
                                "overall": health.overall,
                            })),
                            category: "drives".into(),
                        },
                    );
                }
            }
    }

    let overall_pass = summary.failed == 0;
    ComprehensiveHealthResponse {
        status: if overall_pass {
            "healthy".into()
        } else {
            "unhealthy".into()
        },
        timestamp: crate::db::now_unix(),
        overall_pass,
        checks,
        summary,
    }
}

fn path_writable_message(path: &Path, label: &str) -> (bool, String) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::create_dir_all(path);
    match crate::drives::probe_writable(path) {
        Ok(()) => (true, String::new()),
        Err(_) => (
            false,
            format!(
                "Luna can't write to the {label}. Check that this Luna has enough free space and permission."
            ),
        ),
    }
}

fn human_bytes(bytes: u64) -> String {
    const KB: u64 = 1000;
    const MB: u64 = KB * 1000;
    const GB: u64 = MB * 1000;
    if bytes >= GB {
        format!("{:.1} GB", bytes as f64 / GB as f64)
    } else if bytes >= MB {
        format!("{:.0} MB", bytes as f64 / MB as f64)
    } else if bytes >= KB {
        format!("{:.0} KB", bytes as f64 / KB as f64)
    } else {
        format!("{bytes} B")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::drives::DriveManager;
    use crate::mount::shared_mock;

    #[test]
    fn preflight_passes_on_fresh_tempdir() {
        let dir = tempfile::tempdir().unwrap();
        let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
        let resp = run_preflight(dir.path(), &conn);
        assert!(resp.healthy, "{:?}", resp.checks);
        assert!(resp.checks.contains_key("database"));
        assert!(resp.checks.contains_key("disk_space"));
    }

    #[test]
    fn comprehensive_marks_readonly_drive_failed() {
        let dir = tempfile::tempdir().unwrap();
        let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
        let now = crate::db::now_unix();
        conn.execute(
            "INSERT INTO drives (id, label, state, fs_type, device, mount_point, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params!["d1", "Photos", "readonly", "ext4", "sda1", "", now, now],
        )
        .unwrap();
        let dm = DriveManager::new(shared_mock(), dir.path());
        let resp = run_comprehensive(dir.path(), &conn, &dm);
        assert!(!resp.overall_pass);
        assert_eq!(resp.checks["drive_d1_read_write"].status, "failed");
    }
}

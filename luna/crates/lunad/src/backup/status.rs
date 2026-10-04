//! Whether a backup needs an Admin's attention — one rule shared by the
//! system health checks, the backup APIs, and the HDMI console.

use serde::Serialize;

/// Problems that may fix themselves (Connect briefly unreachable) stay quiet
/// for this long before they warn.
pub const SOFT_GRACE_SECS: i64 = 60 * 60;
/// No finished run in this long warns even without a recorded error — it
/// catches backups that never get a chance to run.
pub const STALE_SECS: i64 = 24 * 60 * 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BackupState {
    /// Working, or not yet due.
    Ok,
    /// The last run failed and the problem is worth showing.
    Failing,
    /// Nothing has finished in over a day.
    Stale,
}

/// What a backup has recorded about its runs.
#[derive(Debug, Clone, Copy)]
pub struct Record<'a> {
    /// Last run that finished with nothing failed. 0 = never.
    pub last_ok_at: i64,
    /// When the current run of failures began. 0 while healthy.
    pub failing_since: i64,
    /// Plain-language reason the last run failed; empty when it didn't.
    pub last_error: &'a str,
    /// The problem won't fix itself (missing drive, locked backup, …).
    pub hard: bool,
    /// When this backup was set up — the start of the staleness clock
    /// before the first success.
    pub since: i64,
}

pub fn state(rec: Record<'_>, now: i64) -> BackupState {
    if !rec.last_error.is_empty() {
        let failing_for = now - rec.failing_since.max(rec.since);
        if rec.hard || failing_for >= SOFT_GRACE_SECS {
            return BackupState::Failing;
        }
    }
    if now - rec.last_ok_at.max(rec.since) >= STALE_SECS {
        return BackupState::Stale;
    }
    BackupState::Ok
}

/// "12 minutes ago", "3 days ago" — for health-check sentences.
pub fn ago(then: i64, now: i64) -> String {
    let secs = (now - then).max(0);
    let (n, unit) = if secs < 60 {
        return "just now".into();
    } else if secs < 3600 {
        (secs / 60, "minute")
    } else if secs < 86_400 {
        (secs / 3600, "hour")
    } else {
        (secs / 86_400, "day")
    };
    if n == 1 {
        format!("1 {unit} ago")
    } else {
        format!("{n} {unit}s ago")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_000_000;

    fn rec(error: &str, hard: bool, last_ok_at: i64, failing_since: i64) -> Record<'_> {
        Record {
            last_ok_at,
            failing_since,
            last_error: error,
            hard,
            since: 0,
        }
    }

    #[test]
    fn hard_problems_warn_at_once() {
        assert_eq!(
            state(rec("Drive missing.", true, NOW - 60, NOW - 1), NOW),
            BackupState::Failing
        );
    }

    #[test]
    fn soft_problems_wait_an_hour() {
        let blip = rec("Connect couldn't be reached.", false, NOW - 600, NOW - 300);
        assert_eq!(state(blip, NOW), BackupState::Ok);
        let long = rec(
            "Connect couldn't be reached.",
            false,
            NOW - 600,
            NOW - SOFT_GRACE_SECS,
        );
        assert_eq!(state(long, NOW), BackupState::Failing);
    }

    #[test]
    fn no_success_for_a_day_is_stale() {
        assert_eq!(
            state(rec("", false, NOW - STALE_SECS, 0), NOW),
            BackupState::Stale
        );
        assert_eq!(
            state(rec("", false, NOW - STALE_SECS + 60, 0), NOW),
            BackupState::Ok
        );
    }

    #[test]
    fn a_new_backup_is_not_stale_before_it_has_had_a_day() {
        let fresh = Record {
            since: NOW - 3600,
            ..rec("", false, 0, 0)
        };
        assert_eq!(state(fresh, NOW), BackupState::Ok);
    }

    #[test]
    fn ago_reads_naturally() {
        assert_eq!(ago(NOW - 5, NOW), "just now");
        assert_eq!(ago(NOW - 60, NOW), "1 minute ago");
        assert_eq!(ago(NOW - 7200, NOW), "2 hours ago");
        assert_eq!(ago(NOW - 3 * 86_400, NOW), "3 days ago");
    }
}

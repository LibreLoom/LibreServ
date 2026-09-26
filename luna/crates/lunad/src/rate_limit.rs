//! SQLite-backed rate limiters for auth and share password brute-force defense.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::Connection;

use crate::db;

pub struct RateLimiter {
    db: Arc<Mutex<Connection>>,
    window: Duration,
    max: usize,
}

impl RateLimiter {
    pub fn new(db: Arc<Mutex<Connection>>, window: Duration, max: usize) -> Self {
        Self { db, window, max }
    }

    /// Returns true when the request is allowed.
    pub fn allow(&self, key: &str) -> bool {
        let Ok(conn) = self.db.lock() else {
            return false;
        };
        db::rate_limit_allow(&conn, key, self.window.as_secs() as i64, self.max as i64)
            .unwrap_or(false)
    }
}

/// Exponential lockout for share password guessing (per share + IP), plus a
/// link-wide bucket so an attacker rotating addresses cannot keep guessing —
/// one shared tunnel IP must not be the only thing standing between a public
/// link and unlimited tries.
pub struct ShareAuthGuard {
    db: Arc<Mutex<Connection>>,
    /// Lock after this many consecutive failures.
    max_failures: u32,
    /// Lock the link itself after this many failures across all addresses.
    max_failures_any: u32,
}

impl ShareAuthGuard {
    pub fn new(db: Arc<Mutex<Connection>>) -> Self {
        Self {
            db,
            max_failures: 8,
            max_failures_any: 64,
        }
    }

    fn locked(&self, key: &str) -> bool {
        let Ok(conn) = self.db.lock() else {
            return false;
        };
        db::share_auth_locked(&conn, key).unwrap_or(false)
    }

    pub fn is_locked(&self, share_id: &str, ip: &str) -> bool {
        self.locked(&format!("share:{share_id}:{ip}"))
            || self.locked(&format!("share-any:{share_id}"))
    }

    /// Record a failed password attempt. Returns true if now locked.
    pub fn record_failure(&self, share_id: &str, ip: &str) -> bool {
        // The link-wide bucket uses the higher threshold: shared networks and
        // remembered-password typos are normal, dozens of wrong guesses for
        // one link are not.
        if let Ok(conn) = self.db.lock() {
            let _ = db::share_auth_failure(
                &conn,
                &format!("share-any:{share_id}"),
                self.max_failures_any,
            );
            return db::share_auth_failure(
                &conn,
                &format!("share:{share_id}:{ip}"),
                self.max_failures,
            )
            .unwrap_or(true);
        }
        true
    }

    pub fn clear_success(&self, share_id: &str, ip: &str) {
        // Only the per-IP bucket clears: a correct password must not refund
        // the link-wide budget an attacker is burning through.
        let key = format!("share:{share_id}:{ip}");
        if let Ok(conn) = self.db.lock() {
            let _ = db::share_auth_clear(&conn, &key);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    fn test_db() -> Arc<Mutex<Connection>> {
        let dir = tempfile::tempdir().unwrap();
        Arc::new(Mutex::new(db::open(&dir.path().join("luna.db")).unwrap()))
    }

    #[test]
    fn window_allows_up_to_limit() {
        let db = test_db();
        let limiter = RateLimiter::new(db, Duration::from_secs(60), 3);
        assert!(limiter.allow("ip"));
        assert!(limiter.allow("ip"));
        assert!(limiter.allow("ip"));
        assert!(!limiter.allow("ip"));
        assert!(limiter.allow("other"));
    }

    #[test]
    fn share_locks_after_failures() {
        let db = test_db();
        let guard = ShareAuthGuard::new(db);
        for _ in 0..7 {
            assert!(!guard.record_failure("s1", "1.2.3.4"));
        }
        assert!(guard.record_failure("s1", "1.2.3.4"));
        assert!(guard.is_locked("s1", "1.2.3.4"));
        guard.clear_success("s1", "1.2.3.4");
        assert!(!guard.is_locked("s1", "1.2.3.4"));
    }

    #[test]
    fn link_wide_bucket_bounds_rotating_ips() {
        let db = test_db();
        let guard = ShareAuthGuard::new(db);
        // Each guess arrives from a fresh address — per-IP buckets never
        // trip, but the link's aggregate cap still shuts the door.
        for i in 0..64 {
            assert!(!guard.record_failure("s1", &format!("203.0.113.{i}")));
        }
        assert!(guard.is_locked("s1", "203.0.113.200"));
        // A different link is untouched — the budget is per link.
        assert!(!guard.is_locked("s2", "203.0.113.200"));
        // A correct password clears only the per-IP bucket, never the
        // link-wide count an attacker is burning.
        guard.clear_success("s1", "203.0.113.200");
        assert!(guard.is_locked("s1", "203.0.113.200"));
    }
}

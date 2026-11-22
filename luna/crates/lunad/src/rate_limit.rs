//! SQLite-backed rate limiters for auth and share password brute-force defense.

use std::sync::Arc;
use std::time::Duration;

use crate::db;

pub struct RateLimiter {
    db: Arc<crate::Db>,
    window: Duration,
    max: usize,
}

impl RateLimiter {
    pub fn new(db: Arc<crate::Db>, window: Duration, max: usize) -> Self {
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

/// The network a single client controls: IPv4 as written, IPv6 reduced to its
/// /64 prefix so one host cannot mint a fresh bucket for every address it
/// holds. An IPv4-mapped IPv6 address is the same client as its IPv4 form.
/// Anything that is not an address is returned untouched (for example the
/// `"unknown"` placeholder when a request has no peer address).
pub fn ip_bucket(ip: &str) -> String {
    match ip.trim().parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(v4)) => v4.to_string(),
        Ok(std::net::IpAddr::V6(v6)) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return v4.to_string();
            }
            let mut network = [0u16; 8];
            network[..4].copy_from_slice(&v6.segments()[..4]);
            std::net::Ipv6Addr::from(network).to_string()
        }
        Err(_) => ip.to_string(),
    }
}

/// A namespaced bucket key for one client address. The address is hashed so
/// the rate-limit table never stores visitors' addresses. Callers still get
/// separate buckets per namespace, and an IPv6 client is bucketed by /64.
pub fn ip_key(namespace: &str, ip: &str) -> String {
    let bucket = ip_bucket(ip);
    format!("{namespace}:{}", blake3::hash(bucket.as_bytes()).to_hex())
}

/// A namespaced bucket key for a secret (a link token, a user id). The value
/// is hashed so the raw secret never lands in SQLite.
pub fn secret_key(namespace: &str, secret: &str) -> String {
    format!("{namespace}:{}", blake3::hash(secret.as_bytes()).to_hex())
}

/// Exponential lockout for share password guessing (per share + IP), plus a
/// link-wide bucket so an attacker rotating addresses cannot keep guessing —
/// one shared tunnel IP must not be the only thing standing between a public
/// link and unlimited tries.
pub struct ShareAuthGuard {
    db: Arc<crate::Db>,
    /// Lock after this many consecutive failures.
    max_failures: u32,
    /// Lock the link itself after this many failures across all addresses.
    max_failures_any: u32,
}

impl ShareAuthGuard {
    pub fn new(db: Arc<crate::Db>) -> Self {
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

/// Wrong passwords on an encrypted drive: per user, per drive. Five wrong
/// tries lock that user out of that drive for a minute, doubling with every
/// further wrong try. Only wrong passwords count: a right one clears the
/// count, and a request that is refused for another reason (the drive is
/// unplugged, a different drive was plugged in) costs nothing. Changing the
/// password tests the current one, so it counts here too.
pub struct UnlockGuard {
    db: Arc<crate::Db>,
}

/// Wrong tries before the lockout starts.
const UNLOCK_MAX_FAILURES: u32 = 5;

impl UnlockGuard {
    pub fn new(db: Arc<crate::Db>) -> Self {
        Self { db }
    }

    fn key(user_id: &str, drive: &str) -> String {
        format!("unlock:{user_id}:{drive}")
    }

    /// Is this user locked out of this drive right now?
    pub fn is_locked(&self, user_id: &str, drive: &str) -> bool {
        let Ok(conn) = self.db.lock() else {
            return true;
        };
        db::share_auth_locked(&conn, &Self::key(user_id, drive)).unwrap_or(true)
    }

    /// Record a wrong password. Returns true if now locked out.
    pub fn record_failure(&self, user_id: &str, drive: &str) -> bool {
        let Ok(conn) = self.db.lock() else {
            return true;
        };
        db::share_auth_failure(&conn, &Self::key(user_id, drive), UNLOCK_MAX_FAILURES)
            .unwrap_or(true)
    }

    /// A right password: forget the wrong tries.
    pub fn clear_success(&self, user_id: &str, drive: &str) {
        if let Ok(conn) = self.db.lock() {
            let _ = db::share_auth_clear(&conn, &Self::key(user_id, drive));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    fn test_db() -> Arc<crate::Db> {
        let dir = tempfile::tempdir().unwrap();
        Arc::new(crate::Db::new(
            db::open(&dir.path().join("luna.db")).unwrap(),
        ))
    }

    #[test]
    fn ipv6_buckets_by_its_64_prefix() {
        assert_eq!(ip_bucket("2001:db8:1:2::1"), "2001:db8:1:2::");
        assert_eq!(ip_bucket("2001:db8:1:2:ffff::99"), "2001:db8:1:2::");
        assert_ne!(ip_bucket("2001:db8:1:3::1"), "2001:db8:1:2::");
    }

    #[test]
    fn ipv4_stays_whole_and_a_mapped_v4_is_the_same_client() {
        assert_eq!(ip_bucket("203.0.113.9"), "203.0.113.9");
        assert_eq!(ip_bucket("::ffff:203.0.113.9"), "203.0.113.9");
        assert_eq!(ip_bucket("unknown"), "unknown");
    }

    #[test]
    fn keys_hide_the_address_and_the_secret() {
        let ip = ip_key("test_ip", "2001:db8:1:2::1");
        assert!(ip.starts_with("test_ip:"), "{ip}");
        assert!(!ip.contains("2001"), "{ip}");
        let secret = secret_key("test_secret", "tok-abc");
        assert!(secret.starts_with("test_secret:"), "{secret}");
        assert!(!secret.contains("tok-abc"), "{secret}");
        // Namespaces stay apart even for the same address.
        assert_ne!(ip_key("a", "203.0.113.9"), ip_key("b", "203.0.113.9"));
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

    #[test]
    fn five_wrong_unlock_tries_lock_one_user_out_of_one_drive_only() {
        let guard = UnlockGuard::new(test_db());
        for _ in 0..4 {
            assert!(!guard.record_failure("u1", "d1"));
            assert!(!guard.is_locked("u1", "d1"));
        }
        assert!(
            guard.record_failure("u1", "d1"),
            "the fifth wrong try locks"
        );
        assert!(guard.is_locked("u1", "d1"));
        assert!(!guard.is_locked("u1", "d2"), "another drive is unaffected");
        assert!(!guard.is_locked("u2", "d1"), "another user is unaffected");
    }

    #[test]
    fn right_passwords_never_add_up_to_a_lockout() {
        let guard = UnlockGuard::new(test_db());
        for _ in 0..4 {
            guard.record_failure("u1", "d1");
        }
        guard.clear_success("u1", "d1");
        for _ in 0..4 {
            assert!(!guard.record_failure("u1", "d1"));
        }
        assert!(!guard.is_locked("u1", "d1"));
    }
}

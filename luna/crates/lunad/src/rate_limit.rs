//! Tiny fixed-window rate limiter for auth endpoints.
//!
//! Deliberately dependency-free: one Mutex, a HashMap keyed by client address,
//! and monotonic clock checks. On the 4GB Luna box this costs bytes, not cycles.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub struct RateLimiter {
    window: Duration,
    max: usize,
    buckets: Mutex<HashMap<String, (Instant, usize)>>,
}

impl RateLimiter {
    pub fn new(window: Duration, max: usize) -> Self {
        Self {
            window,
            max,
            buckets: Mutex::new(HashMap::new()),
        }
    }

    /// Returns true when the request is allowed.
    pub fn allow(&self, key: &str) -> bool {
        let now = Instant::now();
        let mut map = self.buckets.lock().unwrap();
        // Opportunistic cleanup so the map can't grow unbounded on a LAN.
        if map.len() > 1024 {
            map.retain(|_, (started, _)| now.duration_since(*started) < self.window);
        }
        let entry = map.entry(key.to_string()).or_insert((now, 0));
        if now.duration_since(entry.0) >= self.window {
            entry.0 = now;
            entry.1 = 1;
            return true;
        }
        entry.1 += 1;
        entry.1 <= self.max
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_allows_up_to_limit() {
        let limiter = RateLimiter::new(Duration::from_secs(60), 3);
        assert!(limiter.allow("ip"));
        assert!(limiter.allow("ip"));
        assert!(limiter.allow("ip"));
        assert!(!limiter.allow("ip"));
        assert!(limiter.allow("other"));
    }
}

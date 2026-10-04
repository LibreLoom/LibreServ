//! Helpers shared by unit tests.

use std::time::{Duration, Instant};

/// Poll `ready` until it returns true or `timeout` passes. Returns whether it
/// became true. Polls quickly and stops the moment the condition holds, so a
/// test waits only as long as the work actually takes — and a slow machine
/// gets the whole budget instead of a fixed number of guesses.
pub fn wait_until(timeout: Duration, mut ready: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if ready() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(2));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_as_soon_as_the_condition_holds() {
        let start = Instant::now();
        let mut calls = 0;
        assert!(wait_until(Duration::from_secs(5), || {
            calls += 1;
            calls == 3
        }));
        assert!(start.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn gives_up_after_the_timeout() {
        assert!(!wait_until(Duration::from_millis(20), || false));
    }
}

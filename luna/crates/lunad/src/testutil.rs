//! Helpers shared by unit tests.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// Register a mounted drive with the same marker and registry used on disk.
pub fn mount_drive(conn: &rusqlite::Connection, dir: &Path, id: &str) -> PathBuf {
    let root = dir.join(id);
    std::fs::create_dir(&root).unwrap();
    let prefix = luna_core::marker::pick_prefix(&root).unwrap();
    crate::drives::drive_db::create(&root, &luna_core::marker::Marker::new(id, id), &prefix)
        .unwrap();
    crate::db::upsert_drive(conn, id, id, "as_is", "ext4", id, root.to_str().unwrap()).unwrap();
    root
}

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

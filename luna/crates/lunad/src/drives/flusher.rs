//! Short write-back for drives with no journal.
//!
//! The kernel holds written data in memory for up to about half a minute
//! before it reaches the drive. ext4 has a journal to recover from a power cut
//! in that window; exFAT does not, so a cut there can leave the volume
//! half-updated. For exFAT and FAT drives Luna asks the kernel to write out
//! everything it holds a few seconds after the last change (and at least every
//! half minute), instead of waiting for the kernel's own timer. ext4 drives
//! keep the kernel's normal behaviour.

use std::collections::HashMap;
use std::time::{Duration, Instant};

/// How long after a recorded write the flusher looks, so a burst of writes
/// is written out together.
pub const TICK: Duration = Duration::from_secs(2);
/// With no exFAT or FAT drive in use, how often the flusher looks for one
/// that appeared without a recorded write. A change to the drives table
/// (adopt, mount, state) wakes it at once ([`drives_changed`]), so this is
/// only a safety net.
pub const IDLE_RECHECK: Duration = Duration::from_secs(30 * 60);

static DRIVES_CHANGED: tokio::sync::Notify = tokio::sync::Notify::const_new();

/// A row in the drives table changed (cheap; callers may hold the database lock).
pub fn note_drives_changed() {
    DRIVES_CHANGED.notify_one();
}

/// Resolves after the next [`note_drives_changed`] (at once when one came
/// since the last wait).
pub async fn drives_changed() {
    DRIVES_CHANGED.notified().await;
}
/// Even with no recorded write, write out at least this often: writers such
/// as backups don't report each change.
const BACKSTOP: Duration = Duration::from_secs(30);

/// Decides which drives are due for a write-out.
#[derive(Default)]
pub struct Planner {
    last: HashMap<String, (u64, Instant)>,
}

impl Planner {
    /// True when `drive_id` should be written out now. `write_gen` is how many
    /// writes Luna has made to it; a changed count means something is waiting.
    pub fn due(&mut self, drive_id: &str, write_gen: u64, now: Instant) -> bool {
        let due = match self.last.get(drive_id) {
            None => true,
            Some((gen_seen, at)) => *gen_seen != write_gen || now.duration_since(*at) >= BACKSTOP,
        };
        if due {
            self.last.insert(drive_id.to_string(), (write_gen, now));
        }
        due
    }

    /// When the earliest backstop write-out falls due, if any drive is known.
    pub fn next_backstop(&self) -> Option<Instant> {
        self.last.values().map(|(_, at)| *at + BACKSTOP).min()
    }

    /// Forget drives that are no longer mounted.
    pub fn retain(&mut self, live: &[String]) {
        self.last.retain(|id, _| live.contains(id));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_out_soon_after_a_change_and_not_while_idle() {
        let mut p = Planner::default();
        let t0 = Instant::now();
        assert!(p.due("d", 0, t0), "first look writes out once");
        assert!(
            !p.due("d", 0, t0 + Duration::from_secs(2)),
            "idle: nothing to do"
        );
        assert!(
            p.due("d", 1, t0 + Duration::from_secs(4)),
            "a new write is due"
        );
        assert!(!p.due("d", 1, t0 + Duration::from_secs(6)));
    }

    #[test]
    fn writes_out_at_least_every_half_minute() {
        let mut p = Planner::default();
        let t0 = Instant::now();
        assert!(p.due("d", 5, t0));
        assert!(!p.due("d", 5, t0 + Duration::from_secs(29)));
        assert!(p.due("d", 5, t0 + Duration::from_secs(31)));
    }

    #[test]
    fn next_backstop_is_the_earliest_drive() {
        let mut p = Planner::default();
        assert_eq!(p.next_backstop(), None);
        let t0 = Instant::now();
        assert!(p.due("a", 1, t0 + Duration::from_secs(5)));
        assert!(p.due("b", 1, t0));
        assert_eq!(p.next_backstop(), Some(t0 + BACKSTOP));
        p.retain(&["a".to_string()]);
        assert_eq!(
            p.next_backstop(),
            Some(t0 + Duration::from_secs(5) + BACKSTOP)
        );
    }

    #[test]
    fn drives_are_tracked_separately() {
        let mut p = Planner::default();
        let t0 = Instant::now();
        assert!(p.due("a", 1, t0));
        assert!(p.due("b", 1, t0));
        assert!(!p.due("a", 1, t0 + Duration::from_secs(1)));
        p.retain(&["b".to_string()]);
        assert!(p.due("a", 1, t0 + Duration::from_secs(1)));
    }
}

use serde::{Deserialize, Serialize};

/// Lifecycle state of a physically attached drive.
///
/// The transitions are deliberately conservative: a drive never becomes
/// writable (`AsIs`) without an explicit user adoption step, and failures
/// always land in `ReadOnly` or `Failed` before any further writes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DriveState {
    /// Detected, never seen before, nothing has been written.
    Unknown,
    /// Recognized filesystem, no `.luna` marker, user has been shown what's on it.
    Foreign,
    /// Adopted: `.luna` marker present, served read-write as its own root.
    AsIs,
    /// Present but intentionally read-only (fs, health, or user choice).
    ReadOnly,
    /// Previously adopted, not currently connected.
    Missing,
    /// Cleanly unmounted through the UI.
    Ejected,
    /// Mount or I/O errors; no writes are attempted.
    Failed,
}

/// Ordered list used by the API/UI so clients and server never drift on names.
pub const DRIVE_STATES: &[DriveState] = &[
    DriveState::Unknown,
    DriveState::Foreign,
    DriveState::AsIs,
    DriveState::ReadOnly,
    DriveState::Missing,
    DriveState::Ejected,
    DriveState::Failed,
];

impl DriveState {
    pub fn as_str(self) -> &'static str {
        match self {
            DriveState::Unknown => "unknown",
            DriveState::Foreign => "foreign",
            DriveState::AsIs => "as_is",
            DriveState::ReadOnly => "readonly",
            DriveState::Missing => "missing",
            DriveState::Ejected => "ejected",
            DriveState::Failed => "failed",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn states_round_trip_serde() {
        for state in DRIVE_STATES {
            let json = serde_json::to_string(state).expect("serialize");
            let back: DriveState = serde_json::from_str(&json).expect("deserialize");
            assert_eq!(*state, back, "state {json} did not round trip");
        }
    }

    #[test]
    fn state_names_match_plan() {
        let names: Vec<_> = DRIVE_STATES.iter().map(|s| s.as_str()).collect();
        assert_eq!(
            names,
            [
                "unknown", "foreign", "as_is", "readonly", "missing", "ejected", "failed"
            ]
        );
    }
}

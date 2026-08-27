//! Luna core storage model.
//!
//! Everything here is dependency-light and unit-testable without touching a
//! real drive: drive lifecycle states, the `.luna` adoption marker, safe path
//! resolution, and read-only top-level inspection summaries.

pub mod drive;
pub mod marker;
pub mod path;
pub mod scan;

pub use drive::{DRIVE_STATES, DriveState};
pub use marker::{Marker, MarkerError, read_marker, remove_marker, write_marker};
#[cfg(target_os = "linux")]
pub use path::open_verified;
pub use path::{
    PathError, is_under_prefix, open_nofollow, resolve_child, resolve_child_nofollow,
    resolve_for_create_nofollow,
};
pub use scan::{TopLevelEntry, TopLevelSummary, scan_top_level};

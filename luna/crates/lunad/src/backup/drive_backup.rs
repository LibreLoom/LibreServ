//! Drive backups: one protected folder or drive copied onto another drive
//! (plan §2-§4). Storage lives in [`super::drive_store`], what gets copied in
//! [`super::scope`], who may see it in [`super::access_list`].

use rusqlite::Connection;

use crate::db::ProtectionRow;

mod ops;
pub use ops::{delete, on_grants_changed, on_moved, rebuild_from_manifests, state, visible_to};

/// What one run did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RunOutcome {
    pub copied: u64,
    pub unchanged: u64,
    pub removed: u64,
    /// Files that couldn't go onto the target as they are (case clash on
    /// exFAT/FAT, too large for FAT), named in plain words.
    pub notes: Vec<String>,
}

/// Why a create request was refused, in words a person can act on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refused(pub String);

/// Start a drive backup of `source_path` on `source_drive` onto
/// `target_drive` for `user`. Permission rules (plan §2): Read on the source,
/// Write on the target drive, Admin for a whole drive; never a source inside
/// a private item (phase 4), never onto its own drive. One backup per object
/// per destination: an existing one is returned as is.
pub fn create(
    conn: &Connection,
    user: &crate::auth::CurrentUser,
    source_drive: &str,
    source_path: &str,
    target_drive: &str,
) -> Result<ProtectionRow, Refused> {
    let _ = (conn, user, source_drive, source_path, target_drive);
    todo!("task D1")
}

/// Run one drive backup now. Records the result on the row (ok / error /
/// stopped / source gone) and returns what happened.
pub fn run(db: &crate::Db, id: &str, now: i64) -> anyhow::Result<RunOutcome> {
    let _ = (db, id, now);
    todo!("task D1")
}

/// Like [`run`], but applies deletions even when most of the source seems
/// gone (the person pressed "Run anyway" after the mass-delete guard).
pub fn run_allowing_mass_delete(db: &crate::Db, id: &str, now: i64) -> anyhow::Result<RunOutcome> {
    let _ = (db, id, now);
    todo!("task D1")
}

/// Run every active drive backup. True when any backup's state changed (so
/// the health cache must be refreshed).
pub fn run_all(db: &crate::Db, now: i64) -> bool {
    let _ = (db, now);
    todo!("task D1")
}

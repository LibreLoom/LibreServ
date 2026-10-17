//! Drive backups: one protected folder or drive copied onto another drive
//! (plan §2-§4). Storage lives in [`super::drive_store`], what gets copied in
//! [`super::scope`], who may see it in [`super::access_list`].

use rusqlite::Connection;

use crate::db::ProtectionRow;

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
    todo!("task D")
}

/// Run one drive backup now. Records the result on the row (ok / error /
/// stopped / source gone) and returns what happened.
pub fn run(db: &crate::Db, id: &str, now: i64) -> anyhow::Result<RunOutcome> {
    let _ = (db, id, now);
    todo!("task D")
}

/// Run every active drive backup. True when any backup's state changed (so
/// the health cache must be refreshed).
pub fn run_all(db: &crate::Db, now: i64) -> bool {
    let _ = (db, now);
    todo!("task D")
}

/// Delete a backup and its stored copies on the target drive (when the
/// target is connected; otherwise the row goes and the files stay until the
/// drive returns and [`rebuild_from_manifests`] sees no row... see task D).
pub fn delete(conn: &Connection, row: &ProtectionRow) -> anyhow::Result<()> {
    let _ = (conn, row);
    todo!("task D")
}

/// A file or folder moved (rename, move, cross-drive move). Follows the
/// source, then stops any backup whose source is now inside a private item
/// or on its own target drive (plan §2).
pub fn on_moved(conn: &Connection, from_drive: &str, old_path: &str, to_drive: &str, new_path: &str) {
    let _ = (conn, from_drive, old_path, to_drive, new_path);
    todo!("task D")
}

/// Grants changed on `drive_id` at or above some backups' sources: re-save
/// the access list of every active backup whose source is healthy.
pub fn on_grants_changed(conn: &Connection, drive_id: &str) {
    let _ = (conn, drive_id);
    todo!("task D")
}

/// Recreate missing rows from the manifests on every connected drive (system
/// DB lost, or a drive arriving from another Luna).
pub fn rebuild_from_manifests(conn: &Connection) -> usize {
    let _ = conn;
    todo!("task D")
}

/// The row's state for status pills and health (shares `status.rs` rules).
pub fn state(row: &ProtectionRow, now: i64) -> super::status::BackupState {
    let _ = (row, now);
    todo!("task D")
}

/// Can `user` see this backup? Reads the access list saved on the row.
pub fn visible_to(row: &ProtectionRow, user: &crate::auth::CurrentUser) -> bool {
    let _ = (row, user);
    todo!("task D")
}

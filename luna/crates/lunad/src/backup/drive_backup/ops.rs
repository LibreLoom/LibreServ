//! Lifecycle around the copy engine: delete, follow moves, re-save access
//! lists, rebuild rows from drive manifests, and status (plan §2-§4).

use rusqlite::Connection;

use crate::db::ProtectionRow;

/// Why this backup must stop now, if it must: its source is inside a private
/// item, or sits on the backup's own target drive (plan §2). Shared by
/// [`on_moved`] and the copy engine's run.
pub(super) fn stop_reason(conn: &Connection, row: &ProtectionRow) -> Option<&'static str> {
    let _ = (conn, row);
    todo!("task D2")
}

/// Delete a backup and its stored copies on the target drive (when the
/// target is connected; otherwise the row goes and the files stay until the
/// drive returns and [`rebuild_from_manifests`] sees no row... see task D).
pub fn delete(conn: &Connection, row: &ProtectionRow) -> anyhow::Result<()> {
    let _ = (conn, row);
    todo!("task D2")
}

/// A file or folder moved (rename, move, cross-drive move). Follows the
/// source, then stops any backup whose source is now inside a private item
/// or on its own target drive (plan §2).
pub fn on_moved(
    conn: &Connection,
    from_drive: &str,
    old_path: &str,
    to_drive: &str,
    new_path: &str,
) {
    let _ = (conn, from_drive, old_path, to_drive, new_path);
    todo!("task D2")
}

/// Grants changed on `drive_id` at or above some backups' sources: re-save
/// the access list of every active backup whose source is healthy.
pub fn on_grants_changed(conn: &Connection, drive_id: &str) {
    let _ = (conn, drive_id);
    todo!("task D2")
}

/// Recreate missing rows from the manifests on every connected drive (system
/// DB lost, or a drive arriving from another Luna).
pub fn rebuild_from_manifests(conn: &Connection) -> usize {
    let _ = conn;
    todo!("task D2")
}

/// The row's state for status pills and health (shares `status.rs` rules).
pub fn state(row: &ProtectionRow, now: i64) -> crate::backup::status::BackupState {
    let _ = (row, now);
    todo!("task D2")
}

/// Can `user` see this backup? Reads the access list saved on the row.
pub fn visible_to(row: &ProtectionRow, user: &crate::auth::CurrentUser) -> bool {
    let _ = (row, user);
    todo!("task D2")
}

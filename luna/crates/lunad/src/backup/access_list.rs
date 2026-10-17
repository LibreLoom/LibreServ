//! Who may see a backup: the access list saved with it (plan §2).
//!
//! A backup's visibility never follows the live source. Each successful run
//! (and each grant change while the source is healthy) saves this list into
//! the backup itself; once the source is gone it is frozen.

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

/// The people who may see one backup.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct AccessList {
    /// User ids whose Read covers the source root. Sorted, no duplicates.
    pub users: Vec<String>,
    /// The standing Admins entry: a role, not a frozen set of people. True
    /// for every shared backup, false for a private item's backup.
    pub admins: bool,
}

impl AccessList {
    /// Does this list let `user_id` see the backup?
    pub fn allows(&self, user_id: &str, is_admin: bool) -> bool {
        let _ = (user_id, is_admin);
        todo!("task E")
    }
}

/// The access list for a shared backup of `source_path` on `drive_id`:
/// users whose Read (`CAP_VIEW`) covers the source root through a member
/// grant on the root or an ancestor, plus the Admins entry.
pub fn for_source(conn: &Connection, drive_id: &str, source_path: &str) -> anyhow::Result<AccessList> {
    let _ = (conn, drive_id, source_path);
    todo!("task E")
}

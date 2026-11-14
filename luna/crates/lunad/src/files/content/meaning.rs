//! Meaning search over extracted text. Filled in by the next step.

use rusqlite::Connection;

use super::store::Pending;

/// Called after a file's text was saved.
pub fn after_text(_conn: &Connection, _drive_id: &str, _file: &Pending, _text: &str) {}

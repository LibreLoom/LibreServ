//! Photo search. Filled in by a later step.

use rusqlite::Connection;

/// Whether photo search judged this photo to show a document (receipt,
/// letter, screenshot). `None` until it has looked.
pub fn shows_document(_conn: &Connection, _rel: &str) -> Option<bool> {
    None
}

/// Give photos that waited for photo search another look.
pub fn requeue_ocr_deferred(_conn: &Connection, _drive_id: &str) -> anyhow::Result<()> {
    Ok(())
}

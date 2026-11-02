//! Cloud backup: crypto (keys, sealing, signatures, ids) and, later, upload and sync.

pub mod check;
pub mod crypto;
#[cfg(test)]
mod fixture;
pub mod format;
pub mod identity;
pub mod keys;
pub mod ops;
pub mod private;
pub mod private_check;
pub mod private_recover;
pub mod private_run;
pub mod recover;
pub mod retention;
pub mod rewrap;
pub mod run;
pub mod store;

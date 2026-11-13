//! Drive encryption: the system that keeps an encrypted drive's password,
//! lock and unlock. It never formats; when a drive needs erasing it hands off
//! to the one format flow (`drives::format`). See `docs/drive-format/plan.md`.
//!
//! - [`luks`]: `cryptsetup` behind a trait with a mock. The only place the
//!   program is run.
//! - [`vault`]: unlock, lock, and the startup rule that after a boot every
//!   encrypted drive is locked.

pub mod luks;
pub mod vault;

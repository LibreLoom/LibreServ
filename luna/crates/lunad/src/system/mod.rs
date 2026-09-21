//! Box lifecycle: updates, recovery drive, factory provisioning, console,
//! health, and the embedded web bundle.

pub mod console;
pub mod factory_mag;
pub mod recovery;
pub mod recovery_drive;
#[cfg(test)]
mod runtime_perf;
pub mod staticweb;
pub mod system_health;
mod update_host;
pub mod updates;

//! Drive lifecycle service: inspect → adopt → eject.
//!
//! Invariants:
//! - Inspection never writes to the drive (read-only mount when Luna mounts it).
//! - Adoption writes exactly one `.luna` marker file and a DB row; if the
//!   marker cannot be written, the drive is left exactly as it was found.
//! - Luna only unmounts mount points it created. Pre-existing OS mounts are
//!   adopted in place and never remounted.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use luna_core::marker::{Marker, write_marker};
use luna_core::scan::scan_top_level;
use rusqlite::Connection;
use uuid::Uuid;

use crate::db;
use crate::detect::DetectedDrive;
use crate::mount::Mounter;

#[derive(Debug, Clone)]
pub struct Inspection {
    pub device: String,
    pub model: String,
    pub fs_type: Option<String>,
    pub mount_point: PathBuf,
    pub mounted_by_luna: bool,
    pub summary: luna_core::scan::TopLevelSummary,
    pub has_marker: bool,
}

#[derive(Clone)]
pub struct DriveManager {
    mounter: Arc<dyn Mounter>,
    foreign_base: PathBuf,
    adopted_base: PathBuf,
}

impl DriveManager {
    pub fn new(mounter: Arc<dyn Mounter>, data_dir: &Path) -> Self {
        Self {
            mounter,
            foreign_base: data_dir.join("mounts/foreign"),
            adopted_base: data_dir.join("mounts/drives"),
        }
    }

    /// Read-only look at a detected device. Mounts it read-only only when it
    /// is not already mounted anywhere.
    pub fn inspect(&self, device: &DetectedDrive) -> anyhow::Result<Inspection> {
        let (mount_point, mounted_by_luna) = if let Some(existing) = &device.mount_point {
            (PathBuf::from(existing), false)
        } else {
            let target = self.foreign_mount_point(&device.name);
            self.mounter
                .mount(&device_path(&device.name), &target, true)
                .map_err(|e| anyhow::anyhow!("Could not look at this drive safely. {e}"))?;
            (target, true)
        };

        let has_marker = luna_core::marker::read_marker(&mount_point)
            .map(|m| m.is_some())
            .unwrap_or(false);
        let summary = scan_top_level(&mount_point);

        Ok(Inspection {
            device: device.name.clone(),
            model: device.model.clone(),
            fs_type: device.fs_type.clone(),
            mount_point,
            mounted_by_luna,
            summary,
            has_marker,
        })
    }

    /// Adopt a drive as-is: ensure a writable mount, write the marker, then
    /// record it. On any failure before the DB row, the drive is untouched.
    pub fn adopt(
        &self,
        conn: &Connection,
        device: &DetectedDrive,
        label: &str,
    ) -> anyhow::Result<db::DriveRow> {
        if label.trim().is_empty() {
            anyhow::bail!("Give the drive a name first.");
        }
        let label = label.trim();
        let id = Uuid::new_v4().to_string();

        let foreign_target = self.foreign_mount_point(&device.name);
        let foreign_was_mounted = self.is_ours(&foreign_target);

        if foreign_was_mounted {
            self.mounter.unmount(&foreign_target)?;
        }

        let (mount_point, mounted_by_luna) = match &device.mount_point {
            // An OS-level mount we did not create: adopt it in place, never remount.
            Some(existing) if !self.is_ours(Path::new(existing)) => {
                (PathBuf::from(existing), false)
            }
            _ => {
                let target = self.adopted_mount_point(&id);
                self.mounter
                    .mount(&device_path(&device.name), &target, false)
                    .map_err(|e| anyhow::anyhow!("Could not add this drive. {e}"))?;
                (target, true)
            }
        };

        let marker = Marker::new(id.clone(), label);
        if let Err(e) = write_marker(&mount_point, &marker) {
            if mounted_by_luna {
                let _ = self.mounter.unmount(&mount_point);
                let _ = std::fs::remove_dir(&mount_point);
            }
            return Err(anyhow::anyhow!(
                "Luna could not mark this drive as its own. {e}"
            ));
        }

        db::upsert_drive(
            conn,
            &id,
            label,
            "as_is",
            device.fs_type.as_deref().unwrap_or(""),
            &device.name,
            mount_point.to_str().unwrap_or(""),
        )?;
        db::get_drive(conn, &id)?
            .map(Ok)
            .unwrap_or_else(|| anyhow::bail!("Drive was added but could not be read back."))
    }

    /// Eject a drive that Luna knows about. Only unmounts Luna-owned mounts.
    pub fn eject(&self, conn: &Connection, id: &str) -> anyhow::Result<()> {
        let Some(drive) = db::get_drive(conn, id)? else {
            anyhow::bail!("Luna doesn't know this drive.");
        };
        if !drive.mount_point.is_empty() && self.is_ours(Path::new(&drive.mount_point)) {
            self.mounter.unmount(Path::new(&drive.mount_point))?;
            let _ = std::fs::remove_dir(Path::new(&drive.mount_point));
        }
        db::set_drive_state(conn, id, "ejected")?;
        Ok(())
    }

    /// Check every adopted drive is still writable. Drives that fail a safe
    /// create/write/sync/delete probe transition to `readonly` — never failed
    /// — because reads usually still work and the UI can explain calmly.
    pub fn health_check(&self, conn: &Connection) -> anyhow::Result<()> {
        for drive in db::list_drives(conn)? {
            if drive.state != "as_is" || drive.mount_point.is_empty() {
                continue;
            }
            if probe_writable(std::path::Path::new(&drive.mount_point)).is_err() {
                db::set_drive_state(conn, &drive.id, "readonly")?;
            }
        }
        Ok(())
    }

    /// Reconcile the registry with reality.
    ///
    /// Adopted drives that disappeared become `missing`; drives that come back
    /// become `as_is` again. Ejected drives stay ejected until they return.
    pub fn reconcile(&self, conn: &Connection, detected: &[DetectedDrive]) -> anyhow::Result<()> {
        for row in db::list_drives(conn)? {
            let present = detected.iter().any(|d| d.name == row.device);
            match row.state.as_str() {
                "as_is" | "readonly" if !present => {
                    db::set_drive_state(conn, &row.id, "missing")?;
                }
                "missing" | "ejected" if present => {
                    db::set_drive_state(conn, &row.id, "as_is")?;
                }
                _ => {}
            }
        }
        Ok(())
    }

    /// Stop looking at a foreign drive Luna mounted for inspection.
    pub fn dismiss_foreign(&self, device_name: &str) -> anyhow::Result<()> {
        let target = self.foreign_mount_point(device_name);
        if target.exists() {
            self.mounter.unmount(&target)?;
            let _ = std::fs::remove_dir(&target);
        }
        Ok(())
    }

    fn foreign_mount_point(&self, device_name: &str) -> PathBuf {
        self.foreign_base.join(sanitize(device_name))
    }

    fn adopted_mount_point(&self, id: &str) -> PathBuf {
        self.adopted_base.join(id)
    }

    fn is_ours(&self, path: &Path) -> bool {
        path.starts_with(&self.foreign_base) || path.starts_with(&self.adopted_base)
    }
}

fn probe_writable(root: &Path) -> anyhow::Result<()> {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let probe = root.join(format!(".luna-write-test.{}.{nonce}", std::process::id()));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)?;
    use std::io::Write;
    file.write_all(b"luna")?;
    file.sync_all()?;
    drop(file);
    std::fs::remove_file(&probe)?;
    Ok(())
}

fn sanitize(name: &str) -> String {
    name.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect()
}

fn device_path(name: &str) -> String {
    format!("/dev/{name}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mount::shared_mock;

    fn detected(name: &str, mount: Option<&str>) -> DetectedDrive {
        DetectedDrive {
            name: name.into(),
            model: "Test Drive".into(),
            size_bytes: 1000,
            removable: true,
            usb: true,
            mount_point: mount.map(String::from),
            fs_type: Some("ext4".into()),
        }
    }

    #[test]
    fn inspect_mounts_read_only_and_never_writes() {
        let mounter = shared_mock();
        let root = tempfile::tempdir().unwrap();
        let mgr = DriveManager::new(mounter.clone(), root.path());
        let dev = detected("sdz", None);

        let inspection = mgr.inspect(&dev).unwrap();
        assert!(inspection.mounted_by_luna);
        assert!(!inspection.has_marker);
        assert_eq!(
            inspection.summary,
            luna_core::scan::TopLevelSummary::default()
        );
        let calls = mounter.mounts.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert!(calls[0].2, "foreign inspection must be read-only");
    }

    #[test]
    fn adopt_writes_marker_and_db_row() {
        let mounter = shared_mock();
        let root = tempfile::tempdir().unwrap();
        let dir = root.path();
        let conn = db::open(&dir.join("luna.db")).unwrap();
        let mgr = DriveManager::new(mounter.clone(), dir);
        let dev = detected("sdz", None);

        // Inspection first, like the real flow.
        let inspection = mgr.inspect(&dev).unwrap();
        assert!(inspection.mounted_by_luna);

        let row = mgr.adopt(&conn, &dev, "Photos Drive").unwrap();
        assert_eq!(row.label, "Photos Drive");
        assert_eq!(row.state, "as_is");
        assert_eq!(row.device, "sdz");

        let marker = luna_core::marker::read_marker(Path::new(&row.mount_point))
            .unwrap()
            .unwrap();
        assert_eq!(marker.id, row.id);

        let calls = mounter.mounts.lock().unwrap();
        assert_eq!(calls.len(), 2, "read-only inspect, then read-write adopt");
        assert!(!calls[1].2);
        assert!(
            !mounter.unmounts.lock().unwrap().is_empty(),
            "foreign mount released"
        );
    }

    #[test]
    fn eject_only_touches_luna_owned_mounts() {
        let mounter = shared_mock();
        let root = tempfile::tempdir().unwrap();
        let dir = root.path();
        let conn = db::open(&dir.join("luna.db")).unwrap();
        let mgr = DriveManager::new(mounter.clone(), dir);
        let dev = detected("sdz", None);
        let row = mgr.adopt(&conn, &dev, "Backup Drive").unwrap();

        mgr.eject(&conn, &row.id).unwrap();
        assert_eq!(
            db::get_drive(&conn, &row.id).unwrap().unwrap().state,
            "ejected"
        );
        assert_eq!(mounter.unmounts.lock().unwrap().len(), 2);
    }

    #[test]
    fn reconcile_marks_missing_and_restores_on_return() {
        let mounter = shared_mock();
        let root = tempfile::tempdir().unwrap();
        let dir = root.path();
        let conn = db::open(&dir.join("luna.db")).unwrap();
        let mgr = DriveManager::new(mounter, dir);
        let row = mgr
            .adopt(&conn, &detected("sdz", None), "Backup Drive")
            .unwrap();

        // Drive gone.
        mgr.reconcile(&conn, &[]).unwrap();
        assert_eq!(
            db::get_drive(&conn, &row.id).unwrap().unwrap().state,
            "missing"
        );

        // Drive back.
        mgr.reconcile(&conn, &[detected("sdz", None)]).unwrap();
        assert_eq!(
            db::get_drive(&conn, &row.id).unwrap().unwrap().state,
            "as_is"
        );
    }

    #[test]
    fn readonly_drive_is_marked_readonly_not_failed() {
        let mounter = shared_mock();
        let root = tempfile::tempdir().unwrap();
        let dir = root.path();
        let conn = db::open(&dir.join("luna.db")).unwrap();
        let mgr = DriveManager::new(mounter, dir);
        let row = mgr
            .adopt(&conn, &detected("sdz", None), "Backup Drive")
            .unwrap();

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&row.mount_point).unwrap().permissions();
            perms.set_mode(0o555);
            std::fs::set_permissions(&row.mount_point, perms).unwrap();
            mgr.health_check(&conn).unwrap();
            assert_eq!(
                db::get_drive(&conn, &row.id).unwrap().unwrap().state,
                "readonly"
            );
            let mut perms = std::fs::metadata(&row.mount_point).unwrap().permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&row.mount_point, perms).unwrap();
        }
    }

    #[test]
    fn reject_empty_label_without_touching_drive() {
        let mounter = shared_mock();
        let root = tempfile::tempdir().unwrap();
        let dir = root.path();
        let conn = db::open(&dir.join("luna.db")).unwrap();
        let mgr = DriveManager::new(mounter.clone(), dir);
        let err = mgr.adopt(&conn, &detected("sdz", None), "   ").unwrap_err();
        assert!(err.to_string().contains("name"));
        assert_eq!(mounter.mount_count(), 0);
    }
}

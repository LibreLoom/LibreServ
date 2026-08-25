//! Drive lifecycle service: inspect → adopt → eject.
//!
//! Invariants:
//! - Inspection never writes to the drive (read-only mount when Luna mounts it).
//! - Adoption writes exactly one `.luna` marker file and a DB row; if the
//!   marker cannot be written, the drive is left exactly as it was found.
//! - Luna only unmounts mount points it created, except USB/removable sticks
//!   that the OS mounted read-only (iso9660 installer media, or an automount
//!   left `ro`). Those are remounted read-write — or erased, if the user said so.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use luna_core::marker::{Marker, write_marker};
use luna_core::scan::scan_top_level;
use rusqlite::Connection;
use uuid::Uuid;

use crate::db;
use crate::detect::{self, DetectedDrive};
use crate::fsprobe::{
    FsProbe, MountChoice, first_partition_name, is_intrinsically_read_only, is_writable_type,
    pick_mount_source,
};
use crate::mount::Mounter;

pub const INSTALLER_USB_MESSAGE: &str = "This USB still has the Luna installer on it. That kind of disk cannot be changed. Erase it to use it for photos and files — that deletes everything currently on the USB, including the installer.";
pub const WRITE_REJECTED_MESSAGE: &str = "This drive will not accept new files right now. If it has a lock switch, slide it to unlock. If this USB still has the Luna installer on it, look inside and choose Erase and add.";

#[derive(Debug, Clone)]
pub struct Inspection {
    pub device: String,
    pub model: String,
    pub fs_type: Option<String>,
    pub mount_point: PathBuf,
    pub mounted_by_luna: bool,
    pub summary: luna_core::scan::TopLevelSummary,
    pub has_marker: bool,
    pub needs_erase: bool,
}

#[derive(Clone)]
pub struct DriveManager {
    mounter: Arc<dyn Mounter>,
    probe: Arc<dyn FsProbe>,
    foreign_base: PathBuf,
    adopted_base: PathBuf,
}

impl DriveManager {
    pub fn new(mounter: Arc<dyn Mounter>, data_dir: &Path) -> Self {
        Self::new_with_probe(mounter, data_dir, Arc::new(crate::fsprobe::CommandFsProbe))
    }

    pub fn new_with_probe(
        mounter: Arc<dyn Mounter>,
        data_dir: &Path,
        probe: Arc<dyn FsProbe>,
    ) -> Self {
        Self {
            mounter,
            probe,
            foreign_base: data_dir.join("mounts/foreign"),
            adopted_base: data_dir.join("mounts/drives"),
        }
    }

    /// Read-only look at a detected device. Mounts it read-only only when it
    /// is not already mounted anywhere.
    pub fn inspect(&self, device: &DetectedDrive) -> anyhow::Result<Inspection> {
        let choice = self.choice_for(device);
        let (mount_point, mounted_by_luna) = if let Some(existing) = &device.mount_point {
            (PathBuf::from(existing), false)
        } else {
            let target = self.foreign_mount_point(&device.name);
            self.mounter
                .mount_typed(
                    &device_path(&choice.name),
                    &target,
                    true,
                    fs_opt(&choice.fs_type),
                )
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
            fs_type: if choice.fs_type.is_empty() {
                device.fs_type.clone()
            } else {
                Some(choice.fs_type.clone())
            },
            mount_point,
            mounted_by_luna,
            summary,
            has_marker,
            needs_erase: choice.needs_erase,
        })
    }

    /// Adopt a drive as-is: ensure a writable mount, write the marker, then
    /// record it. On any failure before the DB row, the drive is untouched.
    ///
    /// `erase` wipes installer (iso9660) media and puts a new filesystem on it.
    /// It is refused for non-USB disks.
    pub fn adopt(
        &self,
        conn: &Connection,
        device: &DetectedDrive,
        label: &str,
        erase: bool,
    ) -> anyhow::Result<db::DriveRow> {
        if label.trim().is_empty() {
            anyhow::bail!("Give the drive a name first.");
        }
        let label = label.trim();
        let id = Uuid::new_v4().to_string();

        // Defense-in-depth: never adopt the live OS disk or anything mounted
        // at the system root. Detection normally filters these out, but this
        // guard makes it impossible to adopt them even if a caller bypasses it.
        if device.mount_point.as_deref() == Some("/") {
            anyhow::bail!(
                "That's the system disk Luna runs from — Luna won't touch the operating system's own drive."
            );
        }

        let mut choice = self.choice_for(device);
        if choice.needs_erase && !erase {
            anyhow::bail!("{INSTALLER_USB_MESSAGE}");
        }
        if erase && !(device.removable || device.usb) {
            anyhow::bail!("Luna will only erase a USB stick, not the computer's own disk.");
        }

        let foreign_target = self.foreign_mount_point(&device.name);
        if self.is_ours(&foreign_target) {
            self.mounter.unmount(&foreign_target)?;
        }

        if erase {
            self.unmount_disk_mounts(&device.name);
            self.probe
                .format_data_usb(&device.name, label)
                .map_err(|e| anyhow::anyhow!("Luna couldn't erase this USB. {e}"))?;
            choice = MountChoice {
                name: first_partition_name(&device.name),
                fs_type: "exfat".into(),
                needs_erase: false,
            };
        }

        let usb = device.removable || device.usb;
        let (mount_point, mounted_by_luna) = match &device.mount_point {
            Some(existing) if !erase && !self.is_ours(Path::new(existing)) => {
                let existing = PathBuf::from(existing);
                if is_system_mountpoint(&existing) {
                    anyhow::bail!(
                        "That's the system disk Luna runs from — Luna won't touch the operating system's own drive."
                    );
                }
                if device.mount_readonly {
                    let _ = self.mounter.remount(&existing, false);
                    if probe_writable(&existing).is_ok() {
                        (existing, false)
                    } else if usb {
                        self.mounter.unmount(&existing)?;
                        let target = self.adopted_mount_point(&id);
                        self.mounter
                            .mount_typed(
                                &device_path(&choice.name),
                                &target,
                                false,
                                fs_opt(&choice.fs_type),
                            )
                            .map_err(|e| anyhow::anyhow!("Could not add this drive. {e}"))?;
                        (target, true)
                    } else {
                        anyhow::bail!("{INSTALLER_USB_MESSAGE}");
                    }
                } else {
                    (existing, false)
                }
            }
            _ => {
                let target = self.adopted_mount_point(&id);
                self.mounter
                    .mount_typed(
                        &device_path(&choice.name),
                        &target,
                        false,
                        fs_opt(&choice.fs_type),
                    )
                    .map_err(|e| anyhow::anyhow!("Could not add this drive. {e}"))?;
                (target, true)
            }
        };

        let recorded_fs = if choice.fs_type.is_empty() {
            device.fs_type.as_deref().unwrap_or("")
        } else {
            choice.fs_type.as_str()
        };

        // Register the drive first, then write the marker. If the marker can't
        // be written, roll back the DB row and unmount so we never leave a
        // writable, registered-but-unmarked drive behind.
        db::upsert_drive(
            conn,
            &id,
            label,
            "as_is",
            recorded_fs,
            &device.name,
            mount_point.to_str().unwrap_or(""),
        )?;

        let marker = Marker::new(id.clone(), label);
        if let Err(e) = write_marker(&mount_point, &marker) {
            let _ = db::delete_drive(conn, &id);
            if mounted_by_luna {
                let _ = self.mounter.unmount(&mount_point);
                let _ = std::fs::remove_dir(&mount_point);
            }
            if is_erofs(&e) {
                return Err(anyhow::anyhow!("{WRITE_REJECTED_MESSAGE}"));
            }
            return Err(anyhow::anyhow!(
                "Luna could not mark this drive as its own. {e}"
            ));
        }

        db::get_drive(conn, &id)?
            .map(Ok)
            .unwrap_or_else(|| anyhow::bail!("Drive was added but could not be read back."))
    }

    fn choice_for(&self, device: &DetectedDrive) -> MountChoice {
        let parts = self.probe.probe_disk(&device.name);
        let mut choice = pick_mount_source(&device.name, &parts);
        if choice.fs_type.is_empty()
            && let Some(fs) = &device.fs_type
        {
            choice.fs_type = fs.clone();
        }
        if !is_writable_type(&choice.fs_type) && is_intrinsically_read_only(&choice.fs_type) {
            choice.needs_erase = true;
        }
        choice
    }

    fn unmount_disk_mounts(&self, disk: &str) {
        let mounts = std::fs::read_to_string("/proc/mounts").unwrap_or_default();
        let mut points: Vec<String> = Vec::new();
        for line in mounts.lines() {
            let mut fields = line.split_whitespace();
            let Some(device) = fields.next() else {
                continue;
            };
            let Some(point) = fields.next() else { continue };
            let name = Path::new(device)
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| device.to_string());
            if detect::is_partition_of(disk, &name) {
                points.push(point.to_string());
            }
        }
        points.sort_by_key(|p| std::cmp::Reverse(p.len()));
        for point in points {
            let path = Path::new(&point);
            if is_system_mountpoint(path) {
                continue;
            }
            let _ = self.mounter.unmount(path);
        }
        let foreign = self.foreign_mount_point(disk);
        if foreign.exists() {
            let _ = self.mounter.unmount(&foreign);
        }
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

fn fs_opt(fs_type: &str) -> Option<&str> {
    if fs_type.is_empty() {
        None
    } else {
        Some(fs_type)
    }
}

fn is_system_mountpoint(path: &Path) -> bool {
    let Some(s) = path.to_str() else {
        return true;
    };
    matches!(
        s,
        "/" | "/boot"
            | "/boot/efi"
            | "/efi"
            | "/usr"
            | "/etc"
            | "/sys"
            | "/proc"
            | "/dev"
            | "/home"
    ) || s.starts_with("/boot/")
        || s.starts_with("/usr/")
        || s.starts_with("/sys/")
        || s.starts_with("/proc/")
}

fn is_erofs(err: &luna_core::marker::MarkerError) -> bool {
    let text = err.to_string().to_ascii_lowercase();
    text.contains("read-only file system") || text.contains("erofs") || text.contains("os error 30")
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
    use crate::fsprobe::MockFsProbe;
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
            mount_readonly: false,
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

        let row = mgr.adopt(&conn, &dev, "Photos Drive", false).unwrap();
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
        let row = mgr.adopt(&conn, &dev, "Backup Drive", false).unwrap();

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
            .adopt(&conn, &detected("sdz", None), "Backup Drive", false)
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
            .adopt(&conn, &detected("sdz", None), "Backup Drive", false)
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
        let err = mgr
            .adopt(&conn, &detected("sdz", None), "   ", false)
            .unwrap_err();
        assert!(err.to_string().contains("name"));
        assert_eq!(mounter.mount_count(), 0);
    }

    fn iso_probe(disk: &str) -> Arc<MockFsProbe> {
        let probe = MockFsProbe::default();
        probe.disks.lock().unwrap().insert(
            disk.into(),
            vec![crate::fsprobe::FsInfo {
                name: disk.into(),
                fs_type: "iso9660".into(),
                label: "LUNAINST".into(),
                size_bytes: 8_000_000_000,
            }],
        );
        Arc::new(probe)
    }

    #[test]
    fn installer_usb_inspect_sets_needs_erase() {
        let mounter = shared_mock();
        let root = tempfile::tempdir().unwrap();
        let mgr = DriveManager::new_with_probe(mounter, root.path(), iso_probe("sdz"));
        let mut dev = detected("sdz", None);
        dev.fs_type = Some("iso9660".into());
        let inspection = mgr.inspect(&dev).unwrap();
        assert!(inspection.needs_erase);
    }

    #[test]
    fn installer_usb_adopt_without_erase_does_not_write() {
        let mounter = shared_mock();
        let root = tempfile::tempdir().unwrap();
        let dir = root.path();
        let conn = db::open(&dir.join("luna.db")).unwrap();
        let mgr = DriveManager::new_with_probe(mounter.clone(), dir, iso_probe("sdz"));
        let mut dev = detected("sdz", None);
        dev.fs_type = Some("iso9660".into());
        let err = mgr
            .adopt(&conn, &dev, "Lexar USB Flash Drive", false)
            .unwrap_err();
        assert!(err.to_string().contains("installer"));
        assert!(db::list_drives(&conn).unwrap().is_empty());
    }

    #[test]
    fn installer_usb_erase_formats_then_writes_marker() {
        let mounter = shared_mock();
        let root = tempfile::tempdir().unwrap();
        let dir = root.path();
        let conn = db::open(&dir.join("luna.db")).unwrap();
        let probe = iso_probe("sdz");
        let mgr = DriveManager::new_with_probe(mounter.clone(), dir, probe.clone());
        let mut dev = detected("sdz", None);
        dev.fs_type = Some("iso9660".into());
        let row = mgr
            .adopt(&conn, &dev, "Lexar USB Flash Drive", true)
            .unwrap();
        assert_eq!(row.label, "Lexar USB Flash Drive");
        assert!(
            luna_core::marker::read_marker(Path::new(&row.mount_point))
                .unwrap()
                .is_some()
        );
        let formatted = probe.formats.lock().unwrap().clone();
        assert_eq!(formatted, vec!["sdz".to_string()]);
        let mounts = mounter.mounts.lock().unwrap();
        assert!(
            mounts.iter().any(|m| m.0.ends_with("sdz1") && !m.2),
            "erase must mount the new partition read-write, got {mounts:?}"
        );
    }

    #[test]
    fn os_readonly_usb_is_remounted_writable() {
        let mounter = shared_mock();
        let root = tempfile::tempdir().unwrap();
        let dir = root.path();
        let existing = dir.join("os-usb");
        std::fs::create_dir_all(&existing).unwrap();
        let conn = db::open(&dir.join("luna.db")).unwrap();
        let mgr = DriveManager::new(mounter.clone(), dir);
        let mut dev = detected("sdz", existing.to_str());
        dev.mount_readonly = true;
        let row = mgr.adopt(&conn, &dev, "Photos Drive", false).unwrap();
        assert_eq!(
            mounter.remounts.lock().unwrap().as_slice(),
            &[(existing.clone(), false)]
        );
        assert!(
            luna_core::marker::read_marker(Path::new(&row.mount_point))
                .unwrap()
                .is_some()
        );
    }
}

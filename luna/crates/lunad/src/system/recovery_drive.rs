//! USB flash drive password recovery.
//!
//! When a user plugs in a **dedicated** USB flash drive whose only file is
//! `luna-recover.luna` at its root, lunad parses the JSON configuration and
//! resets or provisions accounts accordingly. Recovery is local and does not
//! depend on Luna Connect or any pairing material.
//!
//! Recovery is only honoured at boot, before the network listener binds —
//! there is no runtime polling. A stick is only accepted when it is a
//! dedicated recovery stick:
//!
//! - the root holds exactly one recovery file plus, at most, operating-system
//!   junk (`System Volume Information`, `.DS_Store`, …), and
//! - the drive carries no `.luna-*` marker (it was never adopted by any Luna).
//!
//! A member cannot produce a clean foreign stick through the file/WebDAV APIs:
//! adopted drives always carry a marker and user content. Physical possession
//! of a dedicated recovery stick is therefore required in every Connect state.
//!
//! Format (JSON):
//! ```json
//! {
//!   "user": "g-admin",
//!   "password": "newpassword123"
//! }
//! ```
//!
//! Or with multiple users:
//! ```json
//! {
//!   "users": ["u-admin", "n-operator"],
//!   "password": "newpassword123"
//! }
//! ```
//!
//! Selectors:
//! - `g-admin`: sets the password for all admin accounts
//! - `g-member`: sets the password for all standard member accounts
//! - `g-all`: sets the password for all accounts
//! - `u-<username>`: sets password for existing user; fails if user does not exist
//! - `n-<username>`: creates new user with that username and password; fails if user already exists
//! - `f-<username>`: sets password for existing user, or creates user if they don't exist

use rusqlite::Connection;
use serde::Deserialize;
use std::fs;
use std::path::{Path, PathBuf};

use crate::auth::hash_password;
use crate::db;
use crate::drives::DriveManager;
use crate::drives::detect::DetectedDrive;

#[derive(Debug, Deserialize)]
pub struct RecoveryPayload {
    #[serde(alias = "users")]
    pub user: UserSelector,
    pub password: String,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(untagged)]
pub enum UserSelector {
    Single(String),
    Multiple(Vec<String>),
}

impl UserSelector {
    pub fn selectors(&self) -> Vec<&str> {
        match self {
            UserSelector::Single(s) => vec![s.as_str()],
            UserSelector::Multiple(v) => v.iter().map(|s| s.as_str()).collect(),
        }
    }
}

#[derive(Debug, Default)]
pub struct RecoveryReport {
    pub updated: Vec<String>,
    pub created: Vec<String>,
}

/// Root entries an operating system writes to a stick on its own. A
/// dedicated recovery stick may contain these and nothing else besides the
/// recovery file itself. Compared case-insensitively (FAT/NTFS may fold
/// case).
const OS_JUNK: &[&str] = &[
    "system volume information",
    "$recycle.bin",
    "recycler",
    ".spotlight-v100",
    ".fseventsd",
    ".trashes",
    ".ds_store",
    ".appledouble",
    ".apdisk",
    "thumbs.db",
    "desktop.ini",
];

/// The active recovery file has a fixed, token-free name. Matching is
/// case-insensitive so sticks formatted on case-folding filesystems still work.
pub fn is_recovery_filename(name: &str) -> bool {
    name.eq_ignore_ascii_case("luna-recover.luna")
}

/// True for a recovery file that was already applied on a previous boot and
/// renamed in place — inert, and allowed to share the stick with a fresh
/// recovery file.
fn is_spent_recovery_file(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.starts_with("luna-recover") && (lower.ends_with(".done") || lower.ends_with(".applied"))
}

/// Apply a single user selector against the SQLite database.
pub fn apply_selector(
    conn: &Connection,
    selector: &str,
    password_hash: &str,
    report: &mut RecoveryReport,
) -> anyhow::Result<()> {
    let s = selector.trim();
    if s == "g-admin" {
        let admins = db::list_admins(conn)?;
        if admins.is_empty() {
            anyhow::bail!("No admin accounts exist in database");
        }
        for a in admins {
            db::set_user_password_hash(conn, &a.id, password_hash)?;
            db::bump_user_token_version(conn, &a.id)?;
            db::revoke_device_tokens_for_user(conn, &a.id)?;
            report.updated.push(a.username);
        }
    } else if s == "g-member" || s == "g-user" {
        let users = db::list_users(conn)?;
        let members: Vec<_> = users.into_iter().filter(|u| u.role == "user").collect();
        if members.is_empty() {
            anyhow::bail!("No member accounts exist in database");
        }
        for m in members {
            db::set_user_password_hash(conn, &m.id, password_hash)?;
            db::bump_user_token_version(conn, &m.id)?;
            db::revoke_device_tokens_for_user(conn, &m.id)?;
            report.updated.push(m.username);
        }
    } else if s == "g-all" {
        let users = db::list_users(conn)?;
        if users.is_empty() {
            anyhow::bail!("No accounts exist in database");
        }
        for u in users {
            db::set_user_password_hash(conn, &u.id, password_hash)?;
            db::bump_user_token_version(conn, &u.id)?;
            db::revoke_device_tokens_for_user(conn, &u.id)?;
            report.updated.push(u.username);
        }
    } else if let Some(username) = s.strip_prefix("u-") {
        let username = username.trim().to_lowercase();
        let user = db::get_user_by_username(conn, &username)?
            .ok_or_else(|| anyhow::anyhow!("User '{username}' does not exist"))?;
        db::set_user_password_hash(conn, &user.id, password_hash)?;
        db::bump_user_token_version(conn, &user.id)?;
        db::revoke_device_tokens_for_user(conn, &user.id)?;
        report.updated.push(user.username);
    } else if let Some(username) = s.strip_prefix("n-") {
        let username = username.trim().to_lowercase();
        if db::get_user_by_username(conn, &username)?.is_some() {
            anyhow::bail!("User '{username}' already exists");
        }
        let id = uuid::Uuid::new_v4().to_string();
        let role = "admin";
        db::insert_user(conn, &id, &username, &username, password_hash, role)?;
        report.created.push(username);
    } else if let Some(username) = s.strip_prefix("f-") {
        let username = username.trim().to_lowercase();
        if let Some(user) = db::get_user_by_username(conn, &username)? {
            db::set_user_password_hash(conn, &user.id, password_hash)?;
            db::bump_user_token_version(conn, &user.id)?;
            db::revoke_device_tokens_for_user(conn, &user.id)?;
            report.updated.push(user.username);
        } else {
            let id = uuid::Uuid::new_v4().to_string();
            let role = "admin";
            db::insert_user(conn, &id, &username, &username, password_hash, role)?;
            report.created.push(username);
        }
    } else {
        anyhow::bail!(
            "Unknown user selector '{selector}'. Expected g-admin, g-member, g-all, u-*, n-*, or f-*"
        );
    }
    Ok(())
}

/// Execute a recovery payload against the database.
pub fn execute_recovery(
    conn: &Connection,
    payload: &RecoveryPayload,
) -> anyhow::Result<RecoveryReport> {
    // A USB recovery password becomes the account's real password, so it must
    // pass the same policy as keyboard recovery — never hash it unchecked.
    let hash = hash_password(&payload.password)
        .map_err(|e| anyhow::anyhow!("Luna couldn't use the recovery password. {e}"))?;
    let mut report = RecoveryReport::default();
    for selector in payload.user.selectors() {
        apply_selector(conn, selector, &hash, &mut report)?;
    }
    Ok(report)
}

/// Inspect a candidate drive root for a recovery file and apply it.
///
/// The drive only qualifies as a dedicated recovery stick when every root
/// entry is either the recovery file itself, a previously-applied
/// `*.done`/`*.applied` recovery file, or allowlisted OS junk — and the
/// drive carries no `.luna-*` marker. Anything else (any user file, any
/// other directory) disqualifies it.
pub fn process_recovery_in_dir(
    dir: &Path,
    conn: &Connection,
) -> anyhow::Result<Option<RecoveryReport>> {
    // A drive any Luna has adopted can never be a recovery stick.
    if luna_core::marker::read_markers(dir)
        .map(|m| !m.is_empty())
        .unwrap_or(false)
    {
        return Ok(None);
    }

    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return Ok(None),
    };

    let mut recovery_files: Vec<PathBuf> = Vec::new();
    for entry in entries.flatten() {
        let name = match entry.file_name().to_str() {
            Some(n) => n.to_string(),
            None => return Ok(None), // non-UTF-8 name: not a dedicated stick
        };
        if is_recovery_filename(&name) {
            if !entry.path().is_file() {
                return Ok(None);
            }
            recovery_files.push(entry.path());
        } else if is_spent_recovery_file(&name)
            || OS_JUNK.contains(&name.to_ascii_lowercase().as_str())
        {
            continue;
        } else {
            // Foreign content — this is not a dedicated recovery stick.
            return Ok(None);
        }
    }

    if recovery_files.len() != 1 {
        if recovery_files.len() > 1 {
            tracing::warn!(
                dir = %dir.display(),
                "USB recovery ignored: more than one luna-recover file on the stick"
            );
        }
        return Ok(None);
    }
    let path = recovery_files.remove(0);
    let content = fs::read_to_string(&path)
        .map_err(|e| anyhow::anyhow!("Could not read recovery file {}: {e}", path.display()))?;
    let payload: RecoveryPayload = serde_json::from_str(&content)
        .map_err(|e| anyhow::anyhow!("Invalid JSON in recovery file {}: {e}", path.display()))?;

    let report = execute_recovery(conn, &payload)?;

    // Rename file to prevent re-execution on the next boot.
    let done_path = path.with_extension("luna.done");
    let _ = fs::rename(&path, &done_path);

    // Audio bell feedback for headless verification.
    eprint!("\x07\x07");

    tracing::info!(
        dir = %dir.display(),
        updated = ?report.updated,
        created = ?report.created,
        "USB flash drive password recovery applied"
    );
    Ok(Some(report))
}

/// One boot-time pass over every place a recovery stick could appear.
///
/// Called synchronously from `main` after drive reconciliation, before
/// Connect is restored and before the HTTP listener binds — no network peer
/// can reach lunad while this runs.
///
/// Adopted drives under `mounts/drives` are never candidates (they carry a
/// Luna marker and user content, so `process_recovery_in_dir` would reject
/// them anyway — we simply do not scan them). Removable devices detected
/// but not mounted at boot are briefly mounted read-only, inspected, and
/// unmounted.
pub fn scan_at_boot(
    data_dir: &Path,
    conn: &Connection,
    detected: &[DetectedDrive],
    drives: &DriveManager,
) -> Option<RecoveryReport> {
    let adopted_base = data_dir.join("mounts/drives");
    let foreign_base = data_dir.join("mounts/foreign");

    let mut candidate_dirs: Vec<PathBuf> = Vec::new();
    let push = |p: PathBuf, candidate_dirs: &mut Vec<PathBuf>| {
        if !p.starts_with(&adopted_base) && !candidate_dirs.contains(&p) {
            candidate_dirs.push(p);
        }
    };

    // Foreign mounts Luna created for inspection: each subdir is a drive root.
    if let Ok(entries) = fs::read_dir(&foreign_base) {
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                push(p, &mut candidate_dirs);
            }
        }
    }

    // System mount locations (/media, /run/media, /mnt).
    for sys_base in &["/media", "/run/media", "/mnt"] {
        let p = Path::new(sys_base);
        if p.is_dir()
            && let Ok(entries) = fs::read_dir(p)
        {
            for e in entries.flatten() {
                let ep = e.path();
                if ep.is_dir() {
                    push(ep, &mut candidate_dirs);
                }
            }
        }
    }

    // Any other external filesystem already mounted (per /proc/mounts).
    if let Ok(mounts_content) = fs::read_to_string("/proc/mounts") {
        for line in mounts_content.lines() {
            let mut parts = line.split_whitespace();
            let dev = parts.next().unwrap_or("");
            let mnt = parts.next().unwrap_or("");
            if dev.starts_with("/dev/sd")
                || dev.starts_with("/dev/nvme")
                || dev.starts_with("/dev/vd")
                || dev.starts_with("/dev/mmcblk")
            {
                push(PathBuf::from(mnt), &mut candidate_dirs);
            }
        }
    }

    for dir in &candidate_dirs {
        if dir.is_dir()
            && let Ok(Some(report)) = process_recovery_in_dir(dir, conn)
        {
            return Some(report);
        }
    }

    // Sticks plugged in but never mounted: brief read-only mount, inspect,
    // unmount. Restricted to removable/USB storage — never internal disks.
    for device in detected {
        if !(device.removable || device.usb) || !device.is_storage_candidate() {
            continue;
        }
        if let Some(Some(report)) = drives.with_temp_ro_mount(device, |root| {
            process_recovery_in_dir(root, conn).ok().flatten()
        }) {
            return Some(report);
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::hash_password_unchecked;
    use rusqlite::Connection;
    use tempfile::TempDir;

    fn test_db() -> (TempDir, Connection) {
        let dir = TempDir::new().unwrap();
        let conn = crate::db::open(&dir.path().join("test.db")).unwrap();
        (dir, conn)
    }

    #[test]
    fn only_the_generic_recovery_filename_matches() {
        assert!(is_recovery_filename("luna-recover.luna"));
        assert!(is_recovery_filename("LUNA-RECOVER.LUNA"));
        for name in [
            "luna-recover-a3f91c.luna",
            "luna-recover-abcd-efgh-jklm-npqr.luna",
            "luna-recover-.luna",
            "luna-recover.luna.done",
            "luna-recover-1234.txt",
            "pwreset.luna",
            "pwreset-abc.luna",
            "other.luna",
        ] {
            assert!(!is_recovery_filename(name), "{name} must not match");
        }
    }

    #[test]
    fn recovery_payload_keeps_its_envelope_and_selectors() {
        let single: RecoveryPayload =
            serde_json::from_str(r#"{"user":"g-admin","password":"newpassword1"}"#).unwrap();
        assert_eq!(single.user.selectors(), vec!["g-admin"]);
        assert_eq!(single.password, "newpassword1");

        let multiple: RecoveryPayload = serde_json::from_str(
            r#"{"users":["u-admin","n-backup","f-restore"],"password":"newpassword1"}"#,
        )
        .unwrap();
        assert_eq!(
            multiple.user.selectors(),
            vec!["u-admin", "n-backup", "f-restore"]
        );
        assert_eq!(multiple.password, "newpassword1");
    }

    #[test]
    fn code_named_and_token_named_recovery_files_are_rejected() {
        let (data_dir, conn) = test_db();
        let old_hash = hash_password_unchecked("oldpass").unwrap();
        db::insert_user(&conn, "1", "admin", "Admin", &old_hash, "admin").unwrap();
        // Even matching local material must not turn a suffixed filename into
        // a recovery credential.
        fs::write(data_dir.path().join("pairing-code"), "A3F91C\n").unwrap();
        fs::write(
            data_dir.path().join("device-token"),
            "ABCD-EFGH-JKLM-NPQR\n",
        )
        .unwrap();
        fs::write(data_dir.path().join("setup-token"), "ABCD-EFGH-JKLM-NPQR\n").unwrap();

        for name in [
            "luna-recover-a3f91c.luna",
            "luna-recover-abcd-efgh-jklm-npqr.luna",
        ] {
            let usb_dir = TempDir::new().unwrap();
            let recovery_file = usb_dir.path().join(name);
            fs::write(
                &recovery_file,
                r#"{"user":"g-admin","password":"recoveredpassword1"}"#,
            )
            .unwrap();

            let res = process_recovery_in_dir(usb_dir.path(), &conn).unwrap();
            assert!(res.is_none(), "suffixed recovery file must be ignored");
            assert!(recovery_file.exists());
            let admin = db::get_user_by_username(&conn, "admin").unwrap().unwrap();
            assert_eq!(admin.password_hash, old_hash);
        }
    }

    #[test]
    fn apply_g_admin_updates_all_admins() {
        let (_dir, conn) = test_db();
        let hash = hash_password_unchecked("oldpass").unwrap();
        db::insert_user(&conn, "1", "admin1", "Admin 1", &hash, "admin").unwrap();
        db::insert_user(&conn, "2", "admin2", "Admin 2", &hash, "admin").unwrap();
        db::insert_user(&conn, "3", "member1", "Member 1", &hash, "user").unwrap();

        let new_hash = hash_password_unchecked("newpass").unwrap();
        let mut report = RecoveryReport::default();
        apply_selector(&conn, "g-admin", &new_hash, &mut report).unwrap();

        assert_eq!(report.updated.len(), 2);
        assert!(report.updated.contains(&"admin1".to_string()));
        assert!(report.updated.contains(&"admin2".to_string()));

        let u1 = db::get_user_by_username(&conn, "admin1").unwrap().unwrap();
        assert_eq!(u1.password_hash, new_hash);
        let u3 = db::get_user_by_username(&conn, "member1").unwrap().unwrap();
        assert_eq!(u3.password_hash, hash); // Unchanged
    }

    #[test]
    fn apply_g_member_updates_members_only() {
        let (_dir, conn) = test_db();
        let hash = hash_password_unchecked("oldpass").unwrap();
        db::insert_user(&conn, "1", "admin1", "Admin 1", &hash, "admin").unwrap();
        db::insert_user(&conn, "2", "member1", "Member 1", &hash, "user").unwrap();

        let new_hash = hash_password_unchecked("newpass").unwrap();
        let mut report = RecoveryReport::default();
        apply_selector(&conn, "g-member", &new_hash, &mut report).unwrap();

        assert_eq!(report.updated, vec!["member1"]);
        let u2 = db::get_user_by_username(&conn, "member1").unwrap().unwrap();
        assert_eq!(u2.password_hash, new_hash);
        let u1 = db::get_user_by_username(&conn, "admin1").unwrap().unwrap();
        assert_eq!(u1.password_hash, hash); // Unchanged
    }

    #[test]
    fn apply_g_all_updates_every_user() {
        let (_dir, conn) = test_db();
        let hash = hash_password_unchecked("oldpass").unwrap();
        db::insert_user(&conn, "1", "admin1", "Admin 1", &hash, "admin").unwrap();
        db::insert_user(&conn, "2", "member1", "Member 1", &hash, "user").unwrap();

        let new_hash = hash_password_unchecked("newpass").unwrap();
        let mut report = RecoveryReport::default();
        apply_selector(&conn, "g-all", &new_hash, &mut report).unwrap();

        assert_eq!(report.updated.len(), 2);
        let u1 = db::get_user_by_username(&conn, "admin1").unwrap().unwrap();
        assert_eq!(u1.password_hash, new_hash);
        let u2 = db::get_user_by_username(&conn, "member1").unwrap().unwrap();
        assert_eq!(u2.password_hash, new_hash);
    }

    #[test]
    fn apply_u_selector_updates_existing_and_fails_on_missing() {
        let (_dir, conn) = test_db();
        let hash = hash_password_unchecked("oldpass").unwrap();
        db::insert_user(&conn, "1", "alice", "Alice", &hash, "admin").unwrap();

        let new_hash = hash_password_unchecked("newpass").unwrap();
        let mut report = RecoveryReport::default();
        apply_selector(&conn, "u-alice", &new_hash, &mut report).unwrap();
        assert_eq!(report.updated, vec!["alice"]);

        // Fails on non-existent user
        let err = apply_selector(&conn, "u-bob", &new_hash, &mut report).unwrap_err();
        assert!(err.to_string().contains("does not exist"));
    }

    #[test]
    fn apply_n_selector_creates_new_and_fails_on_existing() {
        let (_dir, conn) = test_db();
        let hash = hash_password_unchecked("oldpass").unwrap();
        db::insert_user(&conn, "1", "alice", "Alice", &hash, "admin").unwrap();

        let new_hash = hash_password_unchecked("newpass").unwrap();
        let mut report = RecoveryReport::default();
        apply_selector(&conn, "n-bob", &new_hash, &mut report).unwrap();
        assert_eq!(report.created, vec!["bob"]);

        let bob = db::get_user_by_username(&conn, "bob").unwrap().unwrap();
        assert_eq!(bob.password_hash, new_hash);

        // Fails on existing user
        let err = apply_selector(&conn, "n-alice", &new_hash, &mut report).unwrap_err();
        assert!(err.to_string().contains("already exists"));
    }

    #[test]
    fn apply_f_selector_upserts() {
        let (_dir, conn) = test_db();
        let hash = hash_password_unchecked("oldpass").unwrap();
        db::insert_user(&conn, "1", "alice", "Alice", &hash, "admin").unwrap();

        let new_hash = hash_password_unchecked("newpass").unwrap();
        let mut report = RecoveryReport::default();

        // Updates alice
        apply_selector(&conn, "f-alice", &new_hash, &mut report).unwrap();
        assert_eq!(report.updated, vec!["alice"]);

        // Creates charlie
        apply_selector(&conn, "f-charlie", &new_hash, &mut report).unwrap();
        assert_eq!(report.created, vec!["charlie"]);
        assert!(
            db::get_user_by_username(&conn, "charlie")
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn generic_recovery_applies_in_every_connect_state() {
        let old_hash = hash_password_unchecked("oldpass").unwrap();
        for state in ["unbound", "pairing", "bound", "revoked"] {
            let (data_dir, conn) = test_db();
            db::insert_user(&conn, "1", "admin", "Admin", &old_hash, "admin").unwrap();
            fs::write(
                data_dir.path().join("connect.json"),
                format!(r#"{{"state":"{state}","bound":false}}"#),
            )
            .unwrap();
            // None of these files authorizes or blocks physical recovery.
            fs::write(data_dir.path().join("pairing-code"), "A3F91C\n").unwrap();
            fs::write(data_dir.path().join("connect-credential"), "credential").unwrap();
            fs::write(data_dir.path().join("connect-unbind-pending"), "{}").unwrap();

            let usb_dir = TempDir::new().unwrap();
            let recovery_file = usb_dir.path().join("luna-recover.luna");
            fs::write(
                &recovery_file,
                r#"{"user":"g-admin","password":"recoveredpassword1"}"#,
            )
            .unwrap();
            // OS junk is tolerated on a dedicated stick.
            fs::create_dir(usb_dir.path().join("System Volume Information")).unwrap();
            fs::write(usb_dir.path().join(".DS_Store"), b"").unwrap();

            let res = process_recovery_in_dir(usb_dir.path(), &conn).unwrap();
            let report = res.expect("dedicated stick must be honoured in every Connect state");
            assert_eq!(report.updated, vec!["admin"]);

            assert!(!recovery_file.exists());
            assert!(usb_dir.path().join("luna-recover.luna.done").exists());

            let admin = db::get_user_by_username(&conn, "admin").unwrap().unwrap();
            assert_ne!(admin.password_hash, old_hash);
            assert!(
                crate::auth::verify_password_hash(
                    "recoveredpassword1",
                    &argon2::PasswordHash::new(&admin.password_hash).unwrap()
                )
                .is_ok()
            );
        }
    }

    #[test]
    fn stick_with_user_files_is_rejected() {
        let (_data_dir, conn) = test_db();
        db::insert_user(&conn, "1", "admin", "Admin", "h", "admin").unwrap();

        let usb_dir = TempDir::new().unwrap();
        fs::write(
            usb_dir.path().join("luna-recover.luna"),
            r#"{"user": "n-evil", "password": "password123"}"#,
        )
        .unwrap();
        // Any other file disqualifies the stick.
        fs::write(usb_dir.path().join("vacation.jpg"), b"jpeg").unwrap();

        let res = process_recovery_in_dir(usb_dir.path(), &conn).unwrap();
        assert!(res.is_none(), "non-dedicated stick must be ignored");
        assert!(db::get_user_by_username(&conn, "evil").unwrap().is_none());
    }

    #[test]
    fn adopted_drive_is_rejected() {
        let (_data_dir, conn) = test_db();
        db::insert_user(&conn, "1", "admin", "Admin", "h", "admin").unwrap();

        let usb_dir = TempDir::new().unwrap();
        // A `.luna-*` marker means some Luna adopted this drive — it can
        // never be a recovery stick, even if it otherwise looks clean.
        let prefix = luna_core::marker::pick_prefix(usb_dir.path()).unwrap();
        crate::drives::drive_db::create(
            usb_dir.path(),
            &luna_core::marker::Marker::new("drv-x", "X"),
            &prefix,
        )
        .unwrap();
        fs::write(
            usb_dir.path().join("luna-recover.luna"),
            r#"{"user": "n-evil", "password": "password123"}"#,
        )
        .unwrap();

        let res = process_recovery_in_dir(usb_dir.path(), &conn).unwrap();
        assert!(res.is_none(), "adopted drive must be ignored");
        assert!(db::get_user_by_username(&conn, "evil").unwrap().is_none());
    }

    #[test]
    fn spent_recovery_file_is_allowed_beside_fresh_one() {
        let (_data_dir, conn) = test_db();
        db::insert_user(&conn, "1", "admin", "Admin", "h", "admin").unwrap();

        let usb_dir = TempDir::new().unwrap();
        fs::write(
            usb_dir.path().join("luna-recover.luna.applied"),
            "applied earlier",
        )
        .unwrap();
        fs::write(
            usb_dir.path().join("luna-recover.luna"),
            r#"{"user": "u-admin", "password": "newpassword1"}"#,
        )
        .unwrap();

        let res = process_recovery_in_dir(usb_dir.path(), &conn).unwrap();
        assert!(
            res.is_some(),
            "spent .applied file must not disqualify the stick"
        );
    }

    #[test]
    fn two_active_recovery_files_are_rejected() {
        let (_data_dir, conn) = test_db();
        db::insert_user(&conn, "1", "admin", "Admin", "h", "admin").unwrap();

        let usb_dir = TempDir::new().unwrap();
        for name in ["luna-recover.luna", "LUNA-RECOVER.LUNA"] {
            fs::write(
                usb_dir.path().join(name),
                r#"{"user": "n-evil", "password": "password123"}"#,
            )
            .unwrap();
        }

        let res = process_recovery_in_dir(usb_dir.path(), &conn).unwrap();
        assert!(res.is_none(), "ambiguous stick must be ignored");
        assert!(db::get_user_by_username(&conn, "evil").unwrap().is_none());
    }
}

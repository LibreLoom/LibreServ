//! USB flash drive password recovery.
//!
//! When a user plugs in a **dedicated** USB flash drive whose only file is
//! `luna-recover-<device_token>.luna` (or `luna-recover.luna` if no device
//! token is configured on Luna) at its root, lunad validates the device
//! token, parses the JSON configuration, and resets or provisions accounts
//! accordingly.
//!
//! Recovery is only honoured at boot, before the network listener binds —
//! there is no runtime polling. A stick is only accepted when it is a
//! dedicated recovery stick:
//!
//! - the root holds exactly one recovery file plus, at most, operating-system
//!   junk (`System Volume Information`, `.DS_Store`, …), and
//! - the drive carries no `.luna-*` marker (it was never adopted by any Luna).
//!
//! That means a member who merely knows the device token cannot escalate:
//! they cannot produce a clean foreign stick through the file/WebDAV APIs —
//! adopted drives always carry a marker and user content.
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

use crate::auth::hash_password_unchecked;
use crate::db;
use crate::drives::DriveManager;
use crate::drives::detect::DetectedDrive;
use crate::net::connect::{DEVICE_TOKEN_FILE, normalize_setup_code};

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

/// Checks if a file name matches `luna-recover-<token>.luna` or
/// `luna-recover.luna`. Returns `Some(offered_token)` if it matches.
pub fn parse_recovery_filename(name: &str) -> Option<String> {
    let lower = name.to_ascii_lowercase();
    if lower == "luna-recover.luna" {
        return Some(String::new());
    }
    if let Some(rest) = lower.strip_prefix("luna-recover-")
        && let Some(token) = rest.strip_suffix(".luna")
        && !token.is_empty()
    {
        return Some(token.to_string());
    }
    None
}

/// True for a recovery file that was already applied on a previous boot and
/// renamed in place — inert, and allowed to share the stick with a fresh
/// recovery file.
fn is_spent_recovery_file(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.starts_with("luna-recover") && (lower.ends_with(".done") || lower.ends_with(".applied"))
}

/// Verify that the offered token from the filename matches the device token on disk.
///
/// Consults the legacy `setup-token` file too: this check runs at boot,
/// before Connect has had a chance to migrate it to `device-token`. Mirrors
/// `ConnectService::read_device_token` — the first file whose contents parse
/// as a device token wins; malformed files are ignored rather than vetoing.
pub fn verify_device_token(data_dir: &Path, offered_token: &str) -> bool {
    let expected = [
        DEVICE_TOKEN_FILE,
        crate::net::connect::LEGACY_DEVICE_TOKEN_FILE,
    ]
    .iter()
    .filter_map(|f| fs::read_to_string(data_dir.join(f)).ok())
    .map(|s| s.trim().to_string())
    .map(|raw| normalize_setup_code(&raw))
    .find(|norm| crate::net::connect::is_device_token_format(norm));

    match expected {
        Some(norm_expected) => {
            let norm_offered = normalize_setup_code(offered_token);
            !norm_offered.is_empty() && norm_offered == norm_expected
        }
        None => {
            // No device token configured on this unit yet.
            // Accept luna-recover.luna (empty token) or any offered token.
            true
        }
    }
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
    let hash = hash_password_unchecked(&payload.password)
        .map_err(|e| anyhow::anyhow!("Could not hash recovery password: {e}"))?;
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
    data_dir: &Path,
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
        if parse_recovery_filename(&name).is_some() {
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
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    let offered_token = parse_recovery_filename(name).unwrap_or_default();

    if !verify_device_token(data_dir, &offered_token) {
        // The filename carries the offered token — never log it.
        tracing::warn!(
            dir = %dir.display(),
            "USB recovery file ignored: device token did not match this Luna"
        );
        return Ok(None);
    }

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
            && let Ok(Some(report)) = process_recovery_in_dir(dir, data_dir, conn)
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
            process_recovery_in_dir(root, data_dir, conn).ok().flatten()
        }) {
            return Some(report);
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use tempfile::TempDir;

    fn test_db() -> (TempDir, Connection) {
        let dir = TempDir::new().unwrap();
        let conn = crate::db::open(&dir.path().join("test.db")).unwrap();
        (dir, conn)
    }

    #[test]
    fn parse_recovery_filename_works() {
        assert_eq!(
            parse_recovery_filename("luna-recover.luna"),
            Some("".into())
        );
        assert_eq!(
            parse_recovery_filename("LUNA-RECOVER.LUNA"),
            Some("".into())
        );
        assert_eq!(
            parse_recovery_filename("luna-recover-1234-abcd.luna"),
            Some("1234-abcd".into())
        );
        assert_eq!(
            parse_recovery_filename("LUNA-RECOVER-ABC123XYZ.LUNA"),
            Some("abc123xyz".into())
        );
        assert_eq!(parse_recovery_filename("other.luna"), None);
        assert_eq!(parse_recovery_filename("luna-recover-1234.txt"), None);
        // Old scheme must no longer match.
        assert_eq!(parse_recovery_filename("pwreset.luna"), None);
        assert_eq!(parse_recovery_filename("pwreset-abc.luna"), None);
        // Token must not be empty in the suffixed form.
        assert_eq!(parse_recovery_filename("luna-recover-.luna"), None);
    }

    #[test]
    fn verify_device_token_matches_normalized() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join(DEVICE_TOKEN_FILE), "ABCD-EFGH-JKLM-NPQR\n").unwrap();

        assert!(verify_device_token(dir.path(), "abcd-efgh-jklm-npqr"));
        assert!(verify_device_token(dir.path(), "abcdefghjklmnpqr"));
        assert!(verify_device_token(dir.path(), "ABCD-EFGH-JKLM-NPQR"));
        assert!(!verify_device_token(dir.path(), "WRONG-TOKEN-VALUE-123"));
        assert!(!verify_device_token(dir.path(), ""));
    }

    #[test]
    fn verify_device_token_reads_legacy_setup_token() {
        let dir = TempDir::new().unwrap();
        // Unit set up before the device-token rename: only setup-token exists.
        fs::write(
            dir.path()
                .join(crate::net::connect::LEGACY_DEVICE_TOKEN_FILE),
            "ABCD-EFGH-JKLM-NPQR\n",
        )
        .unwrap();

        assert!(verify_device_token(dir.path(), "abcd-efgh-jklm-npqr"));
        assert!(!verify_device_token(dir.path(), "WRONG-TOKEN-VALUE-123"));
        assert!(!verify_device_token(dir.path(), ""));
    }

    #[test]
    fn verify_device_token_malformed_canonical_falls_back_to_legacy() {
        let dir = TempDir::new().unwrap();
        // Malformed device-token (e.g. truncated write) must not veto a valid
        // legacy setup-token — same precedence as read_device_token.
        fs::write(dir.path().join(DEVICE_TOKEN_FILE), "not-a-code").unwrap();
        fs::write(
            dir.path()
                .join(crate::net::connect::LEGACY_DEVICE_TOKEN_FILE),
            "ABCD-EFGH-JKLM-NPQR\n",
        )
        .unwrap();

        assert!(verify_device_token(dir.path(), "abcd-efgh-jklm-npqr"));
        assert!(!verify_device_token(dir.path(), "WRONG-TOKEN-VALUE-123"));
    }

    #[test]
    fn verify_device_token_malformed_only_treated_as_unconfigured() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join(DEVICE_TOKEN_FILE), "not-a-code").unwrap();
        // No usable binding on the unit — same as no token configured.
        assert!(verify_device_token(dir.path(), "any-token"));
    }

    #[test]
    fn verify_device_token_when_unconfigured_accepts_blank_or_offered() {
        let dir = TempDir::new().unwrap();
        // File does not exist
        assert!(verify_device_token(dir.path(), ""));
        assert!(verify_device_token(dir.path(), "any-token"));
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
    fn process_recovery_applies_on_dedicated_stick_and_renames() {
        let (data_dir, conn) = test_db();
        fs::write(data_dir.path().join(DEVICE_TOKEN_FILE), "SEC-TOKEN-123\n").unwrap();

        let hash = hash_password_unchecked("oldpass").unwrap();
        db::insert_user(&conn, "1", "admin", "Admin", &hash, "admin").unwrap();

        let usb_dir = TempDir::new().unwrap();
        let recovery_file = usb_dir.path().join("luna-recover-sec-token-123.luna");
        fs::write(
            &recovery_file,
            r#"{"user": "g-admin", "password": "recoveredpassword"}"#,
        )
        .unwrap();
        // OS junk is tolerated on a dedicated stick.
        fs::create_dir(usb_dir.path().join("System Volume Information")).unwrap();
        fs::write(usb_dir.path().join(".DS_Store"), b"").unwrap();

        let res = process_recovery_in_dir(usb_dir.path(), data_dir.path(), &conn).unwrap();
        let report = res.expect("dedicated stick must be honoured");
        assert_eq!(report.updated, vec!["admin"]);

        // File must be renamed to .luna.done
        assert!(!recovery_file.exists());
        assert!(
            usb_dir
                .path()
                .join("luna-recover-sec-token-123.luna.done")
                .exists()
        );

        let admin = db::get_user_by_username(&conn, "admin").unwrap().unwrap();
        assert!(
            crate::auth::verify_password_hash(
                "recoveredpassword",
                &argon2::PasswordHash::new(&admin.password_hash).unwrap()
            )
            .is_ok()
        );
    }

    #[test]
    fn stick_with_user_files_is_rejected() {
        let (data_dir, conn) = test_db();
        fs::write(data_dir.path().join(DEVICE_TOKEN_FILE), "SEC-TOKEN-123\n").unwrap();
        db::insert_user(&conn, "1", "admin", "Admin", "h", "admin").unwrap();

        let usb_dir = TempDir::new().unwrap();
        fs::write(
            usb_dir.path().join("luna-recover-sec-token-123.luna"),
            r#"{"user": "n-evil", "password": "password123"}"#,
        )
        .unwrap();
        // Any other file disqualifies the stick.
        fs::write(usb_dir.path().join("vacation.jpg"), b"jpeg").unwrap();

        let res = process_recovery_in_dir(usb_dir.path(), data_dir.path(), &conn).unwrap();
        assert!(res.is_none(), "non-dedicated stick must be ignored");
        assert!(db::get_user_by_username(&conn, "evil").unwrap().is_none());
    }

    #[test]
    fn adopted_drive_is_rejected() {
        let (data_dir, conn) = test_db();
        fs::write(data_dir.path().join(DEVICE_TOKEN_FILE), "SEC-TOKEN-123\n").unwrap();
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
            usb_dir.path().join("luna-recover-sec-token-123.luna"),
            r#"{"user": "n-evil", "password": "password123"}"#,
        )
        .unwrap();

        let res = process_recovery_in_dir(usb_dir.path(), data_dir.path(), &conn).unwrap();
        assert!(res.is_none(), "adopted drive must be ignored");
        assert!(db::get_user_by_username(&conn, "evil").unwrap().is_none());
    }

    #[test]
    fn spent_recovery_file_is_allowed_beside_fresh_one() {
        let (data_dir, conn) = test_db();
        fs::write(data_dir.path().join(DEVICE_TOKEN_FILE), "SEC-TOKEN-123\n").unwrap();
        db::insert_user(&conn, "1", "admin", "Admin", "h", "admin").unwrap();

        let usb_dir = TempDir::new().unwrap();
        fs::write(
            usb_dir.path().join("luna-recover-old-token.luna.done"),
            "applied earlier",
        )
        .unwrap();
        fs::write(
            usb_dir.path().join("luna-recover-sec-token-123.luna"),
            r#"{"user": "u-admin", "password": "newpassword1"}"#,
        )
        .unwrap();

        let res = process_recovery_in_dir(usb_dir.path(), data_dir.path(), &conn).unwrap();
        assert!(
            res.is_some(),
            "spent .done file must not disqualify the stick"
        );
    }

    #[test]
    fn two_active_recovery_files_are_rejected() {
        let (data_dir, conn) = test_db();
        fs::write(data_dir.path().join(DEVICE_TOKEN_FILE), "SEC-TOKEN-123\n").unwrap();
        db::insert_user(&conn, "1", "admin", "Admin", "h", "admin").unwrap();

        let usb_dir = TempDir::new().unwrap();
        for name in [
            "luna-recover-sec-token-123.luna",
            "luna-recover-anything.luna",
        ] {
            fs::write(
                usb_dir.path().join(name),
                r#"{"user": "n-evil", "password": "password123"}"#,
            )
            .unwrap();
        }

        let res = process_recovery_in_dir(usb_dir.path(), data_dir.path(), &conn).unwrap();
        assert!(res.is_none(), "ambiguous stick must be ignored");
        assert!(db::get_user_by_username(&conn, "evil").unwrap().is_none());
    }
}

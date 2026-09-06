//! USB flash drive password recovery.
//!
//! When a user plugs in a USB flash drive with `pwreset-<device_token>.luna` at
//! its root, lunad validates the device token, parses the JSON configuration,
//! and resets or provisions accounts accordingly.
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
use crate::connect::{DEVICE_TOKEN_FILE, normalize_setup_code};
use crate::db;

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

/// Checks if a file name matches `pwreset-<token>.luna` or `pwreset.luna`.
/// Returns `Some(offered_token)` if it matches.
pub fn parse_recovery_filename(name: &str) -> Option<String> {
    let lower = name.to_ascii_lowercase();
    if lower == "pwreset.luna" {
        return Some(String::new());
    }
    if let Some(rest) = lower.strip_prefix("pwreset-")
        && let Some(token) = rest.strip_suffix(".luna")
    {
        return Some(token.to_string());
    }
    None
}

/// Verify that the offered token from the filename matches the device token on disk.
pub fn verify_device_token(data_dir: &Path, offered_token: &str) -> bool {
    let token_file = data_dir.join(DEVICE_TOKEN_FILE);
    let expected = fs::read_to_string(&token_file)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    match expected {
        Some(expected_raw) => {
            let norm_expected = normalize_setup_code(&expected_raw);
            let norm_offered = normalize_setup_code(offered_token);
            !norm_offered.is_empty() && norm_offered == norm_expected
        }
        None => {
            // No device token configured on this unit yet.
            // Accept pwreset.luna (empty token) or any offered token.
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

/// Look for a recovery file in `dir`, verify its token against `data_dir`,
/// execute the recovery, and rename the file to `.done`.
pub fn process_recovery_in_dir(
    dir: &Path,
    data_dir: &Path,
    conn: &Connection,
) -> anyhow::Result<Option<RecoveryReport>> {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return Ok(None),
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n,
            None => continue,
        };
        if name.ends_with(".done") || name.ends_with(".applied") {
            continue;
        }

        if let Some(offered_token) = parse_recovery_filename(name) {
            if !verify_device_token(data_dir, &offered_token) {
                tracing::warn!(
                    file = %path.display(),
                    offered = %offered_token,
                    "USB recovery file ignored: device token did not match this Luna"
                );
                continue;
            }

            let content = fs::read_to_string(&path).map_err(|e| {
                anyhow::anyhow!("Could not read recovery file {}: {e}", path.display())
            })?;
            let payload: RecoveryPayload = serde_json::from_str(&content).map_err(|e| {
                anyhow::anyhow!("Invalid JSON in recovery file {}: {e}", path.display())
            })?;

            let report = execute_recovery(conn, &payload)?;

            // Rename file to prevent re-execution
            let done_path = path.with_extension("luna.done");
            let _ = fs::rename(&path, &done_path);

            // Audio bell feedback for headless verification
            eprint!("\x07\x07");

            tracing::info!(
                file = %path.display(),
                updated = ?report.updated,
                created = ?report.created,
                "USB flash drive password recovery applied successfully"
            );
            return Ok(Some(report));
        }
    }

    Ok(None)
}

/// Scan candidate mount directories for USB flash drive recovery files.
pub fn scan_candidate_dirs(
    data_dir: &Path,
    conn: &Connection,
) -> anyhow::Result<Option<RecoveryReport>> {
    let mut candidate_dirs: Vec<PathBuf> = Vec::new();

    // Check adopted drives and foreign mounts
    candidate_dirs.push(data_dir.join("mounts/foreign"));
    candidate_dirs.push(data_dir.join("mounts/drives"));

    // Check system mount locations (/media, /run/media, /mnt)
    for sys_base in &["/media", "/run/media", "/mnt"] {
        let p = Path::new(sys_base);
        if p.is_dir()
            && let Ok(entries) = fs::read_dir(p)
        {
            for e in entries.flatten() {
                let ep = e.path();
                if ep.is_dir() {
                    candidate_dirs.push(ep);
                }
            }
        }
    }

    // Check /proc/mounts for any other external filesystem mounts
    if let Ok(mounts_content) = fs::read_to_string("/proc/mounts") {
        for line in mounts_content.lines() {
            let mut parts = line.split_whitespace();
            let dev = parts.next().unwrap_or("");
            let mnt = parts.next().unwrap_or("");
            if dev.starts_with("/dev/sd")
                || dev.starts_with("/dev/nvme")
                || dev.starts_with("/dev/vd")
            {
                let mnt_path = PathBuf::from(mnt);
                if !candidate_dirs.contains(&mnt_path) {
                    candidate_dirs.push(mnt_path);
                }
            }
        }
    }

    for dir in candidate_dirs {
        if dir.is_dir()
            && let Ok(Some(report)) = process_recovery_in_dir(&dir, data_dir, conn)
        {
            return Ok(Some(report));
        }
    }

    Ok(None)
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
        assert_eq!(parse_recovery_filename("pwreset.luna"), Some("".into()));
        assert_eq!(parse_recovery_filename("PWRESET.LUNA"), Some("".into()));
        assert_eq!(
            parse_recovery_filename("pwreset-1234-abcd.luna"),
            Some("1234-abcd".into())
        );
        assert_eq!(
            parse_recovery_filename("PWRESET-ABC123XYZ.LUNA"),
            Some("abc123xyz".into())
        );
        assert_eq!(parse_recovery_filename("other.luna"), None);
        assert_eq!(parse_recovery_filename("pwreset-1234.txt"), None);
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
    fn process_recovery_in_dir_applies_and_renames() {
        let (data_dir, conn) = test_db();
        fs::write(data_dir.path().join(DEVICE_TOKEN_FILE), "SEC-TOKEN-123\n").unwrap();

        let hash = hash_password_unchecked("oldpass").unwrap();
        db::insert_user(&conn, "1", "admin", "Admin", &hash, "admin").unwrap();

        let usb_dir = TempDir::new().unwrap();
        let recovery_file = usb_dir.path().join("pwreset-sec-token-123.luna");
        fs::write(
            &recovery_file,
            r#"{"user": "g-admin", "password": "recoveredpassword"}"#,
        )
        .unwrap();

        let res = process_recovery_in_dir(usb_dir.path(), data_dir.path(), &conn).unwrap();
        assert!(res.is_some());
        let report = res.unwrap();
        assert_eq!(report.updated, vec!["admin"]);

        // File must be renamed to .luna.done
        assert!(!recovery_file.exists());
        assert!(
            usb_dir
                .path()
                .join("pwreset-sec-token-123.luna.done")
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
}

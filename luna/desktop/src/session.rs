//! Persisted device-token session for Luna Desktop.

use std::fs;
use std::io::Write;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// The token is the only secret in the session. Where an OS keychain exists
/// (Secret Service / Keychain / Credential Manager) the token lives there and
/// `session.json` holds just the address and username. On headless machines
/// the keychain can be missing or refuse — then the token stays in
/// `session.json`, which is always written 0600.
const KEYRING_SERVICE: &str = "Luna Desktop";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionData {
    pub base_url: String,
    pub username: String,
    /// Empty in the file when the token lives in the OS keychain.
    #[serde(default)]
    pub token: String,
}

fn keyring_entry(base_url: &str, username: &str) -> Option<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, &format!("{username}@{base_url}")).ok()
}

pub fn data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("LUNA_DESKTOP_DATA") {
        return PathBuf::from(dir);
    }
    #[cfg(windows)]
    {
        if let Ok(dir) = std::env::var("LOCALAPPDATA") {
            return PathBuf::from(dir).join("Luna Desktop");
        }
        return PathBuf::from(".").join("Luna Desktop");
    }
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
        PathBuf::from(home).join("Library/Application Support/Luna Desktop")
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
        PathBuf::from(home).join(".local/share/luna-desktop")
    }
}

fn session_path() -> PathBuf {
    data_dir().join("session.json")
}

pub fn load() -> Option<SessionData> {
    let bytes = fs::read(session_path()).ok()?;
    let mut session: SessionData = serde_json::from_slice(&bytes).ok()?;
    if session.token.is_empty() {
        // The token lives in the keychain; the file holds no secret.
        let entry = keyring_entry(&session.base_url, &session.username)?;
        session.token = entry.get_password().ok()?;
        if session.token.is_empty() {
            return None;
        }
        return Some(session);
    }
    // Migrate: older versions kept the token in the file. Move it to the
    // keychain and rewrite the file without it; on failure the file copy
    // simply stays the store for this session.
    if let Some(entry) = keyring_entry(&session.base_url, &session.username)
        && entry.set_password(&session.token).is_ok()
    {
        let mut scrubbed = session.clone();
        scrubbed.token.clear();
        let _ = write_file(&scrubbed);
    }
    Some(session)
}

pub fn save(session: &SessionData) -> anyhow::Result<()> {
    let mut file_session = session.clone();
    if let Some(entry) = keyring_entry(&session.base_url, &session.username)
        && entry.set_password(&session.token).is_ok()
    {
        file_session.token.clear();
    }
    write_file(&file_session)
}

pub fn clear() {
    if let Ok(bytes) = fs::read(session_path())
        && let Ok(session) = serde_json::from_slice::<SessionData>(&bytes)
        && let Some(entry) = keyring_entry(&session.base_url, &session.username)
    {
        let _ = entry.delete_credential();
    }
    let _ = fs::remove_file(session_path());
}

fn write_file(session: &SessionData) -> anyhow::Result<()> {
    let dir = data_dir();
    fs::create_dir_all(&dir)?;
    let path = session_path();
    let tmp = dir.join("session.json.tmp");
    let json = serde_json::to_vec_pretty(session)?;
    {
        let mut opts = fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut file = opts.open(&tmp)?;
        // mode() above only applies at create time — a leftover tmp file
        // with looser permissions would keep them through the rename.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(fs::Permissions::from_mode(0o600))?;
        }
        file.write_all(&json)?;
        file.sync_all()?;
    }
    fs::rename(tmp, path)?;
    Ok(())
}

#[cfg(test)]
pub mod test_env {
    use std::sync::{Mutex, MutexGuard};

    static LOCK: Mutex<()> = Mutex::new(());

    /// Serialize tests that mutate `LUNA_DESKTOP_DATA` / related env.
    pub fn lock() -> MutexGuard<'static, ()> {
        LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_session() {
        let _g = test_env::lock();
        let dir = tempfile::tempdir().unwrap();
        unsafe { std::env::set_var("LUNA_DESKTOP_DATA", dir.path()) };
        let s = SessionData {
            base_url: "http://luna.local".into(),
            username: "max".into(),
            token: "tok".into(),
        };
        save(&s).unwrap();
        assert_eq!(load().unwrap(), s);
        clear();
        assert!(load().is_none());
        unsafe { std::env::remove_var("LUNA_DESKTOP_DATA") };
    }

    #[cfg(unix)]
    #[test]
    fn session_file_is_owner_only() {
        let _g = test_env::lock();
        let dir = tempfile::tempdir().unwrap();
        unsafe { std::env::set_var("LUNA_DESKTOP_DATA", dir.path()) };
        // A pre-existing loose tmp file must not leak through the rename.
        let tmp = dir.path().join("session.json.tmp");
        std::fs::write(&tmp, b"stale").unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&tmp, fs::Permissions::from_mode(0o644)).unwrap();
        }
        save(&SessionData {
            base_url: "http://luna.local".into(),
            username: "max".into(),
            token: "tok".into(),
        })
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(dir.path().join("session.json"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600, "session.json must be 0600");
        unsafe { std::env::remove_var("LUNA_DESKTOP_DATA") };
    }
}

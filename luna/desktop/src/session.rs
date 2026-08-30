//! Persisted device-token session for Luna Desktop.

use std::fs;
use std::io::Write;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionData {
    pub base_url: String,
    pub username: String,
    pub token: String,
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
    #[cfg(not(windows))]
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
    serde_json::from_slice(&bytes).ok()
}

pub fn save(session: &SessionData) -> anyhow::Result<()> {
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
        file.write_all(&json)?;
        file.sync_all()?;
    }
    fs::rename(tmp, path)?;
    Ok(())
}

pub fn clear() {
    let _ = fs::remove_file(session_path());
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
}

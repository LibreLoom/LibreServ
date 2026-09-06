//! Luna for Linux core: session, Luna HTTP client, backup, sync, destination rules.

/// User-visible product name (platform-specific).
pub fn product_name() -> &'static str {
    #[cfg(windows)]
    {
        "Luna Desktop"
    }
    #[cfg(not(windows))]
    {
        "Luna for Linux"
    }
}

pub mod autostart;
pub mod backup;
pub mod dest;
pub mod luna;
pub mod session;
pub mod sync;
pub mod tray;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use dest::{ExistingJobs, LunaRef};
use serde::Serialize;

pub struct AppState {
    pub session: Mutex<Option<session::SessionData>>,
    pub backup_handles: Mutex<HashMap<String, backup::BackupHandle>>,
    pub backup_progress: Arc<Mutex<HashMap<String, backup::BackupProgress>>>,
    pub sync_handles: Mutex<HashMap<String, sync::SyncHandle>>,
    pub sync_progress: Arc<Mutex<HashMap<String, sync::SyncProgress>>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            session: Mutex::new(None),
            backup_handles: Mutex::new(HashMap::new()),
            backup_progress: Arc::new(Mutex::new(HashMap::new())),
            sync_handles: Mutex::new(HashMap::new()),
            sync_progress: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

fn require_session(state: &AppState) -> Result<session::SessionData, String> {
    state
        .session
        .lock()
        .map_err(|_| "Internal error.".to_string())?
        .clone()
        .ok_or_else(|| "Sign in first.".to_string())
}

fn existing_jobs(skip_backup_id: Option<&str>, skip_sync_id: Option<&str>) -> ExistingJobs {
    let mut ex = ExistingJobs::default();
    for j in backup::load_jobs() {
        if skip_backup_id == Some(j.id.as_str()) {
            continue;
        }
        for s in &j.sources {
            ex.backup_sources.push(PathBuf::from(s));
        }
        ex.backup_dests
            .push(LunaRef::normalized(&j.drive_id, &j.remote_path));
    }
    for p in sync::load_pairs() {
        if skip_sync_id == Some(p.id.as_str()) {
            continue;
        }
        ex.sync_locals.push(PathBuf::from(&p.local_path));
        ex.sync_remotes
            .push(LunaRef::normalized(&p.drive_id, &p.remote_path));
    }
    ex
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SessionInfo {
    pub base_url: String,
    pub username: String,
}

/// Result of trying to restore a saved sign-in at startup.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RestoreOutcome {
    Restored(SessionInfo),
    NoSession,
    /// Saved token no longer works; session cleared, Luna address kept for reconfigure.
    AuthFailed {
        base_url: String,
    },
    Failed(String),
}

pub fn restore_session(state: &AppState) -> RestoreOutcome {
    let Some(saved) = session::load() else {
        return RestoreOutcome::NoSession;
    };
    match luna::auth_me(&saved.base_url, &saved.token) {
        Ok((username, _)) => {
            let mut session_data = saved.clone();
            session_data.username = username.clone();
            if let Ok(mut slot) = state.session.lock() {
                *slot = Some(session_data);
            }
            RestoreOutcome::Restored(SessionInfo {
                base_url: saved.base_url,
                username,
            })
        }
        Err(e) if luna::is_auth_failure(&e) => {
            let base_url = saved.base_url;
            session::clear();
            if let Ok(mut slot) = state.session.lock() {
                *slot = None;
            }
            RestoreOutcome::AuthFailed { base_url }
        }
        Err(_) => {
            // Non-auth failure (e.g. offline, connection error, drive issue):
            // preserve the saved session so the user is NOT kicked back to the login page.
            if let Ok(mut slot) = state.session.lock() {
                *slot = Some(saved.clone());
            }
            RestoreOutcome::Restored(SessionInfo {
                base_url: saved.base_url,
                username: saved.username,
            })
        }
    }
}

pub fn login(state: &AppState, base_url: &str, access_token: &str) -> Result<SessionInfo, String> {
    let base_url = base_url.trim().trim_end_matches('/').to_string();
    if base_url.is_empty() {
        return Err("Enter your Luna address (for example http://luna.local).".into());
    }
    let token = access_token.trim().to_string();
    if token.is_empty() {
        return Err("Paste an access token from Luna → Settings → Security.".into());
    }
    let (username, _) = luna::auth_me(&base_url, &token)?;
    let data = session::SessionData {
        base_url: base_url.clone(),
        username: username.clone(),
        token,
    };
    session::save(&data).map_err(|_| "Couldn't save your sign-in on this computer.".to_string())?;
    *state
        .session
        .lock()
        .map_err(|_| "Internal error.".to_string())? = Some(data.clone());
    Ok(SessionInfo {
        base_url: data.base_url,
        username: data.username,
    })
}

pub fn logout(state: &AppState) -> Result<(), String> {
    if let Ok(mut handles) = state.backup_handles.lock() {
        for (_, h) in handles.drain() {
            h.stop();
        }
    }
    if let Ok(mut handles) = state.sync_handles.lock() {
        for (_, h) in handles.drain() {
            h.stop();
        }
    }
    if let Ok(mut s) = state.session.lock() {
        *s = None;
    }
    session::clear();
    Ok(())
}

pub fn list_drives(state: &AppState) -> Result<Vec<luna::Drive>, String> {
    let s = require_session(state)?;
    luna::list_drives(&s.base_url, &s.token)
}

pub fn list_files(
    state: &AppState,
    drive_id: &str,
    path: &str,
) -> Result<Vec<luna::FileEntry>, String> {
    let s = require_session(state)?;
    luna::list_files(&s.base_url, &s.token, drive_id, path)
}

pub fn mkdir(state: &AppState, drive_id: &str, path: &str) -> Result<(), String> {
    let s = require_session(state)?;
    luna::mkdir(&s.base_url, &s.token, drive_id, path)
}

pub fn save_backup_job(
    state: &AppState,
    job: backup::BackupJob,
) -> Result<backup::BackupJob, String> {
    let _ = require_session(state)?;
    let sources = dest::validate_local_dirs(&job.sources)?;
    let dest_ref = dest::validate_luna_folder(&job.drive_id, &job.remote_path)?;
    let existing = existing_jobs(Some(&job.id), None);
    dest::check_backup_against(&sources, &dest_ref, &existing, None)?;

    let mut jobs = backup::load_jobs();
    if let Some(idx) = jobs.iter().position(|j| j.id == job.id) {
        let running = jobs[idx].running;
        jobs[idx] = backup::BackupJob {
            running,
            ..job.clone()
        };
    } else {
        let mut j = job.clone();
        if j.id.is_empty() {
            j.id = unique_id();
        }
        if j.name.trim().is_empty() {
            j.name = if dest_ref.path.is_empty() {
                "Backup".into()
            } else {
                dest_ref
                    .path
                    .rsplit('/')
                    .next()
                    .unwrap_or("Backup")
                    .to_string()
            };
        }
        j.running = false;
        jobs.push(j.clone());
        backup::save_jobs(&jobs)?;
        return Ok(j);
    }
    backup::save_jobs(&jobs)?;
    Ok(jobs.into_iter().find(|j| j.id == job.id).unwrap())
}

pub fn delete_backup_job(state: &AppState, id: &str) -> Result<(), String> {
    if let Ok(mut handles) = state.backup_handles.lock()
        && let Some(h) = handles.remove(id)
    {
        h.stop();
    }
    let mut jobs = backup::load_jobs();
    jobs.retain(|j| j.id != id);
    backup::save_jobs(&jobs)
}

pub fn start_backup_job(state: &AppState, id: &str) -> Result<(), String> {
    let s = require_session(state)?;
    let mut jobs = backup::load_jobs();
    let job = jobs
        .iter_mut()
        .find(|j| j.id == id)
        .ok_or_else(|| "That backup was not found.".to_string())?;
    if state
        .backup_handles
        .lock()
        .map_err(|_| "Internal error.".to_string())?
        .contains_key(id)
    {
        return Ok(());
    }
    let handle = backup::start_job(
        s.base_url.clone(),
        s.token.clone(),
        job.clone(),
        state.backup_progress.clone(),
    )?;
    job.running = true;
    backup::save_jobs(&jobs)?;
    state
        .backup_handles
        .lock()
        .map_err(|_| "Internal error.".to_string())?
        .insert(id.to_string(), handle);
    Ok(())
}

pub fn stop_backup_job(state: &AppState, id: &str) -> Result<(), String> {
    if let Ok(mut handles) = state.backup_handles.lock()
        && let Some(h) = handles.remove(id)
    {
        h.stop();
    }
    let mut jobs = backup::load_jobs();
    if let Some(job) = jobs.iter_mut().find(|j| j.id == id) {
        job.running = false;
    }
    backup::save_jobs(&jobs)
}

pub fn save_sync_pair(state: &AppState, pair: sync::SyncPair) -> Result<sync::SyncPair, String> {
    let s = require_session(state)?;
    let remote = dest::validate_luna_folder(&pair.drive_id, &pair.remote_path)?;
    let mut pairs = sync::load_pairs();
    let basename = sync_pair_local_basename(&s, &remote, &pair, &pairs)?;
    let parent = PathBuf::from(&pair.local_parent);
    let local = dest::resolved_sync_local(&parent, &basename)?;
    let existing = existing_jobs(None, Some(&pair.id));
    dest::check_sync_against(&local, &remote, &existing, None)?;

    let mut saved = sync::SyncPair {
        id: if pair.id.is_empty() {
            unique_id()
        } else {
            pair.id.clone()
        },
        drive_id: remote.drive_id,
        remote_path: remote.path,
        local_parent: pair.local_parent,
        local_path: local.to_string_lossy().into_owned(),
        running: false,
    };
    if let Some(idx) = pairs.iter().position(|p| p.id == saved.id) {
        saved.running = pairs[idx].running;
        pairs[idx] = saved.clone();
    } else {
        pairs.push(saved.clone());
    }
    sync::save_pairs(&pairs)?;
    Ok(saved)
}

/// Local folder name under the chosen parent. Whole-drive syncs use the drive label.
/// When editing the same whole-drive sync in place, keep the existing local folder name
/// so a drive rename does not orphan files already synced.
fn sync_pair_local_basename(
    session: &session::SessionData,
    remote: &LunaRef,
    pair: &sync::SyncPair,
    pairs: &[sync::SyncPair],
) -> Result<String, String> {
    if !remote.path.is_empty() {
        return Ok(dest::sync_local_basename(&remote.path, ""));
    }
    if let Some(existing) = pairs.iter().find(|p| p.id == pair.id)
        && existing.drive_id == remote.drive_id
        && existing.remote_path.is_empty()
        && existing.local_parent == pair.local_parent
        && let Some(name) = Path::new(&existing.local_path).file_name()
    {
        let name = name.to_string_lossy();
        if !name.is_empty() {
            return Ok(name.into_owned());
        }
    }
    let drives = luna::list_drives(&session.base_url, &session.token)?;
    let label = drives
        .iter()
        .find(|d| d.id == remote.drive_id)
        .map(|d| d.label.as_str())
        .unwrap_or("Luna Drive");
    Ok(dest::sync_local_basename("", label))
}

pub fn delete_sync_pair(state: &AppState, id: &str) -> Result<(), String> {
    if let Ok(mut handles) = state.sync_handles.lock()
        && let Some(h) = handles.remove(id)
    {
        h.stop();
    }
    let mut pairs = sync::load_pairs();
    pairs.retain(|p| p.id != id);
    sync::save_pairs(&pairs)
}

pub fn start_sync_pair(state: &AppState, id: &str) -> Result<(), String> {
    let s = require_session(state)?;
    let mut pairs = sync::load_pairs();
    let pair = pairs
        .iter_mut()
        .find(|p| p.id == id)
        .ok_or_else(|| "That sync was not found.".to_string())?;
    if state
        .sync_handles
        .lock()
        .map_err(|_| "Internal error.".to_string())?
        .contains_key(id)
    {
        return Ok(());
    }
    let handle = sync::start_pair(
        s.base_url.clone(),
        s.token.clone(),
        pair.clone(),
        state.sync_progress.clone(),
    )?;
    pair.running = true;
    sync::save_pairs(&pairs)?;
    state
        .sync_handles
        .lock()
        .map_err(|_| "Internal error.".to_string())?
        .insert(id.to_string(), handle);
    Ok(())
}

pub fn stop_sync_pair(state: &AppState, id: &str) -> Result<(), String> {
    if let Ok(mut handles) = state.sync_handles.lock()
        && let Some(h) = handles.remove(id)
    {
        h.stop();
    }
    let mut pairs = sync::load_pairs();
    if let Some(p) = pairs.iter_mut().find(|p| p.id == id) {
        p.running = false;
    }
    sync::save_pairs(&pairs)
}

/// Start every configured backup and sync. Already-running jobs are skipped.
/// Call after sign-in / session restore so configured jobs stay active.
pub fn start_all_jobs(state: &AppState) {
    for job in backup::load_jobs() {
        let _ = start_backup_job(state, &job.id);
    }
    for pair in sync::load_pairs() {
        let _ = start_sync_pair(state, &pair.id);
    }
}

pub fn unique_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let t = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("{t:x}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::thread;

    use session::test_env;

    fn spawn_drives_server(status: u16) -> (String, thread::JoinHandle<()>, Arc<AtomicBool>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let stop = Arc::new(AtomicBool::new(false));
        let stop2 = stop.clone();
        let handle = thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                if stop2.load(Ordering::Relaxed) {
                    break;
                }
                let mut buf = [0u8; 4096];
                let mut s = stream;
                let n = s.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]);
                let (code, body) = if req.contains("/api/v1/auth/me") {
                    (
                        status,
                        if status == 200 {
                            r#"{"id":"u1","username":"max","role":"admin"}"#.to_string()
                        } else {
                            "null".to_string()
                        },
                    )
                } else if req.contains("/api/v1/drives") {
                    (status, "[]".to_string())
                } else {
                    (404, "{}".to_string())
                };
                let resp = format!(
                    "HTTP/1.1 {code} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = s.write_all(resp.as_bytes());
            }
        });
        (format!("http://127.0.0.1:{port}"), handle, stop)
    }

    #[test]
    fn restore_session_auth_failed_clears_token_keeps_url() {
        let _g = test_env::lock();
        let dir = tempfile::tempdir().unwrap();
        unsafe { std::env::set_var("LUNA_DESKTOP_DATA", dir.path()) };

        let (base, handle, stop) = spawn_drives_server(401);
        session::save(&session::SessionData {
            base_url: base.clone(),
            username: "max".into(),
            token: "bad-token".into(),
        })
        .unwrap();

        let state = AppState::default();
        let outcome = restore_session(&state);
        assert_eq!(
            outcome,
            RestoreOutcome::AuthFailed {
                base_url: base.clone()
            }
        );
        assert!(session::load().is_none());
        assert!(state.session.lock().unwrap().is_none());

        stop.store(true, Ordering::Relaxed);
        drop(handle);
        unsafe { std::env::remove_var("LUNA_DESKTOP_DATA") };
    }

    #[test]
    fn restore_session_success_when_token_valid() {
        let _g = test_env::lock();
        let dir = tempfile::tempdir().unwrap();
        unsafe { std::env::set_var("LUNA_DESKTOP_DATA", dir.path()) };

        let (base, handle, stop) = spawn_drives_server(200);
        session::save(&session::SessionData {
            base_url: base.clone(),
            username: "max".into(),
            token: "good-token".into(),
        })
        .unwrap();

        let state = AppState::default();
        let outcome = restore_session(&state);
        assert_eq!(
            outcome,
            RestoreOutcome::Restored(SessionInfo {
                base_url: base.clone(),
                username: "max".into(),
            })
        );
        assert!(session::load().is_some());

        stop.store(true, Ordering::Relaxed);
        drop(handle);
        unsafe { std::env::remove_var("LUNA_DESKTOP_DATA") };
    }

    #[test]
    fn restore_session_does_not_kick_to_login_on_non_auth_failure() {
        let _g = test_env::lock();
        let dir = tempfile::tempdir().unwrap();
        unsafe { std::env::set_var("LUNA_DESKTOP_DATA", dir.path()) };

        // Mock server returns 500 (internal error, e.g. drive or database failure, NOT 401)
        let (base, handle, stop) = spawn_drives_server(500);
        session::save(&session::SessionData {
            base_url: base.clone(),
            username: "max".into(),
            token: "saved-token".into(),
        })
        .unwrap();

        let state = AppState::default();
        let outcome = restore_session(&state);
        // Must restore session, not kick to login or auth_failed!
        assert_eq!(
            outcome,
            RestoreOutcome::Restored(SessionInfo {
                base_url: base.clone(),
                username: "max".into(),
            })
        );
        assert!(session::load().is_some());

        stop.store(true, Ordering::Relaxed);
        drop(handle);
        unsafe { std::env::remove_var("LUNA_DESKTOP_DATA") };
    }
}

//! Luna Desktop core: session, Luna HTTP client, backup, sync, destination rules.

pub mod autostart;
pub mod backup;
pub mod dest;
pub mod luna;
pub mod session;
pub mod sync;

use std::collections::HashMap;
use std::path::PathBuf;
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

#[derive(Clone, Serialize)]
pub struct SessionInfo {
    pub base_url: String,
    pub username: String,
}

pub fn restore_session(state: &AppState) -> Result<Option<SessionInfo>, String> {
    let Some(saved) = session::load() else {
        return Ok(None);
    };
    match luna::list_drives(&saved.base_url, &saved.token) {
        Ok(_) => {
            *state
                .session
                .lock()
                .map_err(|_| "Internal error.".to_string())? = Some(saved.clone());
            Ok(Some(SessionInfo {
                base_url: saved.base_url,
                username: saved.username,
            }))
        }
        Err(e) if e == "unauthorized" => {
            session::clear();
            Ok(None)
        }
        Err(e) => Err(e),
    }
}

pub fn login(
    state: &AppState,
    base_url: &str,
    access_token: &str,
) -> Result<SessionInfo, String> {
    let base_url = base_url.trim().trim_end_matches('/').to_string();
    if base_url.is_empty() {
        return Err("Enter your Luna address (for example http://luna.local).".into());
    }
    let token = access_token.trim().to_string();
    if token.is_empty() {
        return Err(
            "Paste an access token from Luna → Settings → Apps and access tokens.".into(),
        );
    }
    let (username, _) = luna::auth_me(&base_url, &token)?;
    // Confirm the token can see drives (same check restore_session uses).
    luna::list_drives(&base_url, &token)?;
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
    let _ = require_session(state)?;
    let remote = dest::validate_luna_folder(&pair.drive_id, &pair.remote_path)?;
    let basename = if remote.path.is_empty() {
        return Err("Choose a folder on Luna to sync — not the whole drive.".into());
    } else {
        dest::luna_folder_basename(&remote.path)
    };
    let parent = PathBuf::from(&pair.local_parent);
    let local = dest::resolved_sync_local(&parent, &basename)?;
    let existing = existing_jobs(None, Some(&pair.id));
    dest::check_sync_against(&local, &remote, &existing, None)?;

    let mut pairs = sync::load_pairs();
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

pub fn unique_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let t = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("{t:x}")
}

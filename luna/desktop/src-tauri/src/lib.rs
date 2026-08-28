mod backup;
mod dest;
mod luna;
mod session;
mod sync;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::State;

use dest::{ExistingJobs, LunaRef};

pub struct AppState {
    session: Mutex<Option<session::SessionData>>,
    backup_handles: Mutex<HashMap<String, backup::BackupHandle>>,
    backup_progress: Arc<Mutex<HashMap<String, backup::BackupProgress>>>,
    sync_handles: Mutex<HashMap<String, sync::SyncHandle>>,
    sync_progress: Arc<Mutex<HashMap<String, sync::SyncProgress>>>,
}

fn require_session(state: &AppState) -> Result<session::SessionData, String> {
    state
        .session
        .lock()
        .unwrap()
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

#[derive(Serialize)]
struct SessionInfo {
    base_url: String,
    username: String,
}

#[tauri::command]
fn restore_session(state: State<AppState>) -> Result<Option<SessionInfo>, String> {
    let Some(saved) = session::load() else {
        return Ok(None);
    };
    match luna::list_drives(&saved.base_url, &saved.token) {
        Ok(_) => {
            *state.session.lock().unwrap() = Some(saved.clone());
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

#[tauri::command]
fn login(
    base_url: String,
    username: String,
    password: String,
    state: State<AppState>,
) -> Result<SessionInfo, String> {
    let base_url = base_url.trim().trim_end_matches('/').to_string();
    if base_url.is_empty() {
        return Err("Enter your Luna address (for example http://luna.local).".into());
    }
    if username.trim().is_empty() || password.is_empty() {
        return Err("Enter your username and password.".into());
    }
    let token = luna::login(&base_url, username.trim(), &password)?;
    let data = session::SessionData {
        base_url: base_url.clone(),
        username: username.trim().to_string(),
        token,
    };
    session::save(&data).map_err(|_| "Couldn't save your sign-in on this computer.".to_string())?;
    *state.session.lock().unwrap() = Some(data.clone());
    Ok(SessionInfo {
        base_url: data.base_url,
        username: data.username,
    })
}

#[tauri::command]
fn logout(state: State<AppState>) -> Result<(), String> {
    for (_, h) in state.backup_handles.lock().unwrap().drain() {
        h.stop();
    }
    for (_, h) in state.sync_handles.lock().unwrap().drain() {
        h.stop();
    }
    *state.session.lock().unwrap() = None;
    session::clear();
    Ok(())
}

#[tauri::command]
fn list_drives(state: State<AppState>) -> Result<Vec<luna::Drive>, String> {
    let s = require_session(&state)?;
    luna::list_drives(&s.base_url, &s.token)
}

#[tauri::command]
fn list_files(drive_id: String, path: String, state: State<AppState>) -> Result<Vec<luna::FileEntry>, String> {
    let s = require_session(&state)?;
    luna::list_files(&s.base_url, &s.token, &drive_id, &path)
}

#[tauri::command]
fn mkdir(drive_id: String, path: String, state: State<AppState>) -> Result<(), String> {
    let s = require_session(&state)?;
    luna::mkdir(&s.base_url, &s.token, &drive_id, &path)
}

#[tauri::command]
fn pick_folder(app: tauri::AppHandle, title: Option<String>) -> Result<String, String> {
    use tauri_plugin_dialog::DialogExt;
    app.dialog()
        .file()
        .set_title(title.unwrap_or_else(|| "Choose a folder".into()))
        .blocking_pick_folder()
        .map(|path| path.to_string())
        .ok_or_else(|| "No folder chosen.".into())
}

#[tauri::command]
fn list_backup_jobs() -> Vec<backup::BackupJob> {
    backup::load_jobs()
}

#[tauri::command]
fn save_backup_job(job: backup::BackupJob, state: State<AppState>) -> Result<backup::BackupJob, String> {
    let _ = require_session(&state)?;
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

#[tauri::command]
fn delete_backup_job(id: String, state: State<AppState>) -> Result<(), String> {
    if let Some(h) = state.backup_handles.lock().unwrap().remove(&id) {
        h.stop();
    }
    let mut jobs = backup::load_jobs();
    jobs.retain(|j| j.id != id);
    backup::save_jobs(&jobs)
}

#[tauri::command]
fn start_backup_job(id: String, state: State<AppState>) -> Result<(), String> {
    let s = require_session(&state)?;
    let mut jobs = backup::load_jobs();
    let job = jobs
        .iter_mut()
        .find(|j| j.id == id)
        .ok_or_else(|| "That backup was not found.".to_string())?;
    if state.backup_handles.lock().unwrap().contains_key(&id) {
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
    state.backup_handles.lock().unwrap().insert(id, handle);
    Ok(())
}

#[tauri::command]
fn stop_backup_job(id: String, state: State<AppState>) -> Result<(), String> {
    if let Some(h) = state.backup_handles.lock().unwrap().remove(&id) {
        h.stop();
    }
    let mut jobs = backup::load_jobs();
    if let Some(job) = jobs.iter_mut().find(|j| j.id == id) {
        job.running = false;
    }
    backup::save_jobs(&jobs)
}

#[tauri::command]
fn backup_progress(state: State<AppState>) -> HashMap<String, backup::BackupProgress> {
    state.backup_progress.lock().unwrap().clone()
}

#[tauri::command]
fn list_sync_pairs() -> Vec<sync::SyncPair> {
    sync::load_pairs()
}

#[tauri::command]
fn save_sync_pair(pair: sync::SyncPair, state: State<AppState>) -> Result<sync::SyncPair, String> {
    let _ = require_session(&state)?;
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

#[tauri::command]
fn delete_sync_pair(id: String, state: State<AppState>) -> Result<(), String> {
    if let Some(h) = state.sync_handles.lock().unwrap().remove(&id) {
        h.stop();
    }
    let mut pairs = sync::load_pairs();
    pairs.retain(|p| p.id != id);
    sync::save_pairs(&pairs)
}

#[tauri::command]
fn start_sync_pair(id: String, state: State<AppState>) -> Result<(), String> {
    let s = require_session(&state)?;
    let mut pairs = sync::load_pairs();
    let pair = pairs
        .iter_mut()
        .find(|p| p.id == id)
        .ok_or_else(|| "That sync was not found.".to_string())?;
    if state.sync_handles.lock().unwrap().contains_key(&id) {
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
    state.sync_handles.lock().unwrap().insert(id, handle);
    Ok(())
}

#[tauri::command]
fn stop_sync_pair(id: String, state: State<AppState>) -> Result<(), String> {
    if let Some(h) = state.sync_handles.lock().unwrap().remove(&id) {
        h.stop();
    }
    let mut pairs = sync::load_pairs();
    if let Some(p) = pairs.iter_mut().find(|p| p.id == id) {
        p.running = false;
    }
    sync::save_pairs(&pairs)
}

#[tauri::command]
fn sync_progress(state: State<AppState>) -> HashMap<String, sync::SyncProgress> {
    state.sync_progress.lock().unwrap().clone()
}

fn unique_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let t = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("{t:x}")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            session: Mutex::new(None),
            backup_handles: Mutex::new(HashMap::new()),
            backup_progress: Arc::new(Mutex::new(HashMap::new())),
            sync_handles: Mutex::new(HashMap::new()),
            sync_progress: Arc::new(Mutex::new(HashMap::new())),
        })
        .setup(|app| {
            use tauri::Manager;
            use tauri::menu::{Menu, MenuItem};
            use tauri::tray::TrayIconBuilder;

            let show = MenuItem::with_id(app, "show", "Show Luna", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Luna", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;

            let icon = match app.default_window_icon() {
                Some(icon) => icon.clone(),
                None => tauri::image::Image::from_bytes(include_bytes!("../icons/icon.png"))?,
            };
            TrayIconBuilder::new()
                .icon(icon)
                .tooltip("Luna Desktop")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            restore_session,
            login,
            logout,
            list_drives,
            list_files,
            mkdir,
            pick_folder,
            list_backup_jobs,
            save_backup_job,
            delete_backup_job,
            start_backup_job,
            stop_backup_job,
            backup_progress,
            list_sync_pairs,
            save_sync_pair,
            delete_sync_pair,
            start_sync_pair,
            stop_sync_pair,
            sync_progress,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Luna Desktop");
}

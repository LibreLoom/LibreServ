mod backup;
mod luna;

use std::sync::Mutex;
use tauri::State;

pub struct Session {
    token: Mutex<Option<String>>,
    backup: Mutex<Option<backup::BackupHandle>>,
}

#[tauri::command]
fn login(base_url: String, username: String, password: String, state: State<Session>) -> Result<String, String> {
    let token = luna::login(&base_url, &username, &password).map_err(|e| e.to_string())?;
    *state.token.lock().unwrap() = Some(token);
    Ok("Signed in.".into())
}

#[tauri::command]
fn list_drives(base_url: String, state: State<Session>) -> Result<Vec<luna::Drive>, String> {
    let token = state.token.lock().unwrap().clone().ok_or("Sign in first.")?;
    luna::list_drives(&base_url, &token).map_err(|e| e.to_string())
}

#[tauri::command]
fn pick_folder() -> Result<String, String> {
    // The dialog plugin is available through the frontend plugin API; this
    // command is the backend fallback used by older frontends.
    Err("Use the Choose folder button in the window.".into())
}

#[tauri::command]
fn start_backup(
    base_url: String,
    folder: String,
    drive_id: String,
    remote_path: String,
    state: State<Session>,
) -> Result<String, String> {
    let token = state.token.lock().unwrap().clone().ok_or("Sign in first.")?;
    if folder.is_empty() || !std::path::Path::new(&folder).is_dir() {
        return Err("Choose a folder that exists.".into());
    }
    let handle = backup::start(base_url, token, folder, drive_id, remote_path).map_err(|e| e.to_string())?;
    *state.backup.lock().unwrap() = Some(handle);
    Ok("Backup started. Luna Desktop keeps watching this folder.".into())
}

#[tauri::command]
fn stop_backup(state: State<Session>) -> Result<String, String> {
    let handle = state.backup.lock().unwrap().take();
    if let Some(handle) = handle {
        handle.stop();
        Ok("Backup stopped.".into())
    } else {
        Ok("No backup was running.".into())
    }
}

#[tauri::command]
fn mount_drive(base_url: String, drive_id: String, state: State<Session>) -> Result<String, String> {
    let token = state.token.lock().unwrap().clone().ok_or("Sign in first.")?;
    luna::mount_instructions(&base_url, &token, &drive_id)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Session { token: Mutex::new(None), backup: Mutex::new(None) })
        .invoke_handler(tauri::generate_handler![
            login,
            list_drives,
            pick_folder,
            start_backup,
            stop_backup,
            mount_drive
        ])
        .run(tauri::generate_context!())
        .expect("error while running Luna Desktop");
}

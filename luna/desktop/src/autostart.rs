//! Start Luna Desktop when you sign in to this computer (XDG autostart).

use std::fs;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::PathBuf;

const DESKTOP_ID: &str = "org.libreloom.LunaDesktop.desktop";

fn autostart_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("XDG_CONFIG_HOME") {
        return PathBuf::from(dir).join("autostart");
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".config/autostart")
}

fn desktop_path() -> PathBuf {
    autostart_dir().join(DESKTOP_ID)
}

fn exec_path() -> String {
    if let Ok(p) = std::env::current_exe() {
        return p.to_string_lossy().into_owned();
    }
    "luna-desktop".into()
}

pub fn is_enabled() -> bool {
    desktop_path().is_file()
}

pub fn set_enabled(enabled: bool) -> Result<(), String> {
    let path = desktop_path();
    if !enabled {
        let _ = fs::remove_file(&path);
        return Ok(());
    }
    let dir = autostart_dir();
    fs::create_dir_all(&dir).map_err(|_| {
        "Couldn't create the start-on-boot folder on this computer.".to_string()
    })?;
    let exec = exec_path();
    let body = format!(
        "[Desktop Entry]\n\
         Type=Application\n\
         Name=Luna Desktop\n\
         Comment=Back up and sync folders with Luna\n\
         Exec={exec} --background\n\
         Icon=org.libreloom.LunaDesktop\n\
         Terminal=false\n\
         Categories=Utility;FileTools;\n\
         X-GNOME-Autostart-enabled=true\n\
         X-GNOME-UsesNotifications=true\n"
    );
    let tmp = dir.join(format!("{DESKTOP_ID}.tmp"));
    {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o644)
            .open(&tmp)
            .map_err(|_| "Couldn't write the start-on-boot setting.".to_string())?;
        file.write_all(body.as_bytes())
            .map_err(|_| "Couldn't write the start-on-boot setting.".to_string())?;
    }
    fs::rename(tmp, path).map_err(|_| "Couldn't save the start-on-boot setting.".to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn toggle_autostart_file() {
        let _g = crate::session::test_env::lock();
        let dir = tempfile::tempdir().unwrap();
        unsafe {
            std::env::set_var("XDG_CONFIG_HOME", dir.path());
        }
        assert!(!is_enabled());
        set_enabled(true).unwrap();
        assert!(is_enabled());
        let text = fs::read_to_string(desktop_path()).unwrap();
        assert!(text.contains("Name=Luna Desktop"));
        assert!(text.contains("--background"));
        assert!(text.contains("X-GNOME-UsesNotifications=true"));
        set_enabled(false).unwrap();
        assert!(!is_enabled());
        unsafe {
            std::env::remove_var("XDG_CONFIG_HOME");
        }
    }
}

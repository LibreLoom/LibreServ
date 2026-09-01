//! Start Luna for Linux when you sign in (XDG autostart on Linux, HKCU Run on Windows).

fn exec_path() -> String {
    if let Ok(p) = std::env::current_exe() {
        return p.to_string_lossy().into_owned();
    }
    "luna-desktop".into()
}

#[cfg(unix)]
mod unix_impl {
    use super::exec_path;
    use std::fs;
    use std::io::Write;
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
             Name=Luna for Linux\n\
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
            let mut opts = fs::OpenOptions::new();
            opts.write(true).create(true).truncate(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                opts.mode(0o644);
            }
            let mut file = opts
                .open(&tmp)
                .map_err(|_| "Couldn't write the start-on-boot setting.".to_string())?;
            file.write_all(body.as_bytes())
                .map_err(|_| "Couldn't write the start-on-boot setting.".to_string())?;
        }
        fs::rename(tmp, path)
            .map_err(|_| "Couldn't save the start-on-boot setting.".to_string())?;
        Ok(())
    }
}

#[cfg(windows)]
mod windows_impl {
    use super::exec_path;
    use winreg::RegKey;
    use winreg::enums::*;

    const VALUE_NAME: &str = "Luna Desktop";

    fn run_key() -> Result<RegKey, String> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        hkcu.open_subkey_with_flags(
            r"Software\Microsoft\Windows\CurrentVersion\Run",
            KEY_READ | KEY_SET_VALUE,
        )
        .map_err(|_| "Couldn't open the Windows start-on-sign-in settings.".to_string())
    }

    pub fn is_enabled() -> bool {
        let Ok(key) = run_key() else {
            return false;
        };
        key.get_value::<String, _>(VALUE_NAME).is_ok()
    }

    pub fn set_enabled(enabled: bool) -> Result<(), String> {
        let key = run_key()?;
        if !enabled {
            let _ = key.delete_value(VALUE_NAME);
            return Ok(());
        }
        let exec = exec_path();
        let command = format!("\"{exec}\" --background");
        key.set_value(VALUE_NAME, &command)
            .map_err(|_| "Couldn't save the start-on-sign-in setting.".to_string())?;
        Ok(())
    }
}

#[cfg(unix)]
pub use unix_impl::{is_enabled, set_enabled};

#[cfg(windows)]
pub use windows_impl::{is_enabled, set_enabled};

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

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
        let text = fs::read_to_string(
            PathBuf::from(dir.path()).join("autostart/org.libreloom.LunaDesktop.desktop"),
        )
        .unwrap();
        assert!(text.contains("Name=Luna for Linux"));
        assert!(text.contains("--background"));
        assert!(text.contains("X-GNOME-UsesNotifications=true"));
        set_enabled(false).unwrap();
        assert!(!is_enabled());
        unsafe {
            std::env::remove_var("XDG_CONFIG_HOME");
        }
    }
}

//! Start Luna Desktop when you sign in (XDG autostart on Linux, a LaunchAgent
//! plist on macOS, HKCU Run on Windows).

use std::path::PathBuf;

fn exec_path() -> String {
    if let Ok(appimage) = std::env::var("APPIMAGE") {
        let appimage = appimage.trim();
        if !appimage.is_empty() {
            if appimage.contains(' ') && !appimage.starts_with('"') {
                return format!("\"{appimage}\"");
            }
            return appimage.to_string();
        }
    }
    if std::path::Path::new("/.flatpak-info").exists() {
        return "flatpak run org.libreloom.LunaDesktop".into();
    }
    if let Ok(p) = std::env::current_exe() {
        let s = p.to_string_lossy().into_owned();
        if s.contains(' ') && !s.starts_with('"') {
            return format!("\"{s}\"");
        }
        return s;
    }
    "luna-desktop".into()
}

fn disabled_marker_path() -> PathBuf {
    crate::session::data_dir().join("autostart-disabled")
}

/// Returns true if the user explicitly turned off start on boot
/// (either via Luna Settings or via desktop environment settings).
pub fn is_explicitly_disabled() -> bool {
    if disabled_marker_path().is_file() {
        return true;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let path = unix_impl::desktop_path();
        if path.is_file() {
            if let Ok(content) = std::fs::read_to_string(&path) {
                for line in content.lines() {
                    let line = line.trim();
                    if line.eq_ignore_ascii_case("X-GNOME-Autostart-enabled=false")
                        || line.eq_ignore_ascii_case("Hidden=true")
                    {
                        return true;
                    }
                }
            }
        }
    }
    #[cfg(target_os = "macos")]
    if macos_impl::is_launchctl_disabled() {
        return true;
    }
    false
}

#[cfg(all(unix, not(target_os = "macos")))]
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

    pub fn desktop_path() -> PathBuf {
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

#[cfg(target_os = "macos")]
mod macos_impl {
    use super::exec_path;
    use std::fs;
    use std::io::Write;
    use std::path::PathBuf;

    const LABEL: &str = "org.libreloom.LunaDesktop";

    fn plist_path() -> PathBuf {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
        PathBuf::from(home)
            .join("Library/LaunchAgents")
            .join(format!("{LABEL}.plist"))
    }

    fn launchctl(args: &[&str]) -> Option<std::process::Output> {
        let uid = std::process::Command::new("id").arg("-u").output().ok()?;
        let uid = String::from_utf8_lossy(&uid.stdout).trim().to_string();
        let domain = format!("gui/{uid}");
        let mut full = vec![args[0], domain.as_str()];
        full.extend_from_slice(&args[1..]);
        std::process::Command::new("launchctl")
            .args(&full)
            .output()
            .ok()
    }

    /// True when `launchctl disable` left an override for our label — the
    /// plist alone no longer means the agent will run.
    pub fn is_launchctl_disabled() -> bool {
        let Some(out) = launchctl(&["print-disabled"]) else {
            return false;
        };
        let text = String::from_utf8_lossy(&out.stdout);
        text.lines()
            .any(|l| l.contains(LABEL) && l.contains("disabled"))
    }

    pub fn is_enabled() -> bool {
        plist_path().is_file()
    }

    fn xml_escape(s: &str) -> String {
        s.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
    }

    pub fn set_enabled(enabled: bool) -> Result<(), String> {
        let path = plist_path();
        if !enabled {
            let _ = fs::remove_file(&path);
            // Stop it if loaded and record the override so macOS won't relaunch.
            let _ = launchctl(&["bootout", LABEL]);
            let _ = launchctl(&["disable", LABEL]);
            return Ok(());
        }
        // Clear any previous `launchctl disable` override.
        let _ = launchctl(&["enable", LABEL]);
        let dir = path.parent().unwrap().to_path_buf();
        fs::create_dir_all(&dir).map_err(|_| {
            "Couldn't create the start-on-sign-in folder on this computer.".to_string()
        })?;
        // Inside a .app bundle the exe is Contents/MacOS/luna-desktop; a bare
        // binary works too — LaunchAgent runs it directly, no shell quoting.
        let exec = xml_escape(&exec_path().trim_matches('"'));
        let body = format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
             <!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
             <plist version=\"1.0\">\n\
             <dict>\n\
             \t<key>Label</key>\n\
             \t<string>{LABEL}</string>\n\
             \t<key>ProgramArguments</key>\n\
             \t<array>\n\
             \t\t<string>{exec}</string>\n\
             \t\t<string>--background</string>\n\
             \t</array>\n\
             \t<key>RunAtLoad</key>\n\
             \t<true/>\n\
             \t<key>ProcessType</key>\n\
             \t<string>Interactive</string>\n\
             </dict>\n\
             </plist>\n"
        );
        let tmp = dir.join(format!("{LABEL}.plist.tmp"));
        {
            let mut opts = fs::OpenOptions::new();
            opts.write(true).create(true).truncate(true);
            {
                use std::os::unix::fs::OpenOptionsExt;
                opts.mode(0o644);
            }
            let mut file = opts
                .open(&tmp)
                .map_err(|_| "Couldn't write the start-on-sign-in setting.".to_string())?;
            file.write_all(body.as_bytes())
                .map_err(|_| "Couldn't write the start-on-sign-in setting.".to_string())?;
        }
        fs::rename(tmp, path)
            .map_err(|_| "Couldn't save the start-on-sign-in setting.".to_string())?;
        Ok(())
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
use unix_impl as platform_impl;

#[cfg(target_os = "macos")]
use macos_impl as platform_impl;

#[cfg(windows)]
use windows_impl as platform_impl;

#[cfg(all(unix, not(target_os = "macos")))]
pub use unix_impl::desktop_path;

pub fn is_enabled() -> bool {
    if is_explicitly_disabled() {
        return false;
    }
    platform_impl::is_enabled()
}

pub fn set_enabled(enabled: bool) -> Result<(), String> {
    if enabled {
        let marker = disabled_marker_path();
        let _ = std::fs::remove_file(&marker);
        platform_impl::set_enabled(true)?;
    } else {
        let dir = crate::session::data_dir();
        let _ = std::fs::create_dir_all(&dir);
        let marker = disabled_marker_path();
        let _ = std::fs::write(&marker, b"");
        platform_impl::set_enabled(false)?;
    }
    Ok(())
}

/// Ensure start on boot is enabled by default unless the user explicitly turned it off.
pub fn init_default() -> Result<(), String> {
    if is_explicitly_disabled() {
        return Ok(());
    }
    if !is_enabled() {
        set_enabled(true)?;
    }
    Ok(())
}

#[cfg(all(test, unix, not(target_os = "macos")))]
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
            std::env::set_var("LUNA_DESKTOP_DATA", dir.path());
        }
        assert!(!is_enabled());
        set_enabled(true).unwrap();
        assert!(is_enabled());
        let text = fs::read_to_string(
            PathBuf::from(dir.path()).join("autostart/org.libreloom.LunaDesktop.desktop"),
        )
        .unwrap();
        assert!(text.contains("Name=Luna Desktop"));
        assert!(text.contains("--background"));
        assert!(text.contains("X-GNOME-UsesNotifications=true"));
        set_enabled(false).unwrap();
        assert!(!is_enabled());
        unsafe {
            std::env::remove_var("XDG_CONFIG_HOME");
            std::env::remove_var("LUNA_DESKTOP_DATA");
        }
    }

    #[test]
    fn autostart_enabled_by_default_on_first_run() {
        let _g = crate::session::test_env::lock();
        let dir = tempfile::tempdir().unwrap();
        unsafe {
            std::env::set_var("XDG_CONFIG_HOME", dir.path());
            std::env::set_var("LUNA_DESKTOP_DATA", dir.path());
        }

        assert!(!is_enabled());
        assert!(!is_explicitly_disabled());

        // First run initialization enables autostart by default
        init_default().unwrap();
        assert!(is_enabled());
        assert!(unix_impl::desktop_path().is_file());

        unsafe {
            std::env::remove_var("XDG_CONFIG_HOME");
            std::env::remove_var("LUNA_DESKTOP_DATA");
        }
    }

    #[test]
    fn autostart_explicitly_disabled_persists_across_runs() {
        let _g = crate::session::test_env::lock();
        let dir = tempfile::tempdir().unwrap();
        unsafe {
            std::env::set_var("XDG_CONFIG_HOME", dir.path());
            std::env::set_var("LUNA_DESKTOP_DATA", dir.path());
        }

        // Initially enabled by default
        init_default().unwrap();
        assert!(is_enabled());

        // User explicitly disables start-on-boot
        set_enabled(false).unwrap();
        assert!(!is_enabled());
        assert!(is_explicitly_disabled());
        assert!(!unix_impl::desktop_path().is_file());

        // Subsequent app run must NOT re-enable autostart
        init_default().unwrap();
        assert!(!is_enabled());
        assert!(!unix_impl::desktop_path().is_file());

        // User turns it back on
        set_enabled(true).unwrap();
        assert!(is_enabled());
        assert!(!is_explicitly_disabled());
        assert!(unix_impl::desktop_path().is_file());

        unsafe {
            std::env::remove_var("XDG_CONFIG_HOME");
            std::env::remove_var("LUNA_DESKTOP_DATA");
        }
    }

    #[test]
    fn autostart_respects_desktop_file_hidden_or_disabled() {
        let _g = crate::session::test_env::lock();
        let dir = tempfile::tempdir().unwrap();
        unsafe {
            std::env::set_var("XDG_CONFIG_HOME", dir.path());
            std::env::set_var("LUNA_DESKTOP_DATA", dir.path());
        }

        init_default().unwrap();
        assert!(is_enabled());

        // Simulate desktop environment (like GNOME Tweaks) setting X-GNOME-Autostart-enabled=false
        let path = unix_impl::desktop_path();
        let content = fs::read_to_string(&path).unwrap();
        let disabled_content = content.replace(
            "X-GNOME-Autostart-enabled=true",
            "X-GNOME-Autostart-enabled=false",
        );
        fs::write(&path, disabled_content).unwrap();

        assert!(!is_enabled());
        assert!(is_explicitly_disabled());

        // init_default does not re-enable
        init_default().unwrap();
        assert!(!is_enabled());

        unsafe {
            std::env::remove_var("XDG_CONFIG_HOME");
            std::env::remove_var("LUNA_DESKTOP_DATA");
        }
    }
}

#[cfg(all(test, target_os = "macos"))]
mod macos_tests {
    use super::*;
    use std::fs;

    #[test]
    fn toggle_autostart_launchagent() {
        let _g = crate::session::test_env::lock();
        let dir = tempfile::tempdir().unwrap();
        let prev_home = std::env::var("HOME").ok();
        unsafe {
            std::env::set_var("HOME", dir.path());
            std::env::set_var("LUNA_DESKTOP_DATA", dir.path());
        }
        assert!(!is_enabled());
        set_enabled(true).unwrap();
        assert!(is_enabled());
        let text = fs::read_to_string(
            dir.path()
                .join("Library/LaunchAgents/org.libreloom.LunaDesktop.plist"),
        )
        .unwrap();
        assert!(text.contains("<string>org.libreloom.LunaDesktop</string>"));
        assert!(text.contains("--background"));
        assert!(text.contains("<key>RunAtLoad</key>"));
        set_enabled(false).unwrap();
        assert!(!is_enabled());
        unsafe {
            std::env::remove_var("LUNA_DESKTOP_DATA");
            match prev_home {
                Some(h) => std::env::set_var("HOME", h),
                None => std::env::remove_var("HOME"),
            }
        }
    }
}

//! HDMI / local-console help for Ethernet-only setup.
//!
//! Getty owns tty1; lunad writes the same help into `/var/lib/luna/issue`
//! so the login screen stays current (IP, cable, setup code).

use std::path::{Path, PathBuf};

pub const BANNER_TITLE: &str =
    "Luna is running. Open it from a phone or computer on your home internet.";

pub const ISSUE_FILE: &str = "issue";

#[derive(Debug, Clone, Default)]
pub struct ConsoleSnapshot {
    pub ipv4: Vec<String>,
    pub cable_in: bool,
    pub setup_code: Option<String>,
    pub connect_hostname: Option<String>,
    pub unclaimed: bool,
}

pub fn issue_path(data_dir: &Path) -> PathBuf {
    data_dir.join(ISSUE_FILE)
}

pub fn help_text(snap: &ConsoleSnapshot) -> String {
    help_lines(snap).join("\n")
}

pub fn help_lines(snap: &ConsoleSnapshot) -> Vec<String> {
    let mut lines = vec![
        String::new(),
        "============================================================".into(),
        format!("  {BANNER_TITLE}"),
        "============================================================".into(),
        String::new(),
    ];
    if snap.cable_in && snap.ipv4.is_empty() {
        lines.push("  Cable is in. Waiting for an address from your router or modem.".into());
        lines.push("  Keep the included RJ45 (ethernet) cable plugged into a LAN port.".into());
    } else if !snap.cable_in {
        lines.push("  Plug the included RJ45 (ethernet) cable from Luna".into());
        lines.push("  into a LAN port on your router or modem.".into());
    }
    if !snap.ipv4.is_empty() {
        lines.push("  On your phone or laptop (stay on home internet):".into());
        for ip in &snap.ipv4 {
            lines.push(format!("    http://{ip}"));
        }
        lines.push("    luna.local  — if your phone finds it".into());
    }
    if snap.unclaimed
        && let Some(code) = &snap.setup_code
    {
        lines.push(String::new());
        lines.push("  Device code (purchased from LibreLoom):".into());
        lines.push(format!("    {code}"));
        lines.push("  Type it at connect.luna.libreloom.org".into());
    }
    if let Some(host) = &snap.connect_hostname {
        lines.push(String::new());
        lines.push("  Away from home:".into());
        lines.push(format!("    https://{host}"));
    }
    lines.push(String::new());
    lines.push("  Local shell (keyboard + screen): login root, press Enter at password.".into());
    lines.push("  Forgot Luna web password? login pwreset, press Enter at password.".into());
    lines.push("============================================================".into());
    lines.push(String::new());
    lines
}

/// Write help text for getty (`getty -f /var/lib/luna/issue`).
pub fn write_issue(data_dir: &Path, snap: &ConsoleSnapshot) -> std::io::Result<()> {
    let path = issue_path(data_dir);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(path, help_text(snap))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn help_never_mentions_deleted_paths() {
        let text = help_text(&ConsoleSnapshot {
            ipv4: vec!["192.168.1.20".into()],
            cable_in: true,
            setup_code: Some("ABCD-EFGH".into()),
            connect_hostname: None,
            unclaimed: true,
        });
        assert!(text.contains("192.168.1.20"));
        assert!(text.contains("luna.local"));
        assert!(text.contains("ABCD-EFGH"));
        assert!(!text.contains("http://luna"));
        assert!(!text.contains("169.254.42.42"));
        assert!(!text.contains("Luna Setup"));
    }

    #[test]
    fn waiting_for_address_when_cable_has_no_lease() {
        let text = help_text(&ConsoleSnapshot {
            cable_in: true,
            ipv4: vec![],
            unclaimed: true,
            ..Default::default()
        });
        assert!(text.contains("Waiting for an address"));
        assert!(!text.contains("169.254"));
    }

    #[test]
    fn write_issue_creates_file_under_data_dir() {
        let dir = tempfile::tempdir().unwrap();
        let snap = ConsoleSnapshot {
            ipv4: vec!["10.0.0.5".into()],
            cable_in: true,
            ..Default::default()
        };
        write_issue(dir.path(), &snap).unwrap();
        let body = std::fs::read_to_string(issue_path(dir.path())).unwrap();
        assert!(body.contains("10.0.0.5"));
    }
}

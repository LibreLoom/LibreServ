//! HDMI / local-console status for Ethernet-only setup.
//!
//! `luna-console` owns tty1 (status screen + login). lunad writes the same
//! help into `{data_dir}/issue` so the screen stays live (network, storage,
//! drives, Connect / device token).

use std::path::{Path, PathBuf};

pub const BANNER_OK: &str =
    "Luna is running. Open it from a phone or computer on your home internet.";

pub const BANNER_PROBLEMS: &str = "Luna needs attention. Check the notes below.";

pub const ISSUE_FILE: &str = "issue";

/// How long after the last issue write before luna-console warns that lunad
/// may not be updating the screen.
pub const STALE_SECS: u64 = 90;

#[derive(Debug, Clone, Default)]
pub struct ConsoleSnapshot {
    pub ipv4: Vec<String>,
    pub cable_in: bool,
    pub has_default_route: bool,
    pub setup_code: Option<String>,
    pub connect_hostname: Option<String>,
    pub unclaimed: bool,
    /// User-facing problems, highest priority first. Empty means healthy.
    pub problems: Vec<String>,
}

pub fn issue_path(data_dir: &Path) -> PathBuf {
    data_dir.join(ISSUE_FILE)
}

pub fn help_text(snap: &ConsoleSnapshot) -> String {
    help_lines(snap).join("\n")
}

pub fn help_lines(snap: &ConsoleSnapshot) -> Vec<String> {
    let banner = if snap.problems.is_empty() {
        BANNER_OK
    } else {
        BANNER_PROBLEMS
    };
    let mut lines = vec![
        String::new(),
        "============================================================".into(),
        format!("  {banner}"),
        "============================================================".into(),
        String::new(),
    ];

    if !snap.problems.is_empty() {
        lines.push("  What's wrong:".into());
        for problem in &snap.problems {
            lines.extend(wrap_indent(problem, "  • ", 60));
        }
        lines.push(String::new());
    }

    // Network / how to open Luna — always useful, even alongside problems.
    if snap.cable_in && snap.ipv4.is_empty() {
        lines.push("  Cable is in. Waiting for an address from your router or modem.".into());
        lines.push("  Keep the included RJ45 (ethernet) cable plugged into a LAN port.".into());
    } else if !snap.cable_in {
        lines.push("  Plug the included RJ45 (ethernet) cable from Luna".into());
        lines.push("  into a LAN port on your router or modem.".into());
    }
    if !snap.ipv4.is_empty() {
        if snap.cable_in && !snap.has_default_route {
            lines.push("  This Luna has an address, but no path to the wider internet.".into());
            lines.push("  Check the router or modem, then wait a moment.".into());
        }
        lines.push("  On your phone or laptop (stay on home internet):".into());
        for ip in &snap.ipv4 {
            lines.push(format!("    http://{ip}"));
        }
        lines.push("    luna.local  — if your phone finds it".into());
    }

    let token_problem = snap.problems.iter().any(|p| {
        p.contains("device token") || p.contains("Device token") || p.contains("Settings → About")
    });

    if !token_problem
        && snap.unclaimed
        && let Some(code) = &snap.setup_code
    {
        lines.push(String::new());
        lines.push("  Device code (purchased from LibreLoom):".into());
        lines.push(format!("    {code}"));
        lines.push("  Type it at connect.luna.libreloom.org".into());
    }
    if !token_problem
        && let Some(host) = &snap.connect_hostname
    {
        lines.push(String::new());
        lines.push("  Away from home:".into());
        lines.push(format!("    https://{host}"));
    }

    lines.push(String::new());
    lines.push("  Most people use the web. Login below is only for recovery.".into());
    lines.push("  Local shell: type root, press Enter at password.".into());
    lines.push("  Forgot Luna web password? type pwreset, press Enter at password.".into());
    lines.push("============================================================".into());
    lines.push(String::new());
    lines
}

fn wrap_indent(text: &str, indent: &str, width: usize) -> Vec<String> {
    let max = width.saturating_sub(indent.len()).max(8);
    let cont = " ".repeat(indent.chars().count());
    let mut out = Vec::new();
    let mut line = String::new();
    let mut first = true;
    for word in text.split_whitespace() {
        if line.is_empty() {
            line.push_str(word);
            continue;
        }
        if line.len() + 1 + word.len() > max {
            let prefix = if first { indent } else { &cont };
            out.push(format!("{prefix}{line}"));
            first = false;
            line = word.to_string();
        } else {
            line.push(' ');
            line.push_str(word);
        }
    }
    if !line.is_empty() {
        let prefix = if first { indent } else { &cont };
        out.push(format!("{prefix}{line}"));
    }
    out
}

/// Write help text for luna-console (and any leftover getty -f consumers).
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
            has_default_route: true,
            setup_code: Some("ABCD-EFGH".into()),
            connect_hostname: None,
            unclaimed: true,
            problems: vec![],
        });
        assert!(text.contains("192.168.1.20"));
        assert!(text.contains("luna.local"));
        assert!(text.contains("ABCD-EFGH"));
        assert!(text.contains(BANNER_OK));
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
    fn problems_change_banner_and_list_first() {
        let text = help_text(&ConsoleSnapshot {
            ipv4: vec!["10.0.0.5".into()],
            cable_in: true,
            has_default_route: true,
            problems: vec![
                "System disk is almost full. Free some space, then wait.".into(),
                "Drive Photos cannot be written. Check the cable.".into(),
            ],
            ..Default::default()
        });
        assert!(text.contains(BANNER_PROBLEMS));
        assert!(text.contains("What's wrong:"));
        assert!(text.contains("almost full"));
        assert!(text.contains("Drive Photos"));
        let problem_at = text.find("What's wrong:").unwrap();
        let open_at = text.find("On your phone").unwrap();
        assert!(problem_at < open_at);
    }

    #[test]
    fn device_token_error_hides_device_code_and_remote() {
        let text = help_text(&ConsoleSnapshot {
            ipv4: vec!["192.168.1.20".into()],
            cable_in: true,
            has_default_route: true,
            setup_code: Some("ABCD-EFGH-JKMN-PQRS-TVWX".into()),
            connect_hostname: Some("photos.luna.servers.libreloom.org".into()),
            unclaimed: true,
            problems: vec![crate::connect::DEVICE_TOKEN_REJECTED_MSG.into()],
        });
        let flat: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
        assert!(
            flat.contains("did not accept this device token"),
            "flat={flat}"
        );
        assert!(
            flat.contains("Settings") && flat.contains("About") && flat.contains("Advanced"),
            "flat={flat}"
        );
        assert!(flat.contains("192.168.1.20"));
        assert!(
            !text.contains("ABCD-EFGH-JKMN-PQRS-TVWX"),
            "rejected token must not be shown as a working device code"
        );
        assert!(
            !text.contains("photos.luna.servers.libreloom.org"),
            "rejected token must not advertise remote access"
        );
    }

    #[test]
    fn no_default_route_called_out_when_address_exists() {
        let text = help_text(&ConsoleSnapshot {
            ipv4: vec!["192.168.1.20".into()],
            cable_in: true,
            has_default_route: false,
            problems: vec![
                "This Luna has a network address, but no path out to the internet.".into(),
            ],
            ..Default::default()
        });
        assert!(text.contains("no path to the wider internet") || text.contains("no path out"));
    }

    #[test]
    fn write_issue_creates_file_under_data_dir() {
        let dir = tempfile::tempdir().unwrap();
        let snap = ConsoleSnapshot {
            ipv4: vec!["10.0.0.5".into()],
            cable_in: true,
            has_default_route: true,
            ..Default::default()
        };
        write_issue(dir.path(), &snap).unwrap();
        let body = std::fs::read_to_string(issue_path(dir.path())).unwrap();
        assert!(body.contains("10.0.0.5"));
    }
}

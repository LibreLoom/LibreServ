//! HDMI / local-console status for Ethernet-only setup.
//!
//! `luna-console` owns tty1 (status screen + login). lunad writes the same
//! help into `{data_dir}/issue` so the screen stays live (network, storage,
//! drives, Connect / device token).

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

pub const BANNER_OK: &str =
    "Luna is running. Open it from a phone or computer on your home internet.";

pub const BANNER_PROBLEMS: &str = "Luna needs attention. Check the notes below.";

pub const ISSUE_FILE: &str = "issue";

/// How long after the last issue write before luna-console warns that lunad
/// may not be updating the screen.
///
/// lunad must rewrite (or touch) `{data_dir}/issue` on every console-help tick,
/// even when the text is unchanged, so this stays a true liveness check.
pub const STALE_SECS: u64 = 90;

pub const STALE_NOTE_LINE1: &str =
    "  Note: this status is not updating. Luna may still be starting,";
pub const STALE_NOTE_LINE2: &str =
    "  or the Luna service needs a moment. You can still log in below.";

/// True when an issue file exists but has not been rewritten recently.
///
/// Missing file is not stale — luna-console already shows a "starting" banner.
pub fn is_issue_stale(mtime: Option<SystemTime>) -> bool {
    let Some(mtime) = mtime else {
        return false;
    };
    match mtime.elapsed() {
        Ok(elapsed) => elapsed > Duration::from_secs(STALE_SECS),
        // Clock skew (mtime in the future): treat as fresh.
        Err(_) => false,
    }
}

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
    let token_problem = snap.problems.iter().any(|p| {
        p.contains("device token") || p.contains("Device token") || p.contains("Settings → About")
    });

    if !snap.ipv4.is_empty() && snap.cable_in && !snap.has_default_route {
        lines.push("  This Luna has an address, but no path to the wider internet.".into());
        lines.push("  Check the router or modem, then wait a moment.".into());
    }

    // How to open Luna: Everywhere (when remote is configured), then home LAN.
    let show_remote = !token_problem && snap.connect_hostname.is_some();
    let show_home = !snap.ipv4.is_empty() || show_remote;
    if show_remote && let Some(host) = &snap.connect_hostname {
        lines.push("  Everywhere:".into());
        lines.push(format!("    {host}"));
        lines.push(String::new());
    }
    if show_home {
        lines.push("  On your home internet only:".into());
        lines.push("    luna.local".into());
        for ip in &snap.ipv4 {
            lines.push(format!("    {ip}"));
        }
    }

    if !token_problem
        && snap.unclaimed
        && let Some(code) = &snap.setup_code
    {
        lines.push(String::new());
        lines.push("  Device code (purchased from LibreLoom):".into());
        lines.push(format!("    {code}"));
        lines.push("  Type it at connect.luna.libreloom.org".into());
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
                "Drive Photos cannot be written. Check the filesystem or the write-lock switch.".into(),
            ],
            ..Default::default()
        });
        assert!(text.contains(BANNER_PROBLEMS));
        assert!(text.contains("What's wrong:"));
        assert!(text.contains("almost full"));
        assert!(text.contains("Drive Photos"));
        let problem_at = text.find("What's wrong:").unwrap();
        let open_at = text.find("On your home internet only:").unwrap();
        assert!(problem_at < open_at);
    }

    #[test]
    fn remote_hostname_listed_under_everywhere() {
        let text = help_text(&ConsoleSnapshot {
            ipv4: vec!["192.168.1.20".into()],
            cable_in: true,
            has_default_route: true,
            connect_hostname: Some("photos.luna.servers.libreloom.org".into()),
            ..Default::default()
        });
        let everywhere_at = text.find("Everywhere:").unwrap();
        let home_at = text.find("On your home internet only:").unwrap();
        let host_at = text.find("photos.luna.servers.libreloom.org").unwrap();
        let local_at = text.find("luna.local").unwrap();
        assert!(everywhere_at < host_at);
        assert!(host_at < home_at);
        assert!(home_at < local_at);
        assert!(!text.contains("Away from home"));
        assert!(!text.contains("https://"));
        assert!(!text.contains("http://"));
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

    #[test]
    fn missing_issue_file_is_not_stale() {
        assert!(!is_issue_stale(None));
    }

    #[test]
    fn fresh_mtime_is_not_stale() {
        assert!(!is_issue_stale(Some(SystemTime::now())));
    }

    #[test]
    fn old_mtime_is_stale() {
        let old = SystemTime::now() - Duration::from_secs(STALE_SECS + 5);
        assert!(is_issue_stale(Some(old)));
    }

    #[test]
    fn write_issue_leaves_fresh_mtime() {
        let dir = tempfile::tempdir().unwrap();
        let snap = ConsoleSnapshot {
            ipv4: vec!["10.0.0.5".into()],
            cable_in: true,
            has_default_route: true,
            ..Default::default()
        };
        write_issue(dir.path(), &snap).unwrap();
        // Identical rewrite (heartbeat) must keep liveness fresh.
        write_issue(dir.path(), &snap).unwrap();
        let mtime = std::fs::metadata(issue_path(dir.path()))
            .unwrap()
            .modified()
            .unwrap();
        assert!(!is_issue_stale(Some(mtime)));
        assert!(mtime.elapsed().unwrap() < Duration::from_secs(5));
    }
}

//! HDMI / local-console help for Ethernet-only setup.

use std::io::Write;

pub const BANNER_TITLE: &str =
    "Luna is running. Open it from a phone or computer on your home Wi-Fi.";

#[derive(Debug, Clone, Default)]
pub struct ConsoleSnapshot {
    pub ipv4: Vec<String>,
    pub cable_in: bool,
    pub setup_code: Option<String>,
    pub connect_hostname: Option<String>,
    pub unclaimed: bool,
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
        lines.push("  Cable is in. Waiting for an address from your internet box.".into());
        lines.push("  Keep the included cable plugged into a LAN socket.".into());
    } else if !snap.cable_in {
        lines.push("  Plug the included cable from Luna into a LAN socket".into());
        lines.push("  on your internet box (the same kind of socket your".into());
        lines.push("  home internet uses).".into());
    }
    if !snap.ipv4.is_empty() {
        lines.push("  On your phone or laptop (stay on home Wi-Fi):".into());
        for ip in &snap.ipv4 {
            lines.push(format!("    http://{ip}"));
        }
        lines.push("    luna.local  — if your phone finds it".into());
    }
    if snap.unclaimed {
        if let Some(code) = &snap.setup_code {
            lines.push(String::new());
            lines.push("  Device code (same as the booklet):".into());
            lines.push(format!("    {code}"));
            lines.push("  Type it at connect.luna.libreloom.org".into());
        }
    }
    if let Some(host) = &snap.connect_hostname {
        lines.push(String::new());
        lines.push("  Away from home:".into());
        lines.push(format!("    https://{host}"));
    }
    lines.push("============================================================".into());
    lines.push(String::new());
    lines
}

pub fn print_snapshot(snap: &ConsoleSnapshot) {
    let text = help_text(snap);
    for path in ["/dev/tty1", "/dev/console", "/dev/tty"] {
        if let Ok(mut tty) = std::fs::OpenOptions::new().write(true).open(path) {
            let _ = tty.write_all(text.as_bytes());
            let _ = tty.flush();
            return;
        }
    }
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
}

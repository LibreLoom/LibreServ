//! Local-console setup help.
//!
//! After Luna is installed, the rapidinstall USB no longer shows how to reach
//! the box. On first boot we print the same discovery paths on the screen
//! plugged into Luna (TTY / console) until setup is finished.

use std::io::Write;

pub const SETUP_BANNER_TITLE: &str = "Luna is running. Finish setup from your phone or computer.";
pub const SETUP_PATHS: &[(&str, &str)] = &[
    ("http://luna.local", "same home Wi-Fi or cable to Luna"),
    ("http://luna", "through your internet box"),
    (
        "http://169.254.42.42",
        "cable straight from a computer, always works",
    ),
];
pub const SETUP_HOTSPOT_HINT: &str =
    "No Wi-Fi yet? Join the open network \"Luna Setup\" from your phone.";

pub fn setup_help_lines() -> Vec<String> {
    let mut lines = vec![
        String::new(),
        "============================================================".into(),
        format!("  {SETUP_BANNER_TITLE}"),
        "============================================================".into(),
        String::new(),
        "  On your phone or laptop:".into(),
    ];
    for (url, hint) in SETUP_PATHS {
        lines.push(format!("    {url}  — {hint}"));
    }
    lines.push(String::new());
    lines.push(format!("  {SETUP_HOTSPOT_HINT}"));
    lines.push("============================================================".into());
    lines.push(String::new());
    lines
}

pub fn setup_help_text() -> String {
    setup_help_lines().join("\n")
}

/// Print setup connection help on the local console when setup is not finished.
pub fn print_setup_connection_help() {
    let text = setup_help_text();
    for path in ["/dev/tty1", "/dev/console", "/dev/tty"] {
        if let Ok(mut tty) = std::fs::OpenOptions::new()
            .write(true)
            .open(path)
        {
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
    fn setup_help_mentions_all_discovery_paths() {
        let text = setup_help_text();
        assert!(text.contains("http://luna.local"));
        assert!(text.contains("http://luna"));
        assert!(text.contains("http://169.254.42.42"));
        assert!(text.contains("Luna Setup"));
    }
}

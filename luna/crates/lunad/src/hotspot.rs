//! Setup hotspot (AP mode): how a phone reaches Luna when there is no cable.
//!
//! When Luna boots with no network connection and setup isn't finished, it
//! briefly broadcasts an open network named "Luna Setup". Any phone can join,
//! open the setup wizard, connect Luna to Wi-Fi, and the hotspot disappears
//! as soon as a real connection exists or setup completes.

use std::path::{Path, PathBuf};

use serde::Serialize;

pub const SETUP_SSID: &str = "Luna Setup";
const HOTSPOT_IP: &str = "10.42.0.1/24";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct HotspotStatus {
    pub available: bool,
    pub running: bool,
    pub interface: Option<String>,
    pub ssid: String,
}

#[derive(Debug, thiserror::Error)]
pub enum HotspotError {
    #[error("This Luna's Wi-Fi adapter can't create a hotspot.")]
    Unavailable,
    #[error("{0}")]
    Io(#[source] std::io::Error),
    #[error("The hotspot tool failed: {0}")]
    Tool(String),
}

pub struct CommandHotspot {
    interface: String,
    run_dir: PathBuf,
}

impl CommandHotspot {
    pub fn new(interface: impl Into<String>, run_dir: &Path) -> Self {
        Self {
            interface: interface.into(),
            run_dir: run_dir.to_path_buf(),
        }
    }

    pub fn status(&self) -> HotspotStatus {
        HotspotStatus {
            available: true,
            running: self.pid_path().exists(),
            interface: Some(self.interface.clone()),
            ssid: SETUP_SSID.into(),
        }
    }

    /// Start an open WPA-less setup hotspot (temporary, no password so an
    /// iOS-only household can always get in). Idempotent.
    pub fn start(&self) -> Result<(), HotspotError> {
        if self.status().running {
            return Ok(());
        }
        std::fs::create_dir_all(&self.run_dir).map_err(HotspotError::Io)?;
        let conf = self.run_dir.join("luna-setup-hostapd.conf");
        std::fs::write(&conf, hostapd_config(&self.interface)).map_err(HotspotError::Io)?;

        let hostapd = std::process::Command::new("hostapd")
            .args([
                "-B",
                "-P",
                self.pid_path().to_str().unwrap_or(""),
                conf.to_str().unwrap_or(""),
            ])
            .output()
            .map_err(HotspotError::Io)?;
        if !hostapd.status.success() {
            return Err(HotspotError::Tool(
                String::from_utf8_lossy(&hostapd.stderr).trim().into(),
            ));
        }

        let _ = std::process::Command::new("ip")
            .args(["addr", "add", HOTSPOT_IP, "dev", &self.interface])
            .output();

        let dnsmasq = std::process::Command::new("dnsmasq")
            .args([
                "--no-resolv",
                "--no-poll",
                "--dhcp-range=10.42.0.50,10.42.0.150,12h",
                "--interface",
                &self.interface,
                "--except-interface=lo",
                "-k",
            ])
            .spawn()
            .map_err(HotspotError::Io)?;
        // Daemonize dnsmasq via double-fork is distro-specific; simplest is
        // background spawn. Track nothing: the hotspot stops when Luna stops.
        let _ = dnsmasq;
        Ok(())
    }

    pub fn stop(&self) -> Result<(), HotspotError> {
        let pid_path = self.pid_path();
        if let Ok(pid) = std::fs::read_to_string(&pid_path) {
            let _ = std::process::Command::new("kill").arg(pid.trim()).output();
            let _ = std::fs::remove_file(&pid_path);
        }
        let _ = std::process::Command::new("ip")
            .args(["addr", "del", HOTSPOT_IP, "dev", &self.interface])
            .output();
        Ok(())
    }

    fn pid_path(&self) -> PathBuf {
        self.run_dir.join("luna-setup-hostapd.pid")
    }
}

pub fn hostapd_config(interface: &str) -> String {
    format!(
        "interface={interface}\ndriver=nl80211\nssid={SETUP_SSID}\nhw_mode=g\nchannel=6\nwmm_enabled=1\n"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_is_open_and_named_luna_setup() {
        let cfg = hostapd_config("wlan0");
        assert!(cfg.contains("interface=wlan0"));
        assert!(cfg.contains("ssid=Luna Setup"));
        assert!(!cfg.contains("wpa_passphrase"), "setup hotspot is open");
    }
}

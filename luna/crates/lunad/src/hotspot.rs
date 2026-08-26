//! Setup AP is removed. Uplink is Ethernet only.

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct HotspotStatus {
    pub available: bool,
    pub running: bool,
    pub interface: Option<String>,
    pub ssid: String,
}

pub fn should_start_setup_hotspot(
    _setup_completed: bool,
    _ethernet_connected: bool,
    _wifi_connected: bool,
) -> bool {
    false
}

/// Kept so older call sites compile. Start always fails — there is no setup AP.
pub struct CommandHotspot;

impl CommandHotspot {
    pub fn new(_iface: impl Into<String>, _run_dir: &std::path::Path) -> Self {
        Self
    }
    pub fn start(&self) -> Result<(), String> {
        Err("Luna uses a cable. There is no setup Wi-Fi network.".into())
    }
    pub fn stop(&self) -> Result<(), String> {
        Ok(())
    }
    pub fn status(&self) -> HotspotStatus {
        HotspotStatus {
            available: false,
            running: false,
            interface: None,
            ssid: String::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn never_starts_a_setup_access_point() {
        assert!(!should_start_setup_hotspot(false, false, false));
        assert!(!should_start_setup_hotspot(true, false, false));
    }

    #[test]
    fn start_always_explains_cable_only() {
        let hs = CommandHotspot::new("wlan0", std::path::Path::new("/tmp"));
        let err = hs.start().unwrap_err();
        assert!(err.contains("cable"));
        assert!(!hs.status().available);
        assert!(!hs.status().running);
    }
}
